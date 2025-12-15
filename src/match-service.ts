import 'dotenv/config';
import express, { Express, Request, Response, NextFunction } from 'express';
import AWS from 'aws-sdk';
import logger from './logger';
import { RiftboundGameEngine, Card } from './game-engine';
import { serializeGameState, serializePlayerState, buildOpponentView } from './game-state-serializer';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { WebSocketServer } from 'ws';
import { useServer } from 'graphql-ws/lib/use/ws';
import { typeDefs } from './graphql/schema';
import { queryResolvers, mutationResolvers, subscriptionResolvers } from './graphql/resolvers';
import cors from 'cors';

// ============================================================================
// CONFIGURATION
// ============================================================================

const PORT = process.env.PORT || 4000;
const MATCH_TABLE = process.env.MATCH_TABLE || 'riftbound-online-matches-dev';
const STATE_TABLE = process.env.STATE_TABLE || 'riftbound-online-match-states-dev';

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || 'us-east-1'
});

// ============================================================================
// IN-MEMORY GAME STATE (Per Task)
// ============================================================================

// Store game engines in memory for the duration of the container
// When match ends, save to DynamoDB and container gracefully shuts down
const activeGames = new Map<string, RiftboundGameEngine>();

// ============================================================================
// TYPES
// ============================================================================

interface MatchConfig {
  matchId: string;
  player1: string;
  player2: string;
  decks: {
    [playerId: string]: Card[];
  };
  createdAt: number;
}

interface AuthedRequest extends Request {
  userId?: string;
}

const requireUserHeader = (req: Request, res: Response, next: NextFunction) => {
  const userId = req.header('x-user-id');
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized: missing x-user-id header' });
    return;
  }
  (req as AuthedRequest).userId = userId;
  next();
};

// ============================================================================ 
// EXPRESS SERVER
// ============================================================================

const app: Express = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use((_req, _res, next) => {
  logger.info(`[MATCH-SERVICE] ${_req.method} ${_req.path}`);
  next();
});

// ============================================================================
// APOLLO SERVER SETUP
// ============================================================================

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
  return server;
}

// ============================================================================
// ENDPOINTS
// ============================================================================

/**
 * Health check - helps ECS determine if container is healthy
 */
app.get('/health', (_req: Request, res: Response): void => {
  const activeMatchCount = activeGames.size;
  res.status(200).json({
    status: 'healthy',
    activeMatches: activeMatchCount,
    timestamp: new Date().toISOString()
  });
});

/**
 * Initialize a new match
 * POST /matches/init
 * Body: { matchId, player1, player2, decks }
 */
app.post('/matches/init', async (req: Request, res: Response): Promise<void> => {
  try {
    const { matchId, player1, player2, decks }: MatchConfig = req.body;

    if (!matchId || !player1 || !player2 || !decks) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    if (activeGames.has(matchId)) {
      res.status(409).json({ error: 'Match already exists' });
      return;
    }

    // Create and initialize game engine
    const engine = new RiftboundGameEngine(matchId, [player1, player2]);
    engine.initializeGame(decks);

    activeGames.set(matchId, engine);

    // Save initial state to DynamoDB
    await saveGameState(matchId, engine);

    logger.info(`[MATCH] Initialized match ${matchId} between ${player1} and ${player2}`);

    res.status(201).json({
      matchId,
      status: 'initialized',
      players: [player1, player2],
      gameState: serializeGameState(engine.getGameState())
    });
  } catch (error) {
    logger.error('[MATCH-INIT] Error:', error);
    res.status(500).json({ error: 'Failed to initialize match' });
  }
});

/**
 * Get current game state
 * GET /matches/:matchId
 */
app.get('/matches/:matchId', (req: Request, res: Response): void => {
  try {
    const { matchId } = req.params;
    const engine = activeGames.get(matchId);

    if (!engine) {
      res.status(404).json({ error: 'Match not found' });
      return;
    }

    const gameState = serializeGameState(engine.getGameState());
    res.json(gameState);
  } catch (error) {
    logger.error('[MATCH-GET] Error:', error);
    res.status(500).json({ error: 'Failed to fetch match' });
  }
});

