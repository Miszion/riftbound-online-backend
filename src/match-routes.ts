import 'dotenv/config';
import express, { type Express, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import AWS from 'aws-sdk';
import logger from './logger';
import {
  RiftboundGameEngine,
  GameState,
  GameStatus,
  CardType,
  PlayerState,
  BoardCard,
  MatchResult
} from './game-engine';
import { serializeGameState, serializePlayerState, buildOpponentView } from './game-state-serializer';
import { TABLE_NAMES } from './config/tableNames';

// ============================================================================
// CONFIGURATION
// ============================================================================

const MATCH_TABLE = TABLE_NAMES.MATCHES;
const MATCH_HISTORY_TABLE = TABLE_NAMES.MATCH_HISTORY;
const STATE_TABLE = TABLE_NAMES.MATCH_STATES;
const MATCHMAKING_QUEUE_TABLE = TABLE_NAMES.MATCHMAKING_QUEUE;
type MatchMode = 'ranked' | 'free';
const MATCHMAKING_MODES: MatchMode[] = ['ranked', 'free'];

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || 'us-east-1'
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const extractAccelerateMetadata = (
  card?: { metadata?: Record<string, unknown> | null }
): { energy: number; rune?: string | null } | null => {
  if (!card?.metadata || typeof card.metadata !== 'object') {
    return null;
  }
  const raw = card.metadata.accelerateCost as { energy?: number; rune?: string } | undefined;
  if (!raw) {
    return null;
  }
  const energy = Number(raw.energy ?? 0);
  if (!Number.isFinite(energy) || energy <= 0) {
    return null;
  }
  const rune = typeof raw.rune === 'string' ? raw.rune : null;
  return { energy: Math.round(energy), rune };
};

const recordMatchHistoryEntries = async (
  matchId: string,
  players: PlayerState[],
  matchResult: MatchResult
) => {
  try {
    const eligiblePlayers = players.filter(
      (player) => typeof player?.playerId === 'string' && player.playerId.trim().length > 0
    );
    if (!eligiblePlayers.length) {
      return;
    }
    const baseTimestamp = Date.now();
    const playerIds = eligiblePlayers.map((player) => player.playerId);
    const moveCount = Array.isArray(matchResult.moves)
      ? matchResult.moves.length
      : 0;
    type WriteRequest = AWS.DynamoDB.DocumentClient.WriteRequest;
    const requests: WriteRequest[] = eligiblePlayers.map(
      (player, index) => ({
        PutRequest: {
          Item: {
            MatchId: matchId,
            Timestamp: baseTimestamp + index,
            CreatedAt: baseTimestamp + index,
            UserId: player.playerId,
            Players: playerIds,
            Winner: matchResult.winner,
            Loser: matchResult.loser,
            OpponentId: playerIds.find((id) => id !== player.playerId) ?? null,
            Result: player.playerId === matchResult.winner ? 'win' : 'loss',
            Duration: matchResult.duration,
            Turns: matchResult.turns,
            MoveCount: moveCount,
            Reason: matchResult.reason,
            Status: 'completed'
          }
        }
      })
    );

    let pending: WriteRequest[] = requests.slice();
    while (pending.length) {
      const chunk = pending.slice(0, 25);
      pending = pending.slice(25);
      const response = await dynamodb
        .batchWrite({
          RequestItems: {
            [MATCH_HISTORY_TABLE]: chunk
          }
        })
        .promise();
      const unprocessed = (response.UnprocessedItems?.[MATCH_HISTORY_TABLE] ??
        []) as WriteRequest[];
      if (unprocessed.length) {
        pending = unprocessed.concat(pending);
        await sleep(50);
      }
    }
  } catch (error) {
    logger.error('[MATCH-HISTORY] Failed to cache match history entry', {
      error,
      matchId
    });
  }
};

const persistMatchFinalState = async (
  matchId: string,
  rawState: GameState,
  matchResult: MatchResult,
  reason: string
) => {
  const spectatorState = serializeGameState(rawState);
  
  // Always resolve participant IDs for queue cleanup
  const resolvedParticipants = resolveParticipantIds(rawState.players, matchResult);
  
  // Helper to ensure queue cleanup happens (with error handling to not fail the main operation)
  const ensureQueueCleanup = async () => {
    if (resolvedParticipants.length > 0) {
      try {
        logger.info('[MATCH-FINALIZED] Ensuring players removed from queues', {
          matchId,
          resolvedParticipants,
          reason
        });
        await removePlayersFromQueues(resolvedParticipants, reason);
      } catch (cleanupError) {
        logger.error('[MATCH-FINALIZED] Queue cleanup failed but continuing', {
          matchId,
          resolvedParticipants,
          reason,
          error: cleanupError
        });
      }
    }
  };
  
  if (rawState.outcomePersisted) {
    // Match already persisted by this engine instance, but still ensure queue cleanup
    await ensureQueueCleanup();
    return spectatorState;
  }

  // Check if match has already been persisted to avoid duplicate writes
  try {
    const existingMatch = await dynamodb
      .query({
        TableName: MATCH_TABLE,
        KeyConditionExpression: 'MatchId = :matchId',
        ExpressionAttributeValues: { ':matchId': matchId },
        ProjectionExpression: '#status',
        ExpressionAttributeNames: { '#status': 'Status' },
        Limit: 1
      })
      .promise();
    
    if (existingMatch.Items?.length && existingMatch.Items[0]?.Status === 'completed') {
      logger.info('[MATCH-FINALIZED] Match already persisted, skipping duplicate write', {
        matchId,
        reason
      });
      rawState.outcomePersisted = true;
      // Still ensure queue cleanup even if match was already persisted
      await ensureQueueCleanup();
      return spectatorState;
    }
  } catch (checkError) {
    logger.warn('[MATCH-FINALIZE] Failed to check existing match record, proceeding with write', {
      matchId,
      error: checkError
    });
  }

  const moveHistory = Array.isArray(matchResult.moves)
    ? matchResult.moves
    : rawState.moveHistory ?? [];
  const moveCount = moveHistory.length;
  const timestamp = Date.now();

  await dynamodb
    .put({
      TableName: MATCH_TABLE,
      Item: {
        MatchId: matchId,
        Timestamp: timestamp,
        Players: rawState.players.map((p) => p.playerId),
        Winner: matchResult.winner,
        Loser: matchResult.loser,
        Reason: matchResult.reason,
        Duration: matchResult.duration,
        Turns: matchResult.turns,
        MoveCount: moveCount,
        Moves: moveHistory,
        DuelLog: spectatorState.duelLog ?? [],
        ChatLog: spectatorState.chatLog ?? [],
        FinalState: spectatorState,
        CreatedAt: timestamp,
        Status: 'completed'
      }
    })
    .promise();

  await recordMatchHistoryEntries(matchId, rawState.players, {
    ...matchResult,
    moves: moveHistory
  });
  
  // Use the helper that was defined at the top of the function
  await ensureQueueCleanup();
  rawState.outcomePersisted = true;

  logger.info('[MATCH-FINALIZED]', {
    matchId,
    winner: matchResult.winner,
    loser: matchResult.loser,
    reason
  });

  return spectatorState;
};

const queueKey = (mode: MatchMode, userId: string) => ({
  Mode: mode,
  UserId: userId
});

const normalizePlayerId = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
};

