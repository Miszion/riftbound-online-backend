import 'dotenv/config';
import express, { Express, Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import AWS from 'aws-sdk';
import { v4 as uuidv4 } from 'uuid';
import logger from './logger';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { typeDefs } from './graphql/schema';
import { queryResolvers, mutationResolvers, subscriptionResolvers } from './graphql/resolvers';

const awsRegion = process.env.AWS_REGION || 'us-east-1';

// Initialize AWS SDK clients
const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: awsRegion
});

const cognito = new AWS.CognitoIdentityServiceProvider({
  region: awsRegion
});

const USERS_TABLE = process.env.USERS_TABLE || 'riftbound-online-users-dev';
const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID;
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID;

const app: Express = express();

// Type definitions
interface UserProfile {
  UserId: string;
  Username?: string;
  Email?: string;
  UserLevel?: number;
  Wins?: number;
  TotalMatches?: number;
  LastLogin?: number;
  CreatedAt?: number;
}

interface UserUpdateRequest {
  username?: string;
  userLevel?: number;
  wins?: number;
  totalMatches?: number;
}

interface MatchRecord {
  MatchId: string;
  Timestamp: number;
  CreatedAt: number;
  UserId?: string;
  Players: string[];
  Winner: string;
  Duration: number;
}

interface MatchCreateRequest {
  players: string[];
  winner: string;
  duration: number;
}

interface LeaderboardUser extends UserProfile {
  Wins: number;
}

interface AuthedRequest extends Request {
  userId?: string;
}

const sanitizeEmail = (value: string): string => value.trim().toLowerCase();

const decodeJwtPayload = (token?: string): Record<string, any> | null => {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length < 2) {
      return null;
    }
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const json = Buffer.from(padded, 'base64').toString('utf-8');
    return JSON.parse(json);
  } catch (error) {
    logger.warn('Failed to decode JWT payload:', error);
    return null;
  }
};

const getCognitoConfig = () => {
  if (!COGNITO_USER_POOL_ID || !COGNITO_CLIENT_ID) {
    throw new Error('Cognito environment is not configured');
  }
  return {
    userPoolId: COGNITO_USER_POOL_ID,
    clientId: COGNITO_CLIENT_ID
  };
};

const computeExpiresAt = (expiresIn?: number | null): number => {
  const seconds = typeof expiresIn === 'number' && Number.isFinite(expiresIn) ? expiresIn : 3600;
  return Date.now() + seconds * 1000;
};

const upsertUserProfile = async (userId: string, email: string, username?: string) => {
  const now = Date.now();
  const updateExpressions = [
    '#Email = :email',
    '#LastLogin = :lastLogin',
    '#CreatedAt = if_not_exists(#CreatedAt, :createdAt)',
    '#Wins = if_not_exists(#Wins, :zero)',
    '#TotalMatches = if_not_exists(#TotalMatches, :zero)'
  ];
  const expressionAttributeNames: Record<string, string> = {
    '#Email': 'Email',
    '#LastLogin': 'LastLogin',
    '#CreatedAt': 'CreatedAt',
    '#Wins': 'Wins',
    '#TotalMatches': 'TotalMatches'
  };
  const expressionAttributeValues: Record<string, any> = {
    ':email': email,
    ':lastLogin': now,
    ':createdAt': now,
    ':zero': 0
  };

  if (username) {
    updateExpressions.push('#Username = if_not_exists(#Username, :username)');
    expressionAttributeNames['#Username'] = 'Username';
    expressionAttributeValues[':username'] = username;
  }

  await dynamodb
    .update({
      TableName: USERS_TABLE,
      Key: { UserId: userId },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues
    })
    .promise();
};

const mapCognitoError = (error: any): { statusCode: number; message: string } => {
  switch (error?.code) {
    case 'UserNotConfirmedException':
      return { statusCode: 403, message: 'User not confirmed' };
    case 'NotAuthorizedException':
      return { statusCode: 401, message: 'Invalid email or password' };
    case 'UserNotFoundException':
      return { statusCode: 404, message: 'User not found' };
    case 'UsernameExistsException':
      return { statusCode: 409, message: 'Email already registered' };
    case 'InvalidPasswordException':
      return { statusCode: 400, message: 'Password does not meet requirements' };
    case 'InvalidParameterException':
      return { statusCode: 400, message: 'Invalid parameters provided' };
    default:
      return { statusCode: 500, message: 'Internal server error' };
  }
};

const handleCognitoError = (res: Response, error: any) => {
  const { statusCode, message } = mapCognitoError(error);
  res.status(statusCode).json({
    error: message,
    code: error?.code
  });
};