/**
 * Get specific player's view of the game
 * GET /matches/:matchId/player/:playerId
 */
app.get('/matches/:matchId/player/:playerId', (req: Request, res: Response): void => {
  try {
    const { matchId, playerId } = req.params;
    const engine = activeGames.get(matchId);

    if (!engine) {
      res.status(404).json({ error: 'Match not found' });
      return;
    }

    const playerState = engine.getPlayerState(playerId);
    if (!playerState) {
      res.status(404).json({ error: 'Player not found in match' });
      return;
    }

    const rawState = engine.getGameState();
    const currentPlayer = serializePlayerState(playerState, 'self');
    const opponentSummary = buildOpponentView(rawState, playerId);

    res.json({
      matchId,
      currentPlayer,
      opponent: opponentSummary,
      gameState: {
        matchId,
        currentPhase: rawState.currentPhase,
        turnNumber: rawState.turnNumber,
        currentPlayerIndex: rawState.currentPlayerIndex,
        canAct: engine.canPlayerAct(playerId)
      }
    });
  } catch (error) {
    logger.error('[MATCH-PLAYER-VIEW] Error:', error);
    res.status(500).json({ error: 'Failed to fetch player view' });
  }
});

/**
 * Play a card from hand
 * POST /matches/:matchId/actions/play-card
 * Body: { playerId, cardIndex, targets? }
 */
app.post('/matches/:matchId/actions/play-card', async (req: Request, res: Response): Promise<void> => {
  try {
    const { matchId } = req.params;
    const { playerId, cardIndex, targets } = req.body;

    const engine = activeGames.get(matchId);
    if (!engine) {
      res.status(404).json({ error: 'Match not found' });
      return;
    }

    if (!engine.canPlayerAct(playerId)) {
      res.status(403).json({ error: 'Not your turn' });
      return;
    }

    engine.playCard(playerId, cardIndex, targets);

    await saveGameState(matchId, engine);

    const rawState = engine.getGameState();
    const spectatorState = serializeGameState(rawState);

    logger.info(`[MATCH] Player ${playerId} played card in match ${matchId}`);

    res.json({
      success: true,
      gameState: spectatorState,
      currentPhase: spectatorState.currentPhase
    });
  } catch (error: any) {
    logger.error('[PLAY-CARD] Error:', error);
    res.status(400).json({ error: error.message || 'Failed to play card' });
  }
});

/**
 * Attack with a creature
 * POST /matches/:matchId/actions/attack
 * Body: { playerId, creatureInstanceId, defenderId? }
 */
app.post('/matches/:matchId/actions/attack', async (req: Request, res: Response): Promise<void> => {
  try {
    const { matchId } = req.params;
    const { playerId, creatureInstanceId, defenderId } = req.body;

    const engine = activeGames.get(matchId);
    if (!engine) {
      res.status(404).json({ error: 'Match not found' });
      return;
    }

    if (!engine.canPlayerAct(playerId)) {
      res.status(403).json({ error: 'Not your turn' });
      return;
    }

    engine.declareAttacker(playerId, creatureInstanceId, defenderId);

    await saveGameState(matchId, engine);

    const spectatorState = serializeGameState(engine.getGameState());

    logger.info(`[MATCH] Player ${playerId} declared attack in match ${matchId}`);

    res.json({
      success: true,
      gameState: spectatorState
    });
  } catch (error: any) {
    logger.error('[ATTACK] Error:', error);
    res.status(400).json({ error: error.message || 'Failed to attack' });
  }
});;

/**
 * End current phase and proceed to next
 * POST /matches/:matchId/actions/next-phase
 * Body: { playerId }
 */