const resolveParticipantIds = (players: PlayerState[], matchResult?: MatchResult) => {
  const ids = new Set<string>();
  players.forEach((player) => {
    const normalized = normalizePlayerId(player?.playerId);
    if (normalized) {
      ids.add(normalized);
    }
  });
  const register = (candidate?: string | null) => {
    const normalized = normalizePlayerId(candidate);
    if (normalized) {
      ids.add(normalized);
    }
  };
  if (matchResult) {
    register(matchResult.winner);
    register(matchResult.loser);
    if (Array.isArray(matchResult.players)) {
      matchResult.players.forEach((entry: any) => register(entry?.playerId ?? entry));
    }
  }
  return Array.from(ids.values());
};

const removePlayersFromQueues = async (playerIds: string[], reason: string) => {
  const uniqueIds = Array.from(
    new Set(playerIds.map((id) => normalizePlayerId(id)).filter((id): id is string => Boolean(id)))
  );
  
  logger.info('[MATCHMAKING] removePlayersFromQueues called', {
    inputPlayerIds: playerIds,
    normalizedUniqueIds: uniqueIds,
    reason,
    tableName: MATCHMAKING_QUEUE_TABLE,
    modes: MATCHMAKING_MODES
  });
  
  if (!uniqueIds.length) {
    logger.warn('[MATCHMAKING] No valid player IDs to remove from queue', {
      inputPlayerIds: playerIds,
      reason
    });
    return;
  }
  await Promise.all(
    MATCHMAKING_MODES.map(async (mode) => {
      await Promise.all(
        uniqueIds.map(async (playerId) => {
          const key = queueKey(mode, playerId);
          logger.info('[MATCHMAKING] Attempting to delete queue entry', {
            mode,
            playerId,
            key,
            tableName: MATCHMAKING_QUEUE_TABLE,
            reason
          });
          try {
            const result = await dynamodb
              .delete({
                TableName: MATCHMAKING_QUEUE_TABLE,
                Key: key,
                ReturnValues: 'ALL_OLD'
              })
              .promise();
            if (result.Attributes) {
              logger.info('[MATCHMAKING] Successfully removed player from queue after match resolution', {
                mode,
                playerId,
                reason,
                deletedAttributes: result.Attributes
              });
            } else {
              logger.info('[MATCHMAKING] No queue entry found to delete (may already be removed)', {
                mode,
                playerId,
                reason
              });
            }
          } catch (error) {
            logger.error('[MATCHMAKING] Failed to remove player from queue after match resolution', {
              mode,
              playerId,
              reason,
              error,
              tableName: MATCHMAKING_QUEUE_TABLE
            });
          }
        })
      );
    })
  );
};

const summarizeLocation = (location?: BoardCard['location']) => {
  if (!location) {
    return null;
  }
  if (location.zone === 'base') {
    return { zone: 'base', battlefieldId: null };
  }
  return { zone: 'battlefield', battlefieldId: location.battlefieldId ?? null };
};

const summarizeBoardCard = (card?: BoardCard | null) => {
  if (!card) {
    return null;
  }
  return {
    instanceId: card.instanceId,
    cardId: card.id,
    name: card.name,
    type: card.type,
    isTapped: card.isTapped,
    location: summarizeLocation(card.location)
  };
};

const summarizePlayerResources = (player: PlayerState) => ({
  energy: player.resources.energy,
  universalPower: player.resources.universalPower,
  power: { ...player.resources.power },
  runesTapped: player.channeledRunes.filter((rune) => rune.isTapped).length,
  totalRunes: player.channeledRunes.length
});

const summarizeCombatContext = (state: GameState) => {
  const context = state.combatContext;
  if (!context) {
    return null;
  }
  return {
    battlefieldId: context.battlefieldId,
    initiatedBy: context.initiatedBy,
    defendingPlayerId: context.defendingPlayerId ?? null,
    attackingUnitIds: context.attackingUnitIds ?? [],
    defendingUnitIds: context.defendingUnitIds ?? [],
    priorityStage: context.priorityStage
  };
};

const buildPlayerViewSnapshot = (
  engine: RiftboundGameEngine,
  snapshot: GameState,
  playerId: string
) => {
  const playerState = engine.getPlayerState(playerId);
  if (!playerState) {
    throw new Error(`Player ${playerId} not found in match ${snapshot.matchId}`);
  }
  return {
    matchId: snapshot.matchId,
    currentPlayer: serializePlayerState(playerState, 'self'),
    opponent: buildOpponentView(snapshot, playerId),
    gameState: {
      matchId: snapshot.matchId,
      currentPhase: snapshot.currentPhase,
      turnNumber: snapshot.turnNumber,
      currentPlayerIndex: snapshot.currentPlayerIndex,
      canAct: engine.canPlayerAct(playerId),
      turnSequenceStep: snapshot.turnSequenceStep ?? null,
      focusPlayerId: snapshot.focusPlayerId ?? null,
      combatContext: summarizeCombatContext(snapshot)
    }
  };
};

interface RequestContextMeta {
  requestId?: string;
  operation?: string;
}

const loadGameStateSnapshot = async (
  matchId: string,
  context?: RequestContextMeta
): Promise<GameState | null> => {
  const logMeta = {
    matchId,
    table: STATE_TABLE,
    requestId: context?.requestId ?? null,
    operation: context?.operation ?? null
  };
  try {
    const result = await dynamodb
      .get({
        TableName: STATE_TABLE,
        Key: { MatchId: matchId },
        ConsistentRead: true
      })
      .promise();
    const snapshot = (result.Item?.GameState as GameState) ?? null;
    if (!snapshot) {
      logger.debug('[STATE-LOAD] No snapshot record found', logMeta);
    } else {
      logger.info('[STATE-LOAD] Snapshot retrieved', {
        ...logMeta,
        turnNumber: snapshot.turnNumber,
        phase: snapshot.currentPhase,
        status: snapshot.status
      });
    }
    return snapshot;
  } catch (error) {
    logger.error('[STATE-LOAD] Failed to load game state', {
      ...logMeta,
      error
    });
    throw error;
  }
};

class MatchStateUnavailableError extends Error {
  constructor(matchId: string) {
    super(`Match ${matchId} is not available`);
    this.name = 'MatchStateUnavailableError';
  }
}

const loadSnapshotOrThrow = async (matchId: string, context?: RequestContextMeta): Promise<GameState> => {
  const snapshot = await loadGameStateSnapshot(matchId, context);
  if (!snapshot) {
    logger.warn('[MATCH-LOAD] No snapshot available for match', {
      matchId,
      requestId: context?.requestId ?? null,
      operation: context?.operation ?? null
    });
    throw new MatchStateUnavailableError(matchId);
  }
  return snapshot;
};

const loadEngineState = async (
  matchId: string,
  context?: RequestContextMeta
): Promise<{ engine: RiftboundGameEngine; snapshot: GameState }> => {
  logger.info('[MATCH-ENGINE] Loading state from snapshot', {
    matchId,
    requestId: context?.requestId ?? null,
    operation: context?.operation ?? null
  });
  const snapshot = await loadSnapshotOrThrow(matchId, context);
  const engine = RiftboundGameEngine.fromSerializedState(snapshot);
  logger.debug('[MATCH-ENGINE] Snapshot loaded', {
    matchId,
    turnNumber: snapshot.turnNumber,
    phase: snapshot.currentPhase,
    requestId: context?.requestId ?? null,
    operation: context?.operation ?? null
  });
  return { engine, snapshot };
};