const requireUserHeader = (req: Request, res: Response, next: NextFunction) => {
  const userId = req.header('x-user-id');
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized: missing x-user-id header' });
    return;
  }
  (req as AuthedRequest).userId = userId;
  next();
};

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Request logging
app.use((req: Request, _res: Response, next: NextFunction) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// Initialize Apollo Server for GraphQL
async function startApolloServer() {
  const server = new ApolloServer({
    typeDefs,
    resolvers: {
      Query: queryResolvers,
      Mutation: mutationResolvers,
      Subscription: subscriptionResolvers,
    },
  });

  await server.start();
  app.use(
    '/graphql',
    requireUserHeader,
    expressMiddleware(server, {
      context: async ({ req }) => ({
        userId: (req as AuthedRequest).userId
      })
    })
  );
}

// Health check endpoint
app.get('/health', (_req: Request, res: Response): void => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Authentication endpoints (migrated from Lambda)
app.post('/auth/sign-in', async (req: Request, res: Response) => {
  try {
    const { userPoolId, clientId } = getCognitoConfig();
    const { email, password } = req.body as { email?: string; password?: string };

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const normalizedEmail = sanitizeEmail(email);

    const params: AWS.CognitoIdentityServiceProvider.AdminInitiateAuthRequest = {
      AuthFlow: 'ADMIN_NO_SRP_AUTH',
      UserPoolId: userPoolId,
      ClientId: clientId,
      AuthParameters: {
        USERNAME: normalizedEmail,
        PASSWORD: password
      }
    };

    const response = await cognito.adminInitiateAuth(params).promise();

    if (!response.AuthenticationResult) {
      res.status(401).json({ error: 'Authentication failed' });
      return;
    }

    const { IdToken, AccessToken, RefreshToken, ExpiresIn } = response.AuthenticationResult;
    const payload = decodeJwtPayload(IdToken);
    const userId = (payload?.sub as string) || normalizedEmail;

    await upsertUserProfile(userId, normalizedEmail);

    res.json({
      userId,
      email: normalizedEmail,
      idToken: IdToken,
      accessToken: AccessToken,
      refreshToken: RefreshToken,
      expiresIn: ExpiresIn ?? 3600,
      expiresAt: computeExpiresAt(ExpiresIn)
    });
  } catch (error: any) {
    if (error.message === 'Cognito environment is not configured') {
      res.status(500).json({ error: error.message });
      return;
    }
    logger.error('Sign-in error:', error);
    handleCognitoError(res, error);
  }
});

app.post('/auth/sign-up', async (req: Request, res: Response) => {
  try {
    const { clientId, userPoolId } = getCognitoConfig();
    const { email, password, username } = req.body as { email?: string; password?: string; username?: string };

    if (!email || !password || !username) {
      res.status(400).json({ error: 'Email, password, and username are required' });
      return;
    }

    const normalizedEmail = sanitizeEmail(email);
    const normalizedUsername = username.trim();

    const signUpParams: AWS.CognitoIdentityServiceProvider.SignUpRequest = {
      ClientId: clientId,
      Username: normalizedEmail,
      Password: password,
      UserAttributes: [
        { Name: 'email', Value: normalizedEmail },
        { Name: 'email_verified', Value: 'false' },
        { Name: 'preferred_username', Value: normalizedUsername }
      ]
    };

    const signUpResponse = await cognito.signUp(signUpParams).promise();

    await cognito
      .adminConfirmSignUp({
        UserPoolId: userPoolId,
        Username: normalizedEmail
      })
      .promise();

    const userId = signUpResponse.UserSub || normalizedEmail;
    await upsertUserProfile(userId, normalizedEmail, normalizedUsername);

    res.status(201).json({
      message: 'User signed up successfully',
      userId,
      userConfirmed: true
    });
  } catch (error: any) {
    if (error.message === 'Cognito environment is not configured') {
      res.status(500).json({ error: error.message });
      return;
    }
    logger.error('Sign-up error:', error);
    handleCognitoError(res, error);
  }
});

app.post('/auth/refresh', async (req: Request, res: Response) => {
  try {
    const { clientId } = getCognitoConfig();
    const { refreshToken } = req.body as { refreshToken?: string };

    if (!refreshToken) {
      res.status(400).json({ error: 'Refresh token is required' });
      return;
    }

    const params: AWS.CognitoIdentityServiceProvider.InitiateAuthRequest = {
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: clientId,
      AuthParameters: {
        REFRESH_TOKEN: refreshToken
      }
    };

    const response = await cognito.initiateAuth(params).promise();

    if (!response.AuthenticationResult) {
      res.status(401).json({ error: 'Failed to refresh token' });
      return;
    }

    const { IdToken, AccessToken, ExpiresIn } = response.AuthenticationResult;
    const payload = decodeJwtPayload(IdToken);

    res.json({
      userId: payload?.sub ?? null,
      idToken: IdToken,
      accessToken: AccessToken,
      refreshToken,
      expiresIn: ExpiresIn ?? 3600,
      expiresAt: computeExpiresAt(ExpiresIn)
    });
  } catch (error: any) {
    if (error.message === 'Cognito environment is not configured') {
      res.status(500).json({ error: error.message });
      return;
    }
    logger.error('Refresh token error:', error);
    handleCognitoError(res, error);
  }
});

// Get user profile
app.get('/api/users/:userId', async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId } = req.params;

    const result = await dynamodb.get({
      TableName: USERS_TABLE,
      Key: { UserId: userId }
    }).promise();

    if (!result.Item) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json(result.Item as UserProfile);
  } catch (error) {
    logger.error('Error fetching user:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// Update user profile
app.put('/api/users/:userId', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const { username, userLevel, wins, totalMatches } = req.body as UserUpdateRequest;

    const updateExpressions: string[] = [];
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, any> = {};
    let index = 0;

    if (username) {
      updateExpressions.push(`#n = :${index}`);
      expressionAttributeNames['#n'] = 'Username';
      expressionAttributeValues[`:${index}`] = username;
      index++;
    }

    if (userLevel !== undefined) {
      updateExpressions.push(`#l = :${index}`);
      expressionAttributeNames['#l'] = 'UserLevel';
      expressionAttributeValues[`:${index}`] = userLevel;
      index++;
    }

    if (wins !== undefined) {
      updateExpressions.push(`#w = :${index}`);
      expressionAttributeNames['#w'] = 'Wins';
      expressionAttributeValues[`:${index}`] = wins;
      index++;
    }

    if (totalMatches !== undefined) {
      updateExpressions.push(`#tm = :${index}`);
      expressionAttributeNames['#tm'] = 'TotalMatches';
      expressionAttributeValues[`:${index}`] = totalMatches;
      index++;
    }

    updateExpressions.push(`#ll = :${index}`);
    expressionAttributeNames['#ll'] = 'LastLogin';
    expressionAttributeValues[`:${index}`] = Date.now();

    const result = await dynamodb.update({
      TableName: USERS_TABLE,
      Key: { UserId: userId },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    }).promise();

    res.json(result.Attributes as UserProfile);
  } catch (error) {
    logger.error('Error updating user:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Create match record
app.post('/api/matches', async (req: Request, res: Response) => {
  try {
    const { players, winner, duration } = req.body as MatchCreateRequest;

    const matchRecord: MatchRecord = {
      MatchId: uuidv4(),
      Timestamp: Date.now(),
      CreatedAt: Date.now(),
      Players: players,
      Winner: winner,
      Duration: duration
    };

    await dynamodb.put({
      TableName: process.env.MATCH_HISTORY_TABLE || 'riftbound-online-match-history-dev',
      Item: matchRecord
    }).promise();

    res.status(201).json(matchRecord);
  } catch (error) {
    logger.error('Error creating match record:', error);
    res.status(500).json({ error: 'Failed to create match record' });
  }
});

// Get user match history
app.get('/api/users/:userId/matches', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const { limit = '10' } = req.query;

    const result = await dynamodb.query({
      TableName: process.env.MATCH_HISTORY_TABLE || 'riftbound-online-match-history-dev',
      IndexName: 'UserIdIndex',
      KeyConditionExpression: 'UserId = :userId',
      ExpressionAttributeValues: {
        ':userId': userId
      },
      Limit: parseInt(limit as string),
      ScanIndexForward: false // Most recent first
    }).promise();

    res.json(result.Items as MatchRecord[]);
  } catch (error) {
    logger.error('Error fetching match history:', error);
    res.status(500).json({ error: 'Failed to fetch match history' });
  }
});

// Leaderboard endpoint
app.get('/api/leaderboard', async (req: Request, res: Response) => {
  try {
    const { limit = '100' } = req.query;

    const result = await dynamodb.scan({
      TableName: USERS_TABLE,
      Limit: parseInt(limit as string)
    }).promise();

    // Sort by wins
    const leaderboard = (result.Items as LeaderboardUser[])
      .sort((a, b) => (b.Wins || 0) - (a.Wins || 0))
      .slice(0, parseInt(limit as string));

    res.json(leaderboard);
  } catch (error) {
    logger.error('Error fetching leaderboard:', error);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// Error handling middleware
const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
};

app.use(errorHandler);

// 404 handler
app.use((_req: Request, res: Response): void => {
  res.status(404).json({ error: 'Not found' });
});

// Start server
const PORT = process.env.PORT || 3000;

async function runServer() {
  try {
    await startApolloServer();
    app.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
      logger.info(`GraphQL endpoint available at http://localhost:${PORT}/graphql`);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

runServer();

export default app;