app.post('/matches/:matchId/actions/next-phase', async (req: Request, res: Response): Promise<void> => {
  try {
    const { matchId } = req.params;
    const { playerId } = req.body;

    const engine = activeGames.get(matchId);
    if (!engine) {
      res.status(404).json({ error: 'Match not found' });
      return;
    }

    if (!engine.canPlayerAct(playerId)) {
      res.status(403).json({ error: 'Not your turn' });
      return;
    }

    engine.proceedToNextPhase();

    await saveGameState(matchId, engine);

    const spectatorState = serializeGameState(engine.getGameState());

    logger.info(`[MATCH] Player ${playerId} advanced phase in match ${matchId}`);

    res.json({
      success: true,
      currentPhase: spectatorState.currentPhase,
      gameState: spectatorState
    });
  } catch (error: any) {
    logger.error('[NEXT-PHASE] Error:', error);
    res.status(400).json({ error: error.message || 'Failed to advance phase' });
  }
});

/**
 * Report match result
 * POST /matches/:matchId/result
 * Body: { winner, reason }
 * This ends the match and the container gracefully shuts down
 */
app.post('/matches/:matchId/result', async (req: Request, res: Response): Promise<void> => {
  try {
    const { matchId } = req.params;
    const { winner, reason } = req.body;

    const engine = activeGames.get(matchId);
    if (!engine) {
      res.status(404).json({ error: 'Match not found' });
      return;
    }

    if (!winner) {
      res.status(400).json({ error: 'Winner must be specified' });
      return;
    }

    const rawState = engine.getGameState();
    const spectatorState = serializeGameState(rawState);

    // Get final game state
    const matchResult = engine.getMatchResult() || {
      matchId,
      winner,
      loser: rawState.players.find((p) => p.playerId !== winner)?.playerId,
      reason: reason || 'victory_points',
      duration: Date.now() - rawState.timestamp,
      turns: rawState.turnNumber,
      moves: rawState.moveHistory
    };

    // Save final state to DynamoDB
    await dynamodb
      .put({
        TableName: MATCH_TABLE,
        Item: {
          MatchId: matchId,
          Players: rawState.players.map((p) => p.playerId),
          Winner: matchResult.winner,
          Loser: matchResult.loser,
          Reason: matchResult.reason,
          Duration: matchResult.duration,
          Turns: matchResult.turns,
          MoveCount: matchResult.moves.length,
          Moves: matchResult.moves,
          FinalState: spectatorState,
          CreatedAt: Date.now(),
          Status: 'completed'
        }
      })
      .promise();

    // Remove from active games
    activeGames.delete(matchId);

    logger.info(`[MATCH-COMPLETE] Match ${matchId} completed. Winner: ${winner}`);

    res.json({
      success: true,
      matchResult
    });

    // Gracefully shutdown this container after response
    setTimeout(() => {
      logger.info('[SHUTDOWN] Match complete, shutting down container...');
      process.exit(0);
    }, 1000);
  } catch (error) {
    logger.error('[RESULT] Error:', error);
    res.status(500).json({ error: 'Failed to report match result' });
  }
});

/**
 * Concede match
 * POST /matches/:matchId/concede
 * Body: { playerId }
 */
app.post('/matches/:matchId/concede', async (req: Request, res: Response): Promise<void> => {
  try {
    const { matchId } = req.params;
    const { playerId } = req.body;

    const engine = activeGames.get(matchId);
    if (!engine) {
      res.status(404).json({ error: 'Match not found' });
      return;
    }

    const opponent = engine.getGameState().players.find((p) => p.playerId !== playerId);
    if (!opponent) {
      res.status(404).json({ error: 'Opponent not found' });
      return;
    }

    const rawState = engine.getGameState();
    const spectatorState = serializeGameState(rawState);

    const matchResult = engine.getMatchResult() || {
      matchId,
      winner: opponent.playerId,
      loser: playerId,
      reason: 'concede' as const,
      duration: Date.now() - rawState.timestamp,
      turns: rawState.turnNumber,
      moves: rawState.moveHistory
    };

    // Save to DynamoDB
    await dynamodb
      .put({
        TableName: MATCH_TABLE,
        Item: {
          MatchId: matchId,
          Players: rawState.players.map((p) => p.playerId),
          Winner: matchResult.winner,
          Loser: matchResult.loser,
          Reason: matchResult.reason,
          Duration: matchResult.duration,
          Turns: matchResult.turns,
          MoveCount: matchResult.moves.length,
          Moves: matchResult.moves,
          FinalState: spectatorState,
          CreatedAt: Date.now(),
          Status: 'completed'
        }
      })
      .promise();

    activeGames.delete(matchId);

    logger.info(`[MATCH-CONCEDE] Match ${matchId} ended. Winner: ${opponent.playerId}`);

    res.json({
      success: true,
      matchResult
    });

    setTimeout(() => {
      logger.info('[SHUTDOWN] Match conceded, shutting down container...');
      process.exit(0);
    }, 1000);
  } catch (error) {
    logger.error('[CONCEDE] Error:', error);
    res.status(500).json({ error: 'Failed to concede match' });
  }
});