// ============================================================================
// TYPES
// ============================================================================

interface MatchConfig {
  matchId: string;
  player1: string;
  player2: string;
  decks: Record<string, any>;
  playerProfiles?: Record<string, { username?: string | null }>;
  createdAt?: number;
}

interface AuthedRequest extends Request {
  userId?: string;
  requestId?: string;
}

const getOperationLabel = (req: Request) => `${req.method} ${req.route?.path ?? req.path}`;

const buildRequestContext = (req: Request): RequestContextMeta => ({
  requestId: (req as AuthedRequest).requestId,
  operation: getOperationLabel(req)
});

const respondWithStateUnavailable = (
  res: Response,
  error: MatchStateUnavailableError,
  meta: { matchId: string; action: string; requestId?: string; playerId?: string | null }
) => {
  logger.warn(`[${meta.action}] Match state unavailable`, {
    matchId: meta.matchId,
    playerId: meta.playerId ?? null,
    requestId: meta.requestId ?? null
  });
  res.status(404).json({ error: error.message });
};

const matchRouter = express.Router();

const serializeError = (error: unknown) => {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack
    };
  }
  return error;
};

matchRouter.use((req: Request, _res: Response, next: NextFunction) => {
  if (!(req as AuthedRequest).requestId) {
    (req as AuthedRequest).requestId = randomUUID();
  }
  next();
});

// ============================================================================
// ENDPOINTS
// ============================================================================

/**
 * Health check - helps ECS determine if container is healthy
 */
/**
 * Initialize a new match
 * POST /matches/init
 * Body: { matchId, player1, player2, decks }
 */
matchRouter.post('/matches/init', async (req: Request, res: Response): Promise<void> => {
  try {
    const { matchId, player1, player2, decks, playerProfiles }: MatchConfig = req.body;
    const context = buildRequestContext(req);
    const requestId = context.requestId;

    if (!matchId || !player1 || !player2 || !decks) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    const existingSnapshot = await loadGameStateSnapshot(matchId, context);
    if (existingSnapshot) {
      res.status(409).json({ error: 'Match already exists' });
      return;
    }

    const playerMetadata = [
      {
        playerId: player1,
        name: playerProfiles?.[player1]?.username ?? null
      },
      {
        playerId: player2,
        name: playerProfiles?.[player2]?.username ?? null
      }
    ];

    // Create and initialize game engine
    const engine = new RiftboundGameEngine(matchId, playerMetadata);
    try {
      engine.initializeGame(decks);
    } catch (error) {
      logger.error('[MATCH-INIT] Engine initialization failed', {
        matchId,
        player1,
        player2,
        error: serializeError(error),
        requestId
      });
      const message = error instanceof Error ? error.message : 'Invalid deck configuration';
      res.status(400).json({ error: message });
      return;
    }

    // Save initial state to DynamoDB
    await saveGameState(matchId, engine);

    logger.info('[MATCH] Initialized match', {
      matchId,
      player1,
      player2,
      requestId
    });

    res.status(201).json({
      matchId,
      status: 'initialized',
      players: [player1, player2],
      gameState: serializeGameState(engine.getGameState())
    });
  } catch (error) {
    logger.error('[MATCH-INIT] Error:', {
      matchId: req.body?.matchId ?? null,
      player1: req.body?.player1 ?? null,
      player2: req.body?.player2 ?? null,
      error: serializeError(error),
      requestId: (req as AuthedRequest).requestId ?? null
    });
    res.status(500).json({ error: 'Failed to initialize match' });
  }
});

/**
 * Get current game state
 * GET /matches/:matchId
 */
matchRouter.get('/matches/:matchId', async (req: Request, res: Response): Promise<void> => {
  const context = buildRequestContext(req);
  const operation = context.operation ?? getOperationLabel(req);
  try {
    const { matchId } = req.params;
    const snapshot = await loadSnapshotOrThrow(matchId, context);
    const gameState = serializeGameState(snapshot);
    res.json(gameState);
  } catch (error) {
    if (error instanceof MatchStateUnavailableError) {
      respondWithStateUnavailable(res, error, {
        action: operation,
        matchId: req.params.matchId,
        requestId: context.requestId
      });
      return;
    }
    res.status(500).json({ error: 'Failed to fetch match' });
  }
});

/**
 * Get specific player's view of the game
 * GET /matches/:matchId/player/:playerId
 */
matchRouter.get('/matches/:matchId/player/:playerId', async (req: Request, res: Response): Promise<void> => {
  const context = buildRequestContext(req);
  const operation = context.operation ?? getOperationLabel(req);
  try {
    const { matchId, playerId } = req.params;
    const { engine, snapshot } = await loadEngineState(matchId, context);

    const playerView = buildPlayerViewSnapshot(engine, snapshot, playerId);

    res.json(playerView);
  } catch (error) {
    if (error instanceof MatchStateUnavailableError) {
      respondWithStateUnavailable(res, error, {
        action: operation,
        matchId: req.params.matchId,
        playerId: req.params.playerId,
        requestId: context.requestId
      });
      return;
    }
    res.status(500).json({ error: 'Failed to fetch player view' });
  }
});

/**
 * Play a card from hand
 * POST /matches/:matchId/actions/play-card
 * Body: { playerId, cardIndex, targets? }
 */
