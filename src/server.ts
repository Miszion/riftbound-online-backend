import 'dotenv/config';
import express, { Express, Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import AWS from 'aws-sdk';
import { v4 as uuidv4 } from 'uuid';
import logger from './logger';

// Initialize AWS SDK
const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || 'us-east-1'
});

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

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Request logging
app.use((req: Request, _res: Response, next: NextFunction) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// Health check endpoint
app.get('/health', (_req: Request, res: Response): void => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Get user profile
app.get('/api/users/:userId', async (req: Request, res: Response): Promise<void> => {
  try {
    const { userId } = req.params;

    const result = await dynamodb.get({
      TableName: process.env.USERS_TABLE || 'riftbound-online-users-dev',
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
      TableName: process.env.USERS_TABLE || 'riftbound-online-users-dev',
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
      TableName: process.env.USERS_TABLE || 'riftbound-online-users-dev',
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
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});

export default app;