/**
 * Get match history (moves only - for replay)
 * GET /matches/:matchId/history
 */
app.get('/matches/:matchId/history', (req: Request, res: Response): void => {
  try {
    const { matchId } = req.params;
    const engine = activeGames.get(matchId);

    if (!engine) {
      res.status(404).json({ error: 'Match not found' });
      return;
    }

    const gameState = engine.getGameState();
    res.json({
      matchId,
      moves: gameState.moveHistory,
      turnCount: gameState.turnNumber,
      status: gameState.status
    });
  } catch (error) {
    logger.error('[HISTORY] Error:', error);
    res.status(500).json({ error: 'Failed to fetch match history' });
  }
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

async function startServer() {
  try {
    const apolloServer = await startApolloServer();

    // Create HTTP server
    const server = app.listen(PORT, () => {
      logger.info(`[MATCH-SERVICE] Started on port ${PORT}`);
      logger.info(`[MATCH-SERVICE] GraphQL endpoint available at ws://localhost:${PORT}/graphql`);
      logger.info(`[MATCH-SERVICE] Ready to handle matches`);
    });

    // Create WebSocket server for subscriptions
    const wsServer = new WebSocketServer({ server, path: '/graphql' });

    const wsCleanup = useServer(
      {
        schema: require('./graphql/schema').typeDefs,
        roots: {
          Query: queryResolvers,
          Mutation: mutationResolvers,
          Subscription: subscriptionResolvers,
        } as any,
        onConnect: async (ctx) => {
          const userId = (ctx.connectionParams as Record<string, string> | undefined)?.['x-user-id'];
          if (!userId) {
            throw new Error('Unauthorized');
          }
          (ctx.extra as any).userId = userId;
        },
        context: (ctx) => ({
          userId: (ctx.extra as any).userId
        })
      },
      wsServer
    );

    const handleShutdown = (signal: NodeJS.Signals) => {
      logger.info(`[SHUTDOWN] ${signal} received, shutting down gracefully...`);
      Promise.allSettled([
        apolloServer.stop(),
        wsCleanup.dispose(),
      ]).finally(() => {
        wsServer.close();
        server.close(() => {
          logger.info('[SHUTDOWN] Server closed');
          process.exit(0);
        });
      });
    };

    process.on('SIGTERM', handleShutdown);
    process.on('SIGINT', handleShutdown);
  } catch (error) {
    logger.error('[STARTUP] Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Save game state snapshot to DynamoDB for persistence
 */
async function saveGameState(matchId: string, engine: RiftboundGameEngine): Promise<void> {
  try {
    const gameState = serializeGameState(engine.getGameState());
    await dynamodb
      .put({
        TableName: STATE_TABLE,
        Item: {
          MatchId: matchId,
          GameState: gameState,
          Timestamp: Date.now(),
          Status: gameState.status,
          TurnNumber: gameState.turnNumber,
          CurrentPhase: gameState.currentPhase
        }
      })
      .promise();
  } catch (error) {
    logger.error('[STATE-SAVE] Failed to save game state:', error);
    // Don't throw - game continues in memory even if state save fails
  }
}

export default app;