matchRouter.post('/matches/:matchId/actions/play-card', async (req: Request, res: Response): Promise<void> => {
  const context = buildRequestContext(req);
  const operation = context.operation ?? getOperationLabel(req);
  try {
    const { matchId } = req.params;
    const { playerId, cardIndex, targets, destinationId, useAccelerate } = req.body;

    const { engine } = await loadEngineState(matchId, context);

    if (!engine.canPlayerAct(playerId)) {
      res.status(403).json({ error: 'Not your turn' });
      return;
    }

    const actingPlayer = engine.getPlayerState(playerId);
    const cardInHand = actingPlayer.hand?.[cardIndex];
    const boardCountsBefore = {
      creatures: actingPlayer.board.creatures.length,
      artifacts: actingPlayer.board.artifacts.length,
      enchantments: actingPlayer.board.enchantments.length
    };
    const tappedRunesBefore = actingPlayer.channeledRunes.filter((rune) => rune.isTapped).length;
    const channeledRunesBefore = actingPlayer.channeledRunes.length;

    engine.playCard(playerId, cardIndex, targets, destinationId, {
      useAccelerate: Boolean(useAccelerate)
    });

    await saveGameState(matchId, engine);

    const rawState = engine.getGameState();
    const spectatorState = serializeGameState(rawState);

    const updatedPlayer = engine.getPlayerState(playerId);
    const normalizedType = (cardInHand?.type ?? '').toLowerCase() as CardType | string;
    let deployedCard: BoardCard | null = null;
    switch (normalizedType) {
      case CardType.CREATURE:
        if (updatedPlayer.board.creatures.length > boardCountsBefore.creatures) {
          deployedCard = updatedPlayer.board.creatures[updatedPlayer.board.creatures.length - 1];
        }
        break;
      case CardType.ARTIFACT:
        if (updatedPlayer.board.artifacts.length > boardCountsBefore.artifacts) {
          deployedCard = updatedPlayer.board.artifacts[updatedPlayer.board.artifacts.length - 1];
        }
        break;
      case CardType.ENCHANTMENT:
        if (updatedPlayer.board.enchantments.length > boardCountsBefore.enchantments) {
          deployedCard = updatedPlayer.board.enchantments[updatedPlayer.board.enchantments.length - 1];
        }
        break;
      default:
        deployedCard = null;
        break;
    }
    const tappedRunesAfter = updatedPlayer.channeledRunes.filter((rune) => rune.isTapped).length;
    const channeledRunesAfter = updatedPlayer.channeledRunes.length;
    const powerSpent: Record<string, number> = { ...(cardInHand?.powerCost ?? {}) };
    const runePayment = {
      energySpent: cardInHand?.energyCost ?? cardInHand?.manaCost ?? 0,
      powerSpent,
      tappedRunes: Math.max(tappedRunesAfter - tappedRunesBefore, 0),
      recycledRunes: Math.max(channeledRunesBefore - channeledRunesAfter, 0)
    };
    if (useAccelerate) {
      const accelerateMeta = extractAccelerateMetadata(cardInHand);
      if (accelerateMeta) {
        runePayment.energySpent += accelerateMeta.energy;
        if (accelerateMeta.rune) {
          const domainKey = accelerateMeta.rune.toLowerCase();
          powerSpent[domainKey] = (powerSpent[domainKey] ?? 0) + 1;
        }
      }
    }
    const playerView = buildPlayerViewSnapshot(engine, rawState, playerId);
    const gameStateDetail = {
      phase: rawState.currentPhase,
      turnNumber: rawState.turnNumber,
      currentPlayerIndex: rawState.currentPlayerIndex,
      player: {
        playerId: updatedPlayer.playerId,
        handSize: updatedPlayer.hand.length,
        deckCount: updatedPlayer.deck.length,
        graveyardSize: updatedPlayer.graveyard.length,
        exileSize: updatedPlayer.exile.length,
        board: {
          creatures: updatedPlayer.board.creatures.map((card) => summarizeBoardCard(card)),
          artifacts: updatedPlayer.board.artifacts.map((card) => summarizeBoardCard(card)),
          enchantments: updatedPlayer.board.enchantments.map((card) => summarizeBoardCard(card))
        },
        resources: summarizePlayerResources(updatedPlayer),
        channeledRunes: updatedPlayer.channeledRunes.map((rune) => ({
          runeId: rune.id,
          name: rune.name,
          domain: rune.domain ?? null,
          energyValue: rune.energyValue ?? null,
          powerValue: rune.powerValue ?? null,
          isTapped: rune.isTapped ?? false
        })),
        runeDeckSize: updatedPlayer.runeDeck.length
      }
    };
    const deployedSummary = summarizeBoardCard(deployedCard ?? undefined);
    logger.info('[MATCH] Played card', {
      matchId,
      playerId,
      cardId: cardInHand?.id ?? (cardInHand as any)?.cardId ?? null,
      name: cardInHand?.name ?? 'Unknown card',
      type: normalizedType || cardInHand?.type || 'unknown',
      placement: deployedSummary,
      runesSpent: Math.max(tappedRunesAfter - tappedRunesBefore, 0) + runePayment.recycledRunes,
      playerResources: summarizePlayerResources(updatedPlayer),
      runePayment,
      gameStateDetail,
      requestId: context.requestId ?? null
    });

    logger.info(`[MATCH] Player ${playerId} played card in match ${matchId}`, {
      matchId,
      playerId,
      requestId: context.requestId ?? null
    });

    res.json({
      success: true,
      gameState: spectatorState,
      currentPhase: spectatorState.currentPhase,
      playerView,
      runePayment
    });
  } catch (error: any) {
    if (error instanceof MatchStateUnavailableError) {
      respondWithStateUnavailable(res, error, {
        action: operation,
        matchId: req.params.matchId,
        playerId: req.body?.playerId,
        requestId: context.requestId
      });
      return;
    }
    logger.error('[PLAY-CARD] Error:', {
      error,
      matchId: req.params.matchId,
      playerId: req.body?.playerId,
      requestId: context.requestId ?? null
    });
    res.status(400).json({ error: error.message || 'Failed to play card' });
  }
});

/**
 * Select a battlefield during setup
 * POST /matches/:matchId/actions/select-battlefield
 * Body: { playerId, battlefieldId }
 */
matchRouter.post('/matches/:matchId/actions/select-battlefield', async (req: Request, res: Response): Promise<void> => {
  const context = buildRequestContext(req);
  const operation = context.operation ?? getOperationLabel(req);
  try {
    const { matchId } = req.params;
    const { playerId, battlefieldId } = req.body;

    const { engine } = await loadEngineState(matchId, context);

    engine.selectBattlefield(playerId, battlefieldId);
    await saveGameState(matchId, engine);

    const spectatorState = serializeGameState(engine.getGameState());

    logger.info(
      `[MATCH] Player ${playerId} selected battlefield ${battlefieldId} for match ${matchId}`,
      {
        matchId,
        playerId,
        battlefieldId,
        requestId: context.requestId ?? null
      }
    );

    res.json({
      success: true,
      gameState: spectatorState
    });
  } catch (error: any) {
    if (error instanceof MatchStateUnavailableError) {
      respondWithStateUnavailable(res, error, {
        action: operation,
        matchId: req.params.matchId,
        playerId: req.body?.playerId,
        requestId: context.requestId
      });
      return;
    }
    logger.error('[BATTLEFIELD-SELECT] Error:', {
      error,
      matchId: req.params.matchId,
      playerId: req.body?.playerId,
      requestId: context.requestId ?? null
    });
    res.status(400).json({ error: error.message || 'Failed to select battlefield' });
  }
});

/**
 * Submit mulligan choices
 * POST /matches/:matchId/actions/mulligan
 * Body: { playerId, indices }
 */
matchRouter.post('/matches/:matchId/actions/mulligan', async (req: Request, res: Response): Promise<void> => {
  const context = buildRequestContext(req);
  const operation = context.operation ?? getOperationLabel(req);
  try {
    const { matchId } = req.params;
    const { playerId, indices } = req.body;

    const { engine } = await loadEngineState(matchId, context);

    engine.submitMulligan(playerId, Array.isArray(indices) ? indices : []);
    await saveGameState(matchId, engine);

    const spectatorState = serializeGameState(engine.getGameState());

    logger.info(`[MATCH] Player ${playerId} submitted mulligan for match ${matchId}`, {
      matchId,
      playerId,
      requestId: context.requestId ?? null
    });

    res.json({
      success: true,
      gameState: spectatorState
    });
  } catch (error: any) {
    if (error instanceof MatchStateUnavailableError) {
      respondWithStateUnavailable(res, error, {
        action: operation,
        matchId: req.params.matchId,
        playerId: req.body?.playerId,
        requestId: context.requestId
      });
      return;
    }
    logger.error('[MULLIGAN] Error:', {
      error,
      matchId: req.params.matchId,
      playerId: req.body?.playerId,
      requestId: context.requestId ?? null
    });
    res.status(400).json({ error: error.message || 'Failed to submit mulligan' });
  }
});

