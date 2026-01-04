import 'dotenv/config';
import express, { Express, Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import cors from 'cors';
import AWS from 'aws-sdk';
import { v4 as uuidv4 } from 'uuid';
import logger from './logger';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { typeDefs } from './graphql/schema';
import { queryResolvers, mutationResolvers, subscriptionResolvers } from './graphql/resolvers';
import { startMatchmakingQueueWorker } from './matchmaking-queue-worker';
import { decodeJwtPayload, requireAuthenticatedUser } from './auth-utils';
import { registerMatchRoutes } from './match-routes';

const awsRegion = process.env.AWS_REGION || 'us-east-1';
const environment = process.env.ENVIRONMENT || 'dev';

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
const normalizedStage = environment.replace(/^\//, '').replace(/\/$/, '');
const stagePrefix = normalizedStage ? `/${normalizedStage}` : '';
const PUBLIC_ROUTES = new Set(['/health', '/auth/sign-in', '/auth/sign-up', '/auth/refresh']);

const disableCors = process.env.DISABLE_CORS === 'true';

const allowedOrigins = (process.env.CORS_ORIGINS || '*')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

const allowedHeadersList = [
  'Content-Type',
  'Authorization',
  'x-id-token',
  'x-user-id',
  'x-requested-with'
];

const baseCorsOptions: cors.CorsOptions = {
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: allowedHeadersList,
  exposedHeaders: ['Content-Type'],
};

const corsOptions: cors.CorsOptions = {
  ...baseCorsOptions,
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
};

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
  authToken?: string | null;
}

const sanitizeEmail = (value: string): string => value.trim().toLowerCase();

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

const corsMiddleware = disableCors
  ? cors({ ...baseCorsOptions, origin: true })
  : cors(corsOptions);

if (disableCors) {
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Vary', 'Origin');
    }
    next();
  });
}

if (disableCors) {
  logger.warn('DISABLE_CORS flag detected; allowing all origins temporarily');
}

// Middleware
app.use(corsMiddleware);
app.options('*', corsMiddleware);

if (stagePrefix) {
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (req.url === stagePrefix || req.url.startsWith(`${stagePrefix}/`)) {
      const originalUrl = req.url;
      req.url = req.url.slice(stagePrefix.length) || '/';
      logger.info('[HTTP] Stage prefix rewritten', { from: originalUrl, to: req.url });
    }
    next();
  });
}

app.use((req: Request, res: Response, next: NextFunction) => {
  if (PUBLIC_ROUTES.has(req.path)) {
    return next();
  }
  return requireAuthenticatedUser(req, res, next);
});

app.use(express.json({ limit: '2mb' }));

// Detailed request logging
app.use((req: Request, res: Response, next: NextFunction) => {
  const { method, originalUrl, headers, query, ip } = req;
  const logContext: Record<string, any> = {
    method,
    path: originalUrl,
    origin: headers.origin,
    host: headers.host,
    referer: headers.referer,
    userAgent: headers['user-agent'],
    contentType: headers['content-type'],
    xUserId: headers['x-user-id'],
    stage: environment,
    ip,
    query,
  };
  if (method !== 'GET') {
    try {
      const bodyPreview =
        typeof req.body === 'string'
          ? req.body.slice(0, 1000)
          : JSON.stringify(req.body).slice(0, 1000);
      logContext.bodyPreview = bodyPreview;
    } catch {
      logContext.bodyPreview = '[unserializable body]';
    }
  }
    logger.info(`[HTTP] Incoming request ${method} ${originalUrl}`, logContext);
  res.on('finish', () => {
    logger.info('[HTTP] Response sent', {
      method,
      path: originalUrl,
      statusCode: res.statusCode,
      contentLength: res.getHeader('content-length'),
    });
  });
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
  
  // Apply middleware to /graphql endpoint (support both raw and stage-prefixed paths)
  const graphqlPaths = ['/graphql'];
  if (environment) {
    const envPath = `/${environment.replace(/^\//, '').trim()}/graphql`;
    if (!graphqlPaths.includes(envPath)) {
      graphqlPaths.push(envPath);
    }
  }

  graphqlPaths.forEach((path) => {
    const graphqlHandler = expressMiddleware(server, {
      context: async ({ req }) => ({
        userId: (req as AuthedRequest).userId,
        authToken: (req as AuthedRequest).authToken || null
      })
    });

    app.use(path, async (req: Request, res: Response, next: NextFunction) => {
      const body: any = req.body;
      const operationName = body?.operationName;
      const suppressLog = operationName === 'MatchmakingStatus';
      const requestLogger = suppressLog ? logger.debug.bind(logger) : logger.info.bind(logger);
      requestLogger('[GraphQL] Incoming operation', {
        path,
        operationName,
        hasBody: Boolean(body),
        userId: (req as AuthedRequest).userId,
        headers: {
          origin: req.headers.origin,
          host: req.headers.host,
          referer: req.headers.referer,
          'content-type': req.headers['content-type'],
          'x-user-id': req.headers['x-user-id'],
        },
      });

      res.on('finish', () => {
        const responseLogger = suppressLog ? logger.debug.bind(logger) : logger.info.bind(logger);
        responseLogger('[GraphQL] Response sent', {
          path,
          statusCode: res.statusCode,
          operationName,
        });
      });

      return graphqlHandler(req, res, next);
    });
  });

  const registeredPaths =
    app._router?.stack
      ?.map((layer: any) => (layer.route ? layer.route.path : null))
      ?.filter(Boolean) ?? [];
  logger.info(`GraphQL middleware mounted on: ${graphqlPaths.join(', ')}`, {
    registeredPaths,
  });
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

// Start server
const PORT = process.env.PORT || 3000;

async function runServer() {
  try {
    await startApolloServer();
    registerMatchRoutes(app);

    // 404 handler (registered after GraphQL middleware to avoid intercepting it)
    app.use((_req: Request, res: Response): void => {
      logger.warn('[HTTP] Unmatched route', {
        method: _req.method,
        path: _req.originalUrl,
        headers: {
          origin: _req.headers.origin,
          host: _req.headers.host,
          'content-type': _req.headers['content-type'],
          'x-user-id': _req.headers['x-user-id'],
        },
        body: _req.body,
      });
      res.status(404).json({ error: 'Not found', path: _req.originalUrl });
    });

    app.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
      logger.info(`GraphQL endpoint available at http://localhost:${PORT}/graphql`);
      startMatchmakingQueueWorker();
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

runServer();

export default app;