/**
 * Resolve discard selection prompts
 * POST /matches/:matchId/actions/discard
 * Body: { playerId, promptId, cardInstanceIds }
 */
matchRouter.post('/matches/:matchId/actions/discard', async (req: Request, res: Response): Promise<void> => {
  const context = buildRequestContext(req);
  const operation = context.operation ?? getOperationLabel(req);
  try {
    const { matchId } = req.params;
    const { playerId, promptId, cardInstanceIds } = req.body;

    const { engine } = await loadEngineState(matchId, context);

    engine.submitDiscardSelection(
      playerId,
      promptId,
      Array.isArray(cardInstanceIds) ? cardInstanceIds : []
    );
    await saveGameState(matchId, engine);

    const spectatorState = serializeGameState(engine.getGameState());

    logger.info(`[MATCH] Player ${playerId} resolved discard prompt ${promptId} for match ${matchId}`, {
      matchId,
      playerId,
      promptId,
      requestId: context.requestId ?? null
    });

    res.json({
      success: true,
      gameState: spectatorState
    });
  } catch (error: any) {
    if (error instanceof MatchStateUnavailableError) {
      respondWithStateUnavailable(res, error, {
        action: operation,
        matchId: req.params.matchId,
        playerId: req.body?.playerId,
        requestId: context.requestId
      });
      return;
    }
    logger.error('[DISCARD] Error:', {
      error,
      matchId: req.params.matchId,
      playerId: req.body?.playerId,
      requestId: context.requestId ?? null
    });
    res.status(400).json({ error: error.message || 'Failed to resolve discard selection' });
  }
});

/**
 * Resolve generic target selection prompts
 * POST /matches/:matchId/actions/target
 * Body: { playerId, promptId, selectionIds }
 */
matchRouter.post('/matches/:matchId/actions/target', async (req: Request, res: Response): Promise<void> => {
  const context = buildRequestContext(req);
  const operation = context.operation ?? getOperationLabel(req);
  try {
    const { matchId } = req.params;
    const { playerId, promptId, selectionIds } = req.body;

    const { engine } = await loadEngineState(matchId, context);

    engine.submitTargetSelection(
      playerId,
      promptId,
      Array.isArray(selectionIds) ? selectionIds : []
    );
    await saveGameState(matchId, engine);

    const spectatorState = serializeGameState(engine.getGameState());

    logger.info(`[MATCH] Player ${playerId} resolved target prompt ${promptId} for match ${matchId}`, {
      matchId,
      playerId,
      promptId,
      requestId: context.requestId ?? null
    });

    res.json({
      success: true,
      gameState: spectatorState
    });
  } catch (error: any) {
    if (error instanceof MatchStateUnavailableError) {
      respondWithStateUnavailable(res, error, {
        action: operation,
        matchId: req.params.matchId,
        playerId: req.body?.playerId,
        requestId: context.requestId
      });
      return;
    }
    logger.error('[TARGET] Error:', {
      error,
      matchId: req.params.matchId,
      playerId: req.body?.playerId,
      requestId: context.requestId ?? null
    });
    res.status(400).json({ error: error.message || 'Failed to resolve target selection' });
  }
});

const appendDuelLogHandler = async (req: Request, res: Response): Promise<void> => {
  const context = buildRequestContext(req);
  const operation = context.operation ?? getOperationLabel(req);
  try {
    const { matchId } = req.params;
    const { playerId, message, tone, entryId, actorName } = req.body ?? {};

    const { engine } = await loadEngineState(matchId, context);

    const entry = engine.addDuelLogEntry({
      id: typeof entryId === 'string' ? entryId : undefined,
      playerId: typeof playerId === 'string' ? playerId : null,
      actorName: typeof actorName === 'string' ? actorName : undefined,
      message,
      tone
    });

    await saveGameState(matchId, engine);
    const spectatorState = serializeGameState(engine.getGameState());

    logger.info(`[MATCH] Logged duel entry ${entry.id} for match ${matchId}`, {
      matchId,
      playerId,
      requestId: context.requestId ?? null
    });

    res.json({
      success: true,
      entry: {
        ...entry,
        timestamp: new Date(entry.timestamp).toISOString()
      },
      gameState: spectatorState
    });
  } catch (error: any) {
    if (error instanceof MatchStateUnavailableError) {
      respondWithStateUnavailable(res, error, {
        action: operation,
        matchId: req.params.matchId,
        playerId: req.body?.playerId,
        requestId: context.requestId
      });
      return;
    }
    logger.error('[DUEL-LOG] Error:', {
      error,
      matchId: req.params.matchId,
      playerId: req.body?.playerId,
      requestId: context.requestId ?? null
    });
    res.status(400).json({ error: error.message || 'Failed to record duel log entry' });
  }
};

const appendChatHandler = async (req: Request, res: Response): Promise<void> => {
  const context = buildRequestContext(req);
  const operation = context.operation ?? getOperationLabel(req);
  try {
    const { matchId } = req.params;
    const { playerId, message, playerName } = req.body ?? {};

    if (!playerId || typeof playerId !== 'string') {
      res.status(400).json({ error: 'Player ID is required' });
      return;
    }

    const { engine } = await loadEngineState(matchId, context);
    const chatEntry = engine.addChatMessage({
      playerId,
      playerName,
      message
    });

    await saveGameState(matchId, engine);
    const spectatorState = serializeGameState(engine.getGameState());

    logger.info(`[MATCH] Player ${playerId} sent chat message in match ${matchId}`, {
      matchId,
      playerId,
      requestId: context.requestId ?? null
    });

    res.json({
      success: true,
      message: {
        ...chatEntry,
        timestamp: new Date(chatEntry.timestamp).toISOString()
      },
      gameState: spectatorState
    });
  } catch (error: any) {
    if (error instanceof MatchStateUnavailableError) {
      respondWithStateUnavailable(res, error, {
        action: operation,
        matchId: req.params.matchId,
        playerId: req.body?.playerId,
        requestId: context.requestId
      });
      return;
    }
    logger.error('[CHAT] Error:', {
      error,
      matchId: req.params.matchId,
      playerId: req.body?.playerId,
      requestId: context.requestId ?? null
    });
    res.status(400).json({ error: error.message || 'Failed to send chat message' });
  }
};

matchRouter.post('/matches/:matchId/logs', appendDuelLogHandler);
matchRouter.post('/matches/:matchId/actions/duel-log', appendDuelLogHandler);

matchRouter.post('/matches/:matchId/chat', appendChatHandler);
matchRouter.post('/matches/:matchId/actions/chat', appendChatHandler);

/**
 * Submit initiative choice (coin flip)
 * POST /matches/:matchId/actions/initiative
 * Body: { playerId, choice }
 */
matchRouter.post('/matches/:matchId/actions/initiative', async (req: Request, res: Response): Promise<void> => {
  const context = buildRequestContext(req);
  const operation = context.operation ?? getOperationLabel(req);
  try {
    const { matchId } = req.params;
    const { playerId, choice } = req.body;

    const { engine } = await loadEngineState(matchId, context);

    engine.submitInitiativeChoice(playerId, Number(choice));
    await saveGameState(matchId, engine);

    const spectatorState = serializeGameState(engine.getGameState());

    logger.info(
      `[MATCH] Player ${playerId} submitted initiative choice ${choice} for match ${matchId}`,
      {
        matchId,
        playerId,
        choice,
        requestId: context.requestId ?? null
      }
    );

    res.json({
      success: true,
      gameState: spectatorState
    });
  } catch (error: any) {
    if (error instanceof MatchStateUnavailableError) {
      respondWithStateUnavailable(res, error, {
        action: operation,
        matchId: req.params.matchId,
        playerId: req.body?.playerId,
        requestId: context.requestId
      });
      return;
    }
    logger.error('[INITIATIVE] Error:', {
      error,
      matchId: req.params.matchId,
      playerId: req.body?.playerId,
      requestId: context.requestId ?? null
    });
    res.status(400).json({ error: error.message || 'Failed to submit initiative choice' });
  }
});

/**
 * Attack with a creature
 * POST /matches/:matchId/actions/attack
 * Body: { playerId, creatureInstanceId, destinationId }
 */
matchRouter.post('/matches/:matchId/actions/attack', async (req: Request, res: Response): Promise<void> => {
  const context = buildRequestContext(req);
  const operation = context.operation ?? getOperationLabel(req);
  try {
    const { matchId } = req.params;
    const { playerId, creatureInstanceId, destinationId } = req.body;

    const { engine } = await loadEngineState(matchId, context);

    if (!engine.canPlayerAct(playerId)) {
      res.status(403).json({ error: 'Not your turn' });
      return;
    }

    if (!destinationId) {
      res.status(400).json({ error: 'Destination required' });
      return;
    }
    if (destinationId === 'base') {
      res.status(400).json({ error: 'Use move endpoint to return to base' });
      return;
    }

    const playerState = engine.getPlayerState(playerId);
    const attackerBefore = playerState.board.creatures.find((card) => card.instanceId === creatureInstanceId);
    const locationBefore = attackerBefore ? summarizeLocation(attackerBefore.location) : null;

    engine.moveUnit(playerId, creatureInstanceId, destinationId);

    await saveGameState(matchId, engine);

    const spectatorState = serializeGameState(engine.getGameState());

    const attackerAfter = playerState.board.creatures.find((card) => card.instanceId === creatureInstanceId);
    const attackerSummary = summarizeBoardCard(attackerAfter ?? undefined);
    logger.info('[MATCH] Player declared attack', {
      matchId,
      playerId,
      creatureInstanceId,
      cardId: attackerBefore?.id ?? attackerAfter?.id ?? null,
      name: attackerBefore?.name ?? attackerAfter?.name ?? null,
      from: locationBefore,
      to: summarizeLocation(attackerAfter?.location),
      tappedAfter: attackerAfter?.isTapped ?? null,
      unit: attackerSummary,
      requestId: context.requestId ?? null
    });

    res.json({
      success: true,
      gameState: spectatorState
    });
  } catch (error: any) {
    if (error instanceof MatchStateUnavailableError) {
      respondWithStateUnavailable(res, error, {
        action: operation,
        matchId: req.params.matchId,
        playerId: req.body?.playerId,
        requestId: context.requestId
      });
      return;
    }
    logger.error('[ATTACK] Error:', {
      error,
      matchId: req.params.matchId,
      playerId: req.body?.playerId,
      requestId: context.requestId ?? null
    });
    res.status(400).json({ error: error.message || 'Failed to attack' });
  }
});

/**
 * Move a unit between locations
 * POST /matches/:matchId/actions/move
 * Body: { playerId, creatureInstanceId, destinationId }
 */
matchRouter.post('/matches/:matchId/actions/move', async (req: Request, res: Response): Promise<void> => {
  const context = buildRequestContext(req);
  const operation = context.operation ?? getOperationLabel(req);
  try {
    const { matchId } = req.params;
    const { playerId, creatureInstanceId, destinationId } = req.body;

    const { engine } = await loadEngineState(matchId, context);

    if (!engine.canPlayerAct(playerId)) {
      res.status(403).json({ error: 'Not your turn' });
      return;
    }

    const playerState = engine.getPlayerState(playerId);
    const unitBefore = playerState.board.creatures.find((card) => card.instanceId === creatureInstanceId);
    const locationBefore = unitBefore ? summarizeLocation(unitBefore.location) : null;
    const tappedBefore = unitBefore?.isTapped ?? null;

    engine.moveUnit(playerId, creatureInstanceId, destinationId);

    await saveGameState(matchId, engine);

    const spectatorState = serializeGameState(engine.getGameState());

    const updatedUnit = playerState.board.creatures.find((card) => card.instanceId === creatureInstanceId);
    const unitSummary = summarizeBoardCard(updatedUnit ?? undefined);
    logger.info('[MATCH] Player moved unit', {
      matchId,
      playerId,
      creatureInstanceId,
      cardId: unitBefore?.id ?? updatedUnit?.id ?? null,
      name: unitBefore?.name ?? updatedUnit?.name ?? null,
      from: locationBefore,
      to: updatedUnit ? summarizeLocation(updatedUnit.location) : destinationId ?? null,
      tappedBefore,
      tappedAfter: updatedUnit?.isTapped ?? null,
      unit: unitSummary,
      requestId: context.requestId ?? null
    });

    res.json({
      success: true,
      gameState: spectatorState
    });
  } catch (error: any) {
    if (error instanceof MatchStateUnavailableError) {
      respondWithStateUnavailable(res, error, {
        action: operation,
        matchId: req.params.matchId,
        playerId: req.body?.playerId,
        requestId: context.requestId
      });
      return;
    }
    logger.error('[MOVE] Error:', {
      error,
      matchId: req.params.matchId,
      playerId: req.body?.playerId,
      requestId: context.requestId ?? null
    });
    res.status(400).json({ error: error.message || 'Failed to move unit' });
  }
});

/**
 * Commence combat on a battlefield
 * POST /matches/:matchId/actions/commence-battle
 * Body: { playerId, battlefieldId }
 */
matchRouter.post('/matches/:matchId/actions/commence-battle', async (req: Request, res: Response): Promise<void> => {
  const context = buildRequestContext(req);
  const operation = context.operation ?? getOperationLabel(req);
  try {
    const { matchId } = req.params;
    const { playerId, battlefieldId } = req.body;

    const { engine } = await loadEngineState(matchId, context);

    if (!engine.canPlayerAct(playerId)) {
      res.status(403).json({ error: 'Not your turn' });
      return;
    }

    engine.commenceBattle(playerId, battlefieldId);

    await saveGameState(matchId, engine);

    const spectatorState = serializeGameState(engine.getGameState());

    logger.info('[MATCH] Player commenced battle', {
      matchId,
      playerId,
      battlefieldId,
      requestId: context.requestId ?? null
    });

    res.json({
      success: true,
      gameState: spectatorState
    });
  } catch (error: any) {
    if (error instanceof MatchStateUnavailableError) {
      respondWithStateUnavailable(res, error, {
        action: operation,
        matchId: req.params.matchId,
        playerId: req.body?.playerId,
        requestId: context.requestId
      });
      return;
    }
    logger.error('[COMMENCE-BATTLE] Error:', {
      error,
      matchId: req.params.matchId,
      playerId: req.body?.playerId,
      requestId: context.requestId ?? null
    });
    res.status(400).json({ error: error.message || 'Failed to commence battle' });
  }
});

/**
 * Activate champion legend/leader ability
 * POST /matches/:matchId/actions/activate-legend
 * Body: { playerId, target, destinationId }
 */
matchRouter.post('/matches/:matchId/actions/activate-legend', async (req: Request, res: Response): Promise<void> => {
  const context = buildRequestContext(req);
  const operation = context.operation ?? getOperationLabel(req);
  try {
    const { matchId } = req.params;
    const { playerId, target, destinationId } = req.body;

    if (!playerId) {
      res.status(400).json({ error: 'playerId is required' });
      return;
    }

    const { engine } = await loadEngineState(matchId, context);
    const normalizedTarget = target === 'leader' ? 'leader' : 'legend';

    engine.activateChampionAbility(playerId, normalizedTarget, destinationId ?? null);
    await saveGameState(matchId, engine);

    const spectatorState = serializeGameState(engine.getGameState());

    logger.info('[MATCH] Champion ability activated', {
      matchId,
      playerId,
      target: normalizedTarget,
      requestId: context.requestId ?? null
    });

    res.json({
      success: true,
      gameState: spectatorState,
      currentPhase: spectatorState.currentPhase
    });
  } catch (error: any) {
    if (error instanceof MatchStateUnavailableError) {
      respondWithStateUnavailable(res, error, {
        action: operation,
        matchId: req.params.matchId,
        playerId: req.body?.playerId,
        requestId: context.requestId
      });
      return;
    }
    logger.error('[ACTIVATE-LEGEND] Error:', {
      error,
      matchId: req.params.matchId,
      playerId: req.body?.playerId,
      requestId: context.requestId ?? null
    });
    res.status(400).json({ error: error.message || 'Failed to activate champion ability' });
  }
});

/**
 * Pass priority in the current window
 * POST /matches/:matchId/actions/pass-priority
 * Body: { playerId }
 */
matchRouter.post('/matches/:matchId/actions/pass-priority', async (req: Request, res: Response): Promise<void> => {
  const context = buildRequestContext(req);
  const operation = context.operation ?? getOperationLabel(req);
  try {
    const { matchId } = req.params;
    const { playerId } = req.body;

    if (!playerId) {
      res.status(400).json({ error: 'playerId is required' });
      return;
    }

    const { engine } = await loadEngineState(matchId, context);

    engine.passPriority(playerId);

    await saveGameState(matchId, engine);

    const spectatorState = serializeGameState(engine.getGameState());

    logger.info('[MATCH] Player passed priority', {
      matchId,
      playerId,
      requestId: context.requestId ?? null
    });

    res.json({
      success: true,
      gameState: spectatorState,
      currentPhase: spectatorState.currentPhase
    });
  } catch (error: any) {
    if (error instanceof MatchStateUnavailableError) {
      respondWithStateUnavailable(res, error, {
        action: operation,
        matchId: req.params.matchId,
        playerId: req.body?.playerId,
        requestId: context.requestId
      });
      return;
    }
    logger.error('[PASS-PRIORITY] Error:', {
      error,
      matchId: req.params.matchId,
      playerId: req.body?.playerId,
      requestId: context.requestId ?? null
    });
    res.status(400).json({ error: error.message || 'Failed to pass priority' });
  }
});

/**
 * Respond to a spell reaction prompt (pass or react)
 * POST /matches/:matchId/actions/respond-to-spell-reaction
 * Body: { playerId, pass }
 */
matchRouter.post('/matches/:matchId/actions/respond-to-spell-reaction', async (req: Request, res: Response): Promise<void> => {
  const context = buildRequestContext(req);
  const operation = context.operation ?? getOperationLabel(req);
  try {
    const { matchId } = req.params;
    const { playerId, pass } = req.body;

    if (!playerId) {
      res.status(400).json({ error: 'playerId is required' });
      return;
    }

    if (typeof pass !== 'boolean') {
      res.status(400).json({ error: 'pass (boolean) is required' });
      return;
    }

    const { engine } = await loadEngineState(matchId, context);

    engine.respondToSpellReaction(playerId, pass);

    await saveGameState(matchId, engine);

    const spectatorState = serializeGameState(engine.getGameState());

    logger.info('[MATCH] Player responded to spell reaction', {
      matchId,
      playerId,
      pass,
      requestId: context.requestId ?? null
    });

    res.json({
      success: true,
      gameState: spectatorState,
      currentPhase: spectatorState.currentPhase
    });
  } catch (error: any) {
    if (error instanceof MatchStateUnavailableError) {
      respondWithStateUnavailable(res, error, {
        action: operation,
        matchId: req.params.matchId,
        playerId: req.body?.playerId,
        requestId: context.requestId
      });
      return;
    }
    logger.error('[RESPOND-TO-SPELL-REACTION] Error:', {
      error,
      matchId: req.params.matchId,
      playerId: req.body?.playerId,
      requestId: context.requestId ?? null
    });
    res.status(400).json({ error: error.message || 'Failed to respond to spell reaction' });
  }
});

/**
 * Respond to a chain reaction prompt (pass or play a reaction)
 * POST /matches/:matchId/actions/respond-to-chain-reaction
 * Body: { playerId, pass }
 */
matchRouter.post('/matches/:matchId/actions/respond-to-chain-reaction', async (req: Request, res: Response): Promise<void> => {
  const context = buildRequestContext(req);
  const operation = context.operation ?? getOperationLabel(req);
  try {
    const { matchId } = req.params;
    const { playerId, pass } = req.body;

    if (!playerId) {
      res.status(400).json({ error: 'playerId is required' });
      return;
    }

    if (typeof pass !== 'boolean') {
      res.status(400).json({ error: 'pass (boolean) is required' });
      return;
    }

    const { engine } = await loadEngineState(matchId, context);

    engine.respondToChainReaction(playerId, pass);

    await saveGameState(matchId, engine);

    const spectatorState = serializeGameState(engine.getGameState());

    logger.info('[MATCH] Player responded to chain reaction', {
      matchId,
      playerId,
      pass,
      chainLength: spectatorState.reactionChain?.items?.length ?? 0,
      requestId: context.requestId ?? null
    });

    res.json({
      success: true,
      gameState: spectatorState,
      currentPhase: spectatorState.currentPhase
    });
  } catch (error: any) {
    if (error instanceof MatchStateUnavailableError) {
      respondWithStateUnavailable(res, error, {
        action: operation,
        matchId: req.params.matchId,
        playerId: req.body?.playerId,
        requestId: context.requestId
      });
      return;
    }
    logger.error('[RESPOND-TO-CHAIN-REACTION] Error:', {
      error,
      matchId: req.params.matchId,
      playerId: req.body?.playerId,
      requestId: context.requestId ?? null
    });
    res.status(400).json({ error: error.message || 'Failed to respond to chain reaction' });
  }
});

/**
 * End current phase and proceed to next
 * POST /matches/:matchId/actions/next-phase
 * Body: { playerId }
 */
matchRouter.post('/matches/:matchId/actions/next-phase', async (req: Request, res: Response): Promise<void> => {
  const context = buildRequestContext(req);
  const operation = context.operation ?? getOperationLabel(req);
  try {
    const { matchId } = req.params;
    const { playerId } = req.body;

    const { engine } = await loadEngineState(matchId, context);

    if (!engine.canPlayerAct(playerId)) {
      res.status(403).json({ error: 'Not your turn' });
      return;
    }

    engine.proceedToNextPhase();

    await saveGameState(matchId, engine);

    const spectatorState = serializeGameState(engine.getGameState());

    logger.info(`[MATCH] Player ${playerId} advanced phase in match ${matchId}`, {
      matchId,
      playerId,
      requestId: context.requestId ?? null
    });

    res.json({
      success: true,
      currentPhase: spectatorState.currentPhase,
      gameState: spectatorState
    });
  } catch (error: any) {
    if (error instanceof MatchStateUnavailableError) {
      respondWithStateUnavailable(res, error, {
        action: operation,
        matchId: req.params.matchId,
        playerId: req.body?.playerId,
        requestId: context.requestId
      });
      return;
    }
    logger.error('[NEXT-PHASE] Error:', {
      error,
      matchId: req.params.matchId,
      playerId: req.body?.playerId,
      requestId: context.requestId ?? null
    });
    res.status(400).json({ error: error.message || 'Failed to advance phase' });
  }
});

/**
 * Report match result
 * POST /matches/:matchId/result
 * Body: { winner, reason }
 * This ends the match and the container gracefully shuts down
 */
matchRouter.post('/matches/:matchId/result', async (req: Request, res: Response): Promise<void> => {
  const context = buildRequestContext(req);
  const operation = context.operation ?? getOperationLabel(req);
  try {
    const { matchId } = req.params;
    const { winner, reason } = req.body;

    const { engine } = await loadEngineState(matchId, context);

    if (!winner) {
      res.status(400).json({ error: 'Winner must be specified' });
      return;
    }

    const rawState = engine.getGameState();

    // Get final game state
    const fallbackLoser =
      rawState.players.find((p) => p.playerId !== winner)?.playerId ?? winner;
    const matchResult = engine.getMatchResult() || {
      matchId,
      winner,
      loser: fallbackLoser,
      reason: reason || 'victory_points',
      duration: Date.now() - rawState.timestamp,
      turns: rawState.turnNumber,
      moves: rawState.moveHistory
    };

    const spectatorState = await persistMatchFinalState(
      matchId,
      rawState,
      matchResult,
      'match_completed'
    );

    logger.info(`[MATCH-COMPLETE] Match ${matchId} completed. Winner: ${winner}`, {
      matchId,
      winner,
      requestId: context.requestId ?? null
    });

    res.json({
      success: true,
      matchResult,
      gameState: spectatorState
    });

  } catch (error: any) {
    if (error instanceof MatchStateUnavailableError) {
      respondWithStateUnavailable(res, error, {
        action: operation,
        matchId: req.params.matchId,
        requestId: context.requestId
      });
      return;
    }
    logger.error('[RESULT] Error:', {
      error,
      matchId: req.params.matchId,
      requestId: context.requestId ?? null
    });
    res.status(500).json({ error: 'Failed to report match result' });
  }
});

/**
 * Concede match
 * POST /matches/:matchId/concede
 * Body: { playerId }
 */
matchRouter.post('/matches/:matchId/concede', async (req: Request, res: Response): Promise<void> => {
  const context = buildRequestContext(req);
  const operation = context.operation ?? getOperationLabel(req);
  try {
    const { matchId } = req.params;
    const { playerId } = req.body;

    if (!playerId) {
      res.status(400).json({ error: 'playerId is required' });
      return;
    }

    const { engine } = await loadEngineState(matchId, context);
    const matchResult = engine.concedeMatch(playerId);
    await saveGameState(matchId, engine);

    const rawState = engine.getGameState();
    const spectatorState = await persistMatchFinalState(
      matchId,
      rawState,
      matchResult,
      'match_conceded'
    );

    logger.info(`[MATCH-CONCEDE] Match ${matchId} ended. Winner: ${matchResult.winner}`, {
      matchId,
      playerId,
      winner: matchResult.winner,
      requestId: context.requestId ?? null
    });

    res.json({
      success: true,
      matchResult,
      gameState: spectatorState
    });

  } catch (error: any) {
    if (error instanceof MatchStateUnavailableError) {
      respondWithStateUnavailable(res, error, {
        action: operation,
        matchId: req.params.matchId,
        playerId: req.body?.playerId,
        requestId: context.requestId
      });
      return;
    }
    
    // Log full error details for debugging
    logger.error('[CONCEDE] Error:', {
      error: {
        message: error?.message,
        name: error?.name,
        stack: error?.stack,
        code: error?.code
      },
      matchId: req.params.matchId,
      playerId: req.body?.playerId,
      requestId: context.requestId ?? null
    });
    
    // Return more specific error message
    const errorMessage = error?.message || 'Failed to concede match';
    res.status(500).json({ 
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? error?.stack : undefined
    });
  }
});

/**
 * Get match history (moves only - for replay)
 * GET /matches/:matchId/history
 */
matchRouter.get('/matches/:matchId/history', async (req: Request, res: Response): Promise<void> => {
  const context = buildRequestContext(req);
  const operation = context.operation ?? getOperationLabel(req);
  try {
    const { matchId } = req.params;
    const snapshot = await loadSnapshotOrThrow(matchId, context);

    res.json({
      matchId,
      moves: snapshot.moveHistory,
      turnCount: snapshot.turnNumber,
      status: snapshot.status
    });
  } catch (error) {
    if (error instanceof MatchStateUnavailableError) {
      respondWithStateUnavailable(res, error, {
        action: operation,
        matchId: req.params.matchId,
        requestId: context.requestId
      });
      return;
    }
    logger.error('[HISTORY] Error:', {
      error,
      matchId: req.params.matchId,
      requestId: context.requestId ?? null
    });
    res.status(500).json({ error: 'Failed to fetch match history' });
  }
});

// ============================================================================
// HELPERS
// ============================================================================

const writeSnapshot = async (matchId: string, gameState: GameState): Promise<void> => {
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
};

/**
 * Save game state snapshot to DynamoDB for persistence
 */
async function saveGameState(matchId: string, engine: RiftboundGameEngine): Promise<void> {
  try {
    const gameState = JSON.parse(JSON.stringify(engine.getGameState())) as GameState;
    if (gameState.status === GameStatus.WINNER_DETERMINED) {
      const matchResult = engine.getMatchResult();
      if (matchResult) {
        try {
          await persistMatchFinalState(matchId, gameState, matchResult, 'auto_finalize');
        } catch (persistError) {
          logger.error('[MATCH-AUTO-FINALIZE] Failed to persist match outcome', {
            error: persistError,
            matchId
          });
        }
      }
    }
    await writeSnapshot(matchId, gameState);
  } catch (error) {
    logger.error('[STATE-SAVE] Failed to save game state:', {
      error,
      matchId,
      table: STATE_TABLE
    });
    throw error;
  }
}

let routesRegistered = false;
export const registerMatchRoutes = (app: Express): void => {
  if (routesRegistered) {
    return;
  }
  routesRegistered = true;
  app.use(matchRouter);
};
