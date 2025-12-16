import AWS from 'aws-sdk';
import { v4 as uuidv4 } from 'uuid';
import logger from '../logger';
import {
  pubSub,
  SubscriptionEvents,
  publishGameStateChange,
  publishPlayerGameStateChange,
  publishMatchCompletion,
  publishLeaderboardUpdate,
  publishCardPlayed,
  publishAttackDeclared,
  publishPhaseChange,
} from './pubsub';
import { RiftboundGameEngine } from '../game-engine';
import {
  getCardCatalog,
  findCardById as findCatalogCardById,
  findCardBySlug as findCatalogCardBySlug,
  getImageManifest,
  buildActivationStateIndex,
} from '../card-catalog';
import { serializeGameState, serializePlayerState, buildOpponentView } from '../game-state-serializer';
import type { EnrichedCardRecord } from '../card-catalog';

// Initialize AWS SDK
const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || 'us-east-1'
});

// Store active games (in match-service context)
const activeGames = new Map<string, RiftboundGameEngine>();

interface LeaderboardEntry {
  userId: string;
  username?: string;
  wins: number;
  totalMatches: number;
  winRate: number;
}

interface PublishedCard {
  cardId: string;
  name: string;
  cost: number;
  power?: number;
  toughness?: number;
  type: string;
}

interface CardCatalogFilterInput {
  search?: string;
  type?: string;
  domain?: string;
  rarity?: string;
  limit?: number;
}

interface CardAssetInfoInput {
  remote?: string | null;
  localPath?: string | null;
}

interface CardSnapshotInput {
  cardId?: string;
  slug?: string;
  name?: string;
  type?: string;
  rarity?: string;
  colors?: string[];
  keywords?: string[];
  effect?: string;
  assets?: CardAssetInfoInput | null;
}

interface DeckCardInput {
  cardId?: string;
  slug?: string;
  quantity?: number;
  cardSnapshot?: CardSnapshotInput | null;
}

interface DecklistInput {
  deckId?: string;
  userId: string;
  name: string;
  description?: string;
  heroSlug?: string;
  format?: string;
  tags?: string[];
  isPublic?: boolean;
  isDefault?: boolean;
  cards: DeckCardInput[];
  runeDeck?: DeckCardInput[];
  battlefields?: DeckCardInput[];
  sideDeck?: DeckCardInput[];
  championLegend?: DeckCardInput | null;
  championLeader?: DeckCardInput | null;
}

type CardSnapshotRecord = {
  cardId?: string;
  slug?: string;
  name?: string;
  type?: string;
  rarity?: string;
  colors?: string[];
  keywords?: string[];
  effect?: string;
  assets?: {
    remote?: string | null;
    localPath: string;
  };
} | null;

type DeckCardRecord = {
  cardId?: string;
  slug?: string;
  quantity: number;
  cardSnapshot?: CardSnapshotRecord;
};

const decklistsTableName = process.env.DECKLISTS_TABLE || 'riftbound-online-decklists-dev';
const deckIdIndexName = 'DeckIdIndex';
const MIN_DECK_SIZE = 39;
const MAX_DECK_SIZE = 39;
const MAX_CARD_COPIES = 3;
const MAX_RUNE_COPIES = 12;
const MAX_RUNE_TOTAL = 12;
const MAX_SIDE_DECK_CARDS = 8;
const BATTLEFIELD_SLOTS = 3;
const matchTableName = process.env.MATCH_TABLE || 'riftbound-online-matches-dev';

type MatchMode = 'ranked' | 'free';
const MATCHMAKING_QUEUE_TABLE =
  process.env.MATCHMAKING_QUEUE_TABLE || 'riftbound-online-matchmaking-queue-dev';
const MATCHMAKING_MODES: MatchMode[] = ['ranked', 'free'];
const MATCHMAKING_STATE = {
  QUEUED: 'queued',
  MATCHED: 'matched'
} as const;

interface ResolverContext {
  userId?: string | null;
}

const requireUser = (context: ResolverContext, targetUserId?: string | null): string => {
  const authed = context?.userId;
  if (!authed) {
    throw new Error('Unauthorized');
  }
  if (targetUserId && targetUserId !== authed) {
    throw new Error('Forbidden');
  }
  return authed;
};

const toIsoString = (value?: number | null): string | null => {
  if (!value) return null;
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
};

const sanitizeCardSnapshot = (snapshot?: CardSnapshotInput | null): CardSnapshotRecord => {
  if (!snapshot) {
    return null;
  }
  const colors = Array.isArray(snapshot.colors) ? snapshot.colors.filter(Boolean) : undefined;
  const keywords = Array.isArray(snapshot.keywords) ? snapshot.keywords.filter(Boolean) : undefined;
  const assets = snapshot.assets
    ? {
        remote: snapshot.assets.remote ?? null,
        localPath: snapshot.assets.localPath ?? ''
      }
    : undefined;
  const hasData =
    snapshot.cardId ||
    snapshot.slug ||
    snapshot.name ||
    snapshot.type ||
    snapshot.rarity ||
    (colors && colors.length) ||
    (keywords && keywords.length) ||
    snapshot.effect ||
    assets;
  if (!hasData) {
    return null;
  }
  return {
    cardId: snapshot.cardId || undefined,
    slug: snapshot.slug ? snapshot.slug.toLowerCase() : undefined,
    name: snapshot.name || undefined,
    type: snapshot.type || undefined,
    rarity: snapshot.rarity || undefined,
    colors,
    keywords,
    effect: snapshot.effect || undefined,
    assets
  };
};

const mergeDeckCardEntries = (entries: DeckCardRecord[]): DeckCardRecord[] => {
  const merged = new Map<string, DeckCardRecord>();
  for (const entry of entries) {
    const key = (entry.slug || entry.cardId || '').toLowerCase();
    if (!key) continue;
    const existing = merged.get(key);
    if (existing) {
      existing.quantity = Math.min(MAX_CARD_COPIES, existing.quantity + entry.quantity);
      if (!existing.cardSnapshot && entry.cardSnapshot) {
        existing.cardSnapshot = entry.cardSnapshot;
      }
    } else {
      merged.set(key, { ...entry });
    }
  }
  return Array.from(merged.values());
};

const sanitizeDeckCards = (cards?: DeckCardInput[], maxCopies = MAX_CARD_COPIES): DeckCardRecord[] => {
  if (!cards || cards.length === 0) {
    return [];
  }
  const normalized = cards
    .map((card) => ({
      cardId: card.cardId || undefined,
      slug: card.slug ? card.slug.toLowerCase() : undefined,
      quantity: Math.min(maxCopies, Math.max(1, card.quantity ?? 1)),
      cardSnapshot: sanitizeCardSnapshot(card.cardSnapshot)
    }))
    .filter((card) => (card.cardId || card.slug) && card.quantity > 0);

  return mergeDeckCardEntries(normalized);
};

const sanitizeSingleDeckCard = (card?: DeckCardInput | null): DeckCardRecord | null => {
  if (!card) {
    return null;
  }
  const [sanitized] = sanitizeDeckCards([card], 1);
  if (!sanitized) {
    return null;
  }
  return {
    ...sanitized,
    quantity: 1,
    cardSnapshot: sanitized.cardSnapshot
  };
};

const mapDecklistItem = (
  item?: AWS.DynamoDB.DocumentClient.AttributeMap | null
): Record<string, any> | null => {
  if (!item) {
    return null;
  }
  return {
    deckId: item.DeckId,
    userId: item.UserId,
    name: item.Name,
    description: item.Description,
    heroSlug: item.HeroSlug,
    format: item.Format,
    tags: item.Tags || [],
    isPublic: Boolean(item.IsPublic),
    isDefault: Boolean(item.IsDefault),
    cardCount: item.CardCount ?? 0,
    cards: item.Cards || [],
    runeDeck: item.RuneDeck || [],
    battlefields: item.Battlefields || [],
    sideDeck: item.SideDeck || [],
    championLegend: item.ChampionLegend || null,
    championLeader: item.ChampionLeader || null,
    createdAt: toIsoString(item.CreatedAt),
    updatedAt: toIsoString(item.UpdatedAt)
  };
};

const normalizeMatchMode = (mode?: string): MatchMode => {
  const normalized = (mode || '').toLowerCase();
  if (!MATCHMAKING_MODES.includes(normalized as MatchMode)) {
    throw new Error('Invalid matchmaking mode');
  }
  return normalized as MatchMode;
};

const defaultMmr = 1200;

const getUserMmr = async (userId: string): Promise<number> => {
  try {
    const result = await dynamodb
      .get({
        TableName: process.env.USERS_TABLE || 'riftbound-online-users-dev',
        Key: { UserId: userId },
        ProjectionExpression: 'MatchmakingRating, Wins, TotalMatches'
      })
      .promise();

    if (result.Item && typeof result.Item.MatchmakingRating === 'number') {
      return result.Item.MatchmakingRating;
    }

    const wins = Number(result.Item?.Wins ?? 0);
    const totalMatches = Number(result.Item?.TotalMatches ?? 0);
    if (!totalMatches) return defaultMmr;
    const winRate = wins / totalMatches;
    return Math.round(defaultMmr + (winRate - 0.5) * 400);
  } catch {
    return defaultMmr;
  }
};

const queueKey = (mode: MatchMode, userId: string) => ({
  Mode: mode,
  UserId: userId
});

const queueTtlSeconds = () => Math.floor((Date.now() + 15 * 60 * 1000) / 1000);

const listQueuedEntries = async (mode: MatchMode) => {
  const result = await dynamodb
    .query({
      TableName: MATCHMAKING_QUEUE_TABLE,
      KeyConditionExpression: 'Mode = :mode',
      ExpressionAttributeValues: {
        ':mode': mode,
        ':queued': MATCHMAKING_STATE.QUEUED
      },
      ExpressionAttributeNames: {
        '#state': 'State'
      },
      FilterExpression: '#state = :queued'
    })
    .promise();
  return (result.Items || []).map((item) => ({
    userId: item.UserId as string,
    deckId: item.DeckId ?? null,
    mmr: Number(item.MMR ?? defaultMmr),
    queuedAt: Number(item.QueuedAt ?? Date.now()),
    state: item.State as string
  }));
};

const getQueueEntry = async (mode: MatchMode, userId: string) => {
  const result = await dynamodb
    .get({
      TableName: MATCHMAKING_QUEUE_TABLE,
      Key: queueKey(mode, userId)
    })
    .promise();
  return result.Item ?? null;
};

const getQueueLength = async (mode: MatchMode): Promise<number> => {
  const result = await dynamodb
    .query({
      TableName: MATCHMAKING_QUEUE_TABLE,
      KeyConditionExpression: 'Mode = :mode',
      ExpressionAttributeValues: {
        ':mode': mode,
        ':queued': MATCHMAKING_STATE.QUEUED
      },
      ExpressionAttributeNames: {
        '#state': 'State'
      },
      FilterExpression: '#state = :queued',
      Select: 'COUNT'
    })
    .promise();
  return result.Count ?? 0;
};

const getMmrTolerance = (mode: MatchMode, waitMs: number): number => {
  if (mode === 'free') {
    return 5000;
  }
  const increments = Math.floor(waitMs / 30000); // widen every 30s
  return Math.min(800, 150 + increments * 75);
};

const getEstimatedWaitSeconds = (mode: MatchMode, queueLength: number): number => {
  if (mode === 'free') {
    return Math.max(5, queueLength * 5);
  }
  return Math.max(15, queueLength * 20);
};

const attemptMatch = async (mode: MatchMode) => {
  const queued = await listQueuedEntries(mode);
  if (queued.length < 2) {
    return null;
  }

  const now = Date.now();
  queued.sort((a, b) => a.queuedAt - b.queuedAt);

  for (let i = 0; i < queued.length; i++) {
    for (let j = i + 1; j < queued.length; j++) {
      const a = queued[i];
      const b = queued[j];
      const waitMs = Math.max(now - a.queuedAt, now - b.queuedAt);
      const tolerance = getMmrTolerance(mode, waitMs);
      if (Math.abs(a.mmr - b.mmr) <= tolerance) {
        const matchId = uuidv4();
        const opponentForA = b.userId;
        const opponentForB = a.userId;
        const expiresAt = queueTtlSeconds();
        try {
          await dynamodb
            .transactWrite({
              TransactItems: [
                {
                  Update: {
                    TableName: MATCHMAKING_QUEUE_TABLE,
                    Key: queueKey(mode, a.userId),
                    ConditionExpression: '#state = :queued',
                    UpdateExpression:
                      'SET #state = :matched, MatchId = :matchId, OpponentId = :oppA, UpdatedAt = :now, ExpiresAt = :expires',
                    ExpressionAttributeNames: {
                      '#state': 'State'
                    },
                    ExpressionAttributeValues: {
                      ':queued': MATCHMAKING_STATE.QUEUED,
                      ':matched': MATCHMAKING_STATE.MATCHED,
                      ':matchId': matchId,
                      ':oppA': opponentForA,
                      ':now': now,
                      ':expires': expiresAt
                    }
                  }
                },
                {
                  Update: {
                    TableName: MATCHMAKING_QUEUE_TABLE,
                    Key: queueKey(mode, b.userId),
                    ConditionExpression: '#state = :queued',
                    UpdateExpression:
                      'SET #state = :matched, MatchId = :matchId, OpponentId = :oppB, UpdatedAt = :now, ExpiresAt = :expires',
                    ExpressionAttributeNames: {
                      '#state': 'State'
                    },
                    ExpressionAttributeValues: {
                      ':queued': MATCHMAKING_STATE.QUEUED,
                      ':matched': MATCHMAKING_STATE.MATCHED,
                      ':matchId': matchId,
                      ':oppB': opponentForB,
                      ':now': now,
                      ':expires': expiresAt
                    }
                  }
                }
              ]
            })
            .promise();
          return {
            matchId,
            mode,
            players: [
              { userId: a.userId, mmr: a.mmr, deckId: a.deckId },
              { userId: b.userId, mmr: b.mmr, deckId: b.deckId }
            ]
          };
        } catch {
          // Entry might have been removed; continue searching
        }
      }
    }
  }

  return null;
};

const mapMatchReplayItem = (
  item?: AWS.DynamoDB.DocumentClient.AttributeMap | null
): Record<string, any> | null => {
  if (!item) {
    return null;
  }
  return {
    matchId: item.MatchId,
    players: item.Players || [],
    winner: item.Winner || null,
    loser: item.Loser || null,
    duration: item.Duration ?? null,
    turns: item.Turns ?? null,
    moves: item.Moves || [],
    finalState: item.FinalState || null,
    createdAt: item.CreatedAt ? new Date(item.CreatedAt) : null
  };
};

const getMatchReplayRecord = async (matchId: string) => {
  const result = await dynamodb
    .get({
      TableName: matchTableName,
      Key: { MatchId: matchId }
    })
    .promise();
  return result.Item ?? null;
};

const fetchRecentMatches = async (limit = 10) => {
  const result = await dynamodb
    .scan({
      TableName: matchTableName,
      ProjectionExpression: 'MatchId, Players, Winner, Loser, Duration, Turns, CreatedAt',
      Limit: Math.max(limit * 3, limit)
    })
    .promise();
  const items = (result.Items || []).sort(
    (a, b) => (b.CreatedAt ?? 0) - (a.CreatedAt ?? 0)
  );
  return items.slice(0, limit).map((item) => ({
    matchId: item.MatchId,
    players: item.Players || [],
    winner: item.Winner || null,
    loser: item.Loser || null,
    duration: item.Duration ?? null,
    turns: item.Turns ?? null,
    createdAt: item.CreatedAt ? new Date(item.CreatedAt) : null
  }));
};

// ============================================================================
// QUERY RESOLVERS
// ============================================================================

export const queryResolvers = {
  // User Queries
  async user(_parent: any, { userId }: { userId: string }) {
    try {
      const result = await dynamodb.get({
        TableName: process.env.USERS_TABLE || 'riftbound-online-users-dev',
        Key: { UserId: userId }
      }).promise();

      if (!result.Item) {
        throw new Error('User not found');
      }

      return {
        userId: result.Item.UserId,
        username: result.Item.Username,
        email: result.Item.Email,
        userLevel: result.Item.UserLevel,
        wins: result.Item.Wins,
        totalMatches: result.Item.TotalMatches,
        lastLogin: result.Item.LastLogin ? new Date(result.Item.LastLogin) : null,
        createdAt: result.Item.CreatedAt ? new Date(result.Item.CreatedAt) : null,
      };
    } catch (error) {
      logger.error('Error fetching user:', error);
      throw error;
    }
  },

  async leaderboard(_parent: any, { limit = 100 }: { limit?: number }) {
    try {
      return await fetchLeaderboardEntries(limit);
    } catch (error) {
      logger.error('Error fetching leaderboard:', error);
      throw error;
    }
  },

  // Match Queries
  match(_parent: any, { matchId }: { matchId: string }) {
    try {
      const engine = activeGames.get(matchId);
      if (!engine) {
        throw new Error('Match not found');
      }
      return serializeGameState(engine.getGameState());
    } catch (error) {
      logger.error('Error fetching match:', error);
      throw error;
    }
  },

  playerMatch(_parent: any, { matchId, playerId }: { matchId: string; playerId: string }) {
    try {
      const engine = activeGames.get(matchId);
      if (!engine) {
        throw new Error('Match not found');
      }

      const playerState = engine.getPlayerState(playerId);
      if (!playerState) {
        throw new Error('Player not found in match');
      }

      const rawState = engine.getGameState();
      const currentPlayer = serializePlayerState(playerState, 'self');
      const opponentSummary = buildOpponentView(rawState, playerId);

      return {
        matchId,
        currentPlayer,
        opponent: opponentSummary,
        gameState: {
          matchId,
          currentPhase: rawState.currentPhase,
          turnNumber: rawState.turnNumber,
          currentPlayerIndex: rawState.currentPlayerIndex,
          canAct: engine.canPlayerAct(playerId),
        },
      };
    } catch (error) {
      logger.error('Error fetching player match:', error);
      throw error;
    }
  },

  async matchHistory(
    _parent: any,
    { userId, limit = 10 }: { userId: string; limit?: number },
    context: ResolverContext
  ) {
    const targetUserId = userId || requireUser(context);
    requireUser(context, targetUserId);
    try {
      const result = await dynamodb.query({
        TableName: process.env.MATCH_HISTORY_TABLE || 'riftbound-online-match-history-dev',
        IndexName: 'UserIdIndex',
        KeyConditionExpression: 'UserId = :userId',
        ExpressionAttributeValues: {
          ':userId': targetUserId,
        },
        Limit: limit,
        ScanIndexForward: false,
      }).promise();

      return (result.Items || []).map((item: any) => ({
        matchId: item.MatchId,
        timestamp: new Date(item.Timestamp),
        players: item.Players || [],
        winner: item.Winner,
        loser: item.Loser,
        duration: item.Duration,
        turns: item.Turns,
        moveCount: item.MoveCount,
        status: item.Status || 'completed',
      }));
    } catch (error) {
      logger.error('Error fetching match history:', error);
      throw error;
    }
  },

  async matchResult(_parent: any, { matchId }: { matchId: string }) {
    try {
      const result = await dynamodb.get({
        TableName: matchTableName,
        Key: { MatchId: matchId }
      }).promise();

      if (!result.Item) {
        return null;
      }

      return {
        matchId: result.Item.MatchId,
        winner: result.Item.Winner,
        loser: result.Item.Loser,
        reason: result.Item.Reason,
        duration: result.Item.Duration,
        turns: result.Item.Turns,
        moves: result.Item.MoveCount,
      };
    } catch (error) {
      logger.error('Error fetching match result:', error);
      throw error;
    }
  },

  async decklists(_parent: any, { userId }: { userId: string }, context: ResolverContext) {
    const targetUserId = userId || requireUser(context);
    requireUser(context, targetUserId);
    try {
      const result = await dynamodb
        .query({
          TableName: decklistsTableName,
          KeyConditionExpression: 'UserId = :userId',
          ExpressionAttributeValues: {
            ':userId': targetUserId
          }
        })
        .promise();

      return (result.Items || []).map((item) => mapDecklistItem(item)).filter(Boolean);
    } catch (error) {
      logger.error('Error fetching decklists:', error);
      throw error;
    }
  },

  async decklist(_parent: any, { deckId }: { deckId: string }, context: ResolverContext) {
    if (!deckId) {
      return null;
    }
    try {
      const result = await dynamodb
        .query({
          TableName: decklistsTableName,
          IndexName: deckIdIndexName,
          KeyConditionExpression: 'DeckId = :deckId',
          ExpressionAttributeValues: {
            ':deckId': deckId
          },
          Limit: 1
        })
        .promise();

      const item = result.Items?.[0];
      if (item) {
        requireUser(context, item.UserId);
      } else {
        requireUser(context);
      }

      return mapDecklistItem(item);
    } catch (error) {
      logger.error('Error fetching decklist:', error);
      throw error;
    }
  },

  async matchmakingStatus(
    _parent: any,
    { userId, mode }: { userId: string; mode: MatchMode },
    context: ResolverContext
  ) {
    const targetUserId = userId || requireUser(context);
    requireUser(context, targetUserId);
    const normalizedMode = normalizeMatchMode(mode);
    const entry = await getQueueEntry(normalizedMode, targetUserId);
    const queueLength = await getQueueLength(normalizedMode);
    const estimatedWaitSeconds = getEstimatedWaitSeconds(normalizedMode, queueLength);

    if (!entry) {
      const mmr = await getUserMmr(targetUserId);
      return {
        mode: normalizedMode,
        state: 'idle',
        queued: false,
        mmr,
        estimatedWaitSeconds
      };
    }

    return {
      mode: normalizedMode,
      state: entry.State || MATCHMAKING_STATE.QUEUED,
      queued: entry.State === MATCHMAKING_STATE.QUEUED,
      mmr: entry.MMR ?? (await getUserMmr(targetUserId)),
      queuedAt: entry.QueuedAt ? new Date(entry.QueuedAt) : null,
      estimatedWaitSeconds,
      matchId: entry.MatchId ?? null,
      opponentId: entry.OpponentId ?? null
    };
  },

  async matchReplay(_parent: any, { matchId }: { matchId: string }) {
    try {
      const record = await getMatchReplayRecord(matchId);
      return mapMatchReplayItem(record);
    } catch (error) {
      logger.error('Error fetching replay:', error);
      throw error;
    }
  },

  async recentMatches(_parent: any, { limit = 10 }: { limit?: number }) {
    try {
      const sanitizedLimit = Math.max(1, Math.min(50, limit));
      return await fetchRecentMatches(sanitizedLimit);
    } catch (error) {
      logger.error('Error fetching recent matches:', error);
      throw error;
    }
  },

  cardCatalog(_parent: any, { filter }: { filter?: CardCatalogFilterInput }) {
    try {
      const catalog = getCardCatalog();
      let filtered: EnrichedCardRecord[] = catalog;

      if (filter?.search) {
        const term = filter.search.toLowerCase();
        filtered = filtered.filter(
          (card) =>
            card.name.toLowerCase().includes(term) ||
            card.effect.toLowerCase().includes(term) ||
            card.tags.some((tag) => tag.toLowerCase().includes(term)) ||
            card.keywords.some((keyword) => keyword.toLowerCase().includes(term))
        );
      }

      if (filter?.type) {
        const normalizedType = filter.type.toLowerCase();
        filtered = filtered.filter((card) => card.type?.toLowerCase() === normalizedType);
      }

      if (filter?.domain) {
        const normalizedDomain = filter.domain.toLowerCase();
        filtered = filtered.filter((card) =>
          card.colors.some((color) => color.toLowerCase() === normalizedDomain)
        );
      }

      if (filter?.rarity) {
        const normalizedRarity = filter.rarity.toLowerCase();
        filtered = filtered.filter((card) => card.rarity?.toLowerCase() === normalizedRarity);
      }

      if (filter?.limit && filter.limit > 0) {
        filtered = filtered.slice(0, filter.limit);
      }

      return filtered;
    } catch (error) {
      logger.error('Error fetching card catalog:', error);
      throw error;
    }
  },

  cardById(_parent: any, { id }: { id: string }) {
    return findCatalogCardById(id);
  },

  cardBySlug(_parent: any, { slug }: { slug: string }) {
    return findCatalogCardBySlug(slug);
  },

  cardImageManifest() {
    return getImageManifest();
  },

  cardActivationStates() {
    return Object.values(buildActivationStateIndex());
  },
};

// ============================================================================
// MUTATION RESOLVERS
// ============================================================================

export const mutationResolvers = {
  async updateUser(
    _parent: any,
    {
      userId,
      username,
      userLevel,
      wins,
      totalMatches,
    }: {
      userId: string;
      username?: string;
      userLevel?: number;
      wins?: number;
      totalMatches?: number;
    }
  ) {
    try {
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
        ReturnValues: 'ALL_NEW',
      }).promise();

      const item = result.Attributes;
      if (!item) {
        throw new Error('Failed to update user');
      }

      const updatedUser = {
        userId: item.UserId,
        username: item.Username,
        email: item.Email,
        userLevel: item.UserLevel,
        wins: item.Wins,
        totalMatches: item.TotalMatches,
        lastLogin: item.LastLogin ? new Date(item.LastLogin) : null,
        createdAt: item.CreatedAt ? new Date(item.CreatedAt) : null,
      };

      await broadcastLeaderboardUpdate();
      return updatedUser;
    } catch (error) {
      logger.error('Error updating user:', error);
      throw error;
    }
  },

  async initMatch(
    _parent: any,
    {
      matchId,
      player1,
      player2,
      decks,
    }: {
      matchId: string;
      player1: string;
      player2: string;
      decks: any;
    }
  ) {
    try {
      if (activeGames.has(matchId)) {
        throw new Error('Match already exists');
      }

      const engine = new RiftboundGameEngine(matchId, [player1, player2]);
      engine.initializeGame(decks);

      activeGames.set(matchId, engine);

      // Save initial state
      await saveGameState(matchId, engine);

      const gameState = engine.getGameState();

      logger.info(`[MATCH-INIT] Match ${matchId} initialized between ${player1} and ${player2}`);

      return {
        matchId,
        status: 'initialized',
        players: [player1, player2],
        gameState,
      };
    } catch (error) {
      logger.error('[MATCH-INIT] Error:', error);
      throw error;
    }
  },

  async playCard(
    _parent: any,
    {
      matchId,
      playerId,
      cardIndex,
      targets,
    }: {
      matchId: string;
      playerId: string;
      cardIndex: number;
      targets?: string[];
    }
  ) {
    try {
      const engine = activeGames.get(matchId);
      if (!engine) {
        throw new Error('Match not found');
      }

      if (!engine.canPlayerAct(playerId)) {
        throw new Error('Not your turn');
      }

      const playerView = engine.getPlayerState(playerId);
      const selectedCard = playerView?.hand?.[cardIndex];
      const cardSnapshot: PublishedCard | null = selectedCard
        ? {
            cardId: selectedCard.id,
            name: selectedCard.name,
            cost: selectedCard.energyCost ?? selectedCard.manaCost ?? 0,
            power: selectedCard.power ?? 0,
            toughness: selectedCard.toughness ?? 0,
            type: selectedCard.type,
          }
        : null;

      engine.playCard(playerId, cardIndex, targets);
      await saveGameState(matchId, engine);

      const rawState = engine.getGameState();
      const spectatorState = serializeGameState(rawState);
      const currentPlayerSnapshot = serializePlayerState(engine.getPlayerState(playerId), 'self');
      const opponentSummary = buildOpponentView(rawState, playerId);

      // Publish real-time update
      publishGameStateChange(matchId, spectatorState);
      publishPlayerGameStateChange(matchId, playerId, {
        matchId,
        currentPlayer: currentPlayerSnapshot,
        opponent: opponentSummary,
        gameState: {
          matchId,
          currentPhase: rawState.currentPhase,
          turnNumber: rawState.turnNumber,
          currentPlayerIndex: rawState.currentPlayerIndex,
          canAct: engine.canPlayerAct(playerId),
        },
      });

      if (cardSnapshot) {
        publishCardPlayed(matchId, {
          matchId,
          playerId,
          card: cardSnapshot,
          timestamp: new Date(),
        });
      }

      logger.info(`[PLAY-CARD] Player ${playerId} played card in match ${matchId}`);

      return {
        success: true,
        gameState: spectatorState,
        currentPhase: spectatorState.currentPhase,
      };
    } catch (error: any) {
      logger.error('[PLAY-CARD] Error:', error);
      throw error;
    }
  },

  async attack(
    _parent: any,
    {
      matchId,
      playerId,
      creatureInstanceId,
      defenderId,
    }: {
      matchId: string;
      playerId: string;
      creatureInstanceId: string;
      defenderId?: string;
    }
  ) {
    try {
      const engine = activeGames.get(matchId);
      if (!engine) {
        throw new Error('Match not found');
      }

      if (!engine.canPlayerAct(playerId)) {
        throw new Error('Not your turn');
      }

      engine.declareAttacker(playerId, creatureInstanceId, defenderId);
      await saveGameState(matchId, engine);

      const rawState = engine.getGameState();
      const spectatorState = serializeGameState(rawState);

      publishGameStateChange(matchId, spectatorState);
      publishAttackDeclared(matchId, {
        matchId,
        playerId,
        creatureInstanceId,
        defenderId,
        timestamp: new Date(),
      });

      logger.info(`[ATTACK] Player ${playerId} declared attack in match ${matchId}`);

      return {
        success: true,
        gameState: spectatorState,
        currentPhase: spectatorState.currentPhase,
      };
    } catch (error: any) {
      logger.error('[ATTACK] Error:', error);
      throw error;
    }
  },

  async nextPhase(
    _parent: any,
    { matchId, playerId }: { matchId: string; playerId: string }
  ) {
    try {
      const engine = activeGames.get(matchId);
      if (!engine) {
        throw new Error('Match not found');
      }

      if (!engine.canPlayerAct(playerId)) {
        throw new Error('Not your turn');
      }

      engine.proceedToNextPhase();
      await saveGameState(matchId, engine);

      const rawState = engine.getGameState();
      const spectatorState = serializeGameState(rawState);

      publishGameStateChange(matchId, spectatorState);
      publishPhaseChange(matchId, {
        matchId,
        newPhase: rawState.currentPhase,
        turnNumber: rawState.turnNumber,
        timestamp: new Date(),
      });

      logger.info(`[NEXT-PHASE] Player ${playerId} advanced phase in match ${matchId}`);

      return {
        success: true,
        gameState: spectatorState,
        currentPhase: spectatorState.currentPhase,
      };
    } catch (error: any) {
      logger.error('[NEXT-PHASE] Error:', error);
      throw error;
    }
  },

  async reportMatchResult(
    _parent: any,
    { matchId, winner, reason }: { matchId: string; winner: string; reason: string }
  ) {
    try {
      const engine = activeGames.get(matchId);
      if (!engine) {
        throw new Error('Match not found');
      }

      const rawState = engine.getGameState();
      const spectatorState = serializeGameState(rawState);
      const matchResult = {
        matchId,
        winner,
        loser: rawState.players.find((p: any) => p.playerId !== winner)?.playerId,
        reason: reason || 'victory_points',
        duration: Date.now() - rawState.timestamp,
        turns: rawState.turnNumber,
        moves: rawState.moveHistory || [],
      };

      const now = Date.now();

      await dynamodb
        .put({
          TableName: matchTableName,
          Item: {
            MatchId: matchId,
            Players: rawState.players.map((p: any) => p.playerId),
            Winner: matchResult.winner,
            Loser: matchResult.loser,
            Reason: matchResult.reason,
            Duration: matchResult.duration,
            Turns: matchResult.turns,
            MoveCount: matchResult.moves.length,
            Moves: matchResult.moves,
            FinalState: spectatorState,
            CreatedAt: now,
            Status: 'completed',
          },
        })
        .promise();

      activeGames.delete(matchId);

      // Publish match completion
      publishMatchCompletion(matchId, matchResult);

      logger.info(`[MATCH-COMPLETE] Match ${matchId} completed. Winner: ${winner}`);

      return {
        success: true,
        matchResult,
      };
    } catch (error) {
      logger.error('[RESULT] Error:', error);
      throw error;
    }
  },

  async concedeMatch(
    _parent: any,
    { matchId, playerId }: { matchId: string; playerId: string }
  ) {
    try {
      const engine = activeGames.get(matchId);
      if (!engine) {
        throw new Error('Match not found');
      }

      const rawState = engine.getGameState();
      const opponent = rawState.players.find((p: any) => p.playerId !== playerId);
      if (!opponent) {
        throw new Error('Opponent not found');
      }

      const matchResult = {
        matchId,
        winner: opponent.playerId,
        loser: playerId,
        reason: 'concede',
        duration: Date.now() - rawState.timestamp,
        turns: rawState.turnNumber,
        moves: rawState.moveHistory || [],
      };
      const spectatorState = serializeGameState(rawState);

      // Save to DynamoDB
      const now = Date.now();
      await dynamodb
        .put({
          TableName: matchTableName,
          Item: {
            MatchId: matchId,
            Players: rawState.players.map((p: any) => p.playerId),
            Winner: matchResult.winner,
            Loser: matchResult.loser,
            Reason: matchResult.reason,
            Duration: matchResult.duration,
            Turns: matchResult.turns,
            MoveCount: matchResult.moves.length,
            Moves: matchResult.moves,
            FinalState: spectatorState,
            CreatedAt: now,
            Status: 'completed',
          },
        })
        .promise();

      activeGames.delete(matchId);

      // Publish match completion
      publishMatchCompletion(matchId, matchResult);

      logger.info(`[MATCH-CONCEDE] Match ${matchId} ended. Winner: ${opponent.playerId}`);

      return {
        success: true,
        matchResult,
      };
    } catch (error) {
      logger.error('[CONCEDE] Error:', error);
      throw error;
    }
  },

  async saveDecklist(
    _parent: any,
    { input }: { input: DecklistInput },
    context: ResolverContext
  ) {
    try {
      if (!input.userId) {
        throw new Error('User ID is required to save a decklist');
      }
      requireUser(context, input.userId);
      if (!input.cards || input.cards.length === 0) {
        throw new Error('Deck must include at least one card');
      }

      const normalizedCards = sanitizeDeckCards(input.cards);
      const cardCount = normalizedCards.reduce((sum, card) => sum + card.quantity, 0);

      if (cardCount < MIN_DECK_SIZE) {
        throw new Error(
          `Deck must include at least ${MIN_DECK_SIZE} cards (currently ${cardCount})`
        );
      }

      if (cardCount > MAX_DECK_SIZE) {
        throw new Error(
          `Deck cannot include more than ${MAX_DECK_SIZE} cards (currently ${cardCount})`
        );
      }

      const normalizedRunesRaw = sanitizeDeckCards(input.runeDeck || [], MAX_RUNE_COPIES);
      const normalizedRunes: DeckCardRecord[] = [];
      let runeTotal = 0;
      for (const entry of normalizedRunesRaw) {
        if (runeTotal >= MAX_RUNE_TOTAL) {
          break;
        }
        const remaining = MAX_RUNE_TOTAL - runeTotal;
        const quantity = Math.min(entry.quantity, remaining);
        if (quantity <= 0) {
          continue;
        }
        normalizedRunes.push({
          ...entry,
          quantity
        });
        runeTotal += quantity;
      }
      const normalizedBattlefields = sanitizeDeckCards(input.battlefields || [])
        .map((entry) => ({ ...entry, quantity: 1 }))
        .slice(0, BATTLEFIELD_SLOTS);
      const normalizedSideDeck = sanitizeDeckCards(input.sideDeck || []);
      const sanitizedLegend = sanitizeSingleDeckCard(input.championLegend);
      const sanitizedLeader = sanitizeSingleDeckCard(input.championLeader);
      const sideDeckCount = normalizedSideDeck.reduce((sum, card) => sum + card.quantity, 0);
      if (sideDeckCount > MAX_SIDE_DECK_CARDS) {
        throw new Error(
          `Side deck cannot include more than ${MAX_SIDE_DECK_CARDS} cards (currently ${sideDeckCount})`
        );
      }
      const now = Date.now();
      const deckId = input.deckId ?? uuidv4();

      let createdAt = now;
      if (input.deckId) {
        const existing = await dynamodb
          .get({
            TableName: decklistsTableName,
            Key: { UserId: input.userId, DeckId: deckId }
          })
          .promise();
        if (existing.Item && existing.Item.CreatedAt) {
          createdAt = existing.Item.CreatedAt;
        }
      }

      const isDefaultDeck = Boolean(input.isDefault);

      const item: Record<string, any> = {
        UserId: input.userId,
        DeckId: deckId,
        Name: input.name,
        Description: input.description ?? '',
        HeroSlug: input.heroSlug ?? null,
        Format: input.format ?? 'standard',
        Tags: input.tags ?? [],
        IsPublic: Boolean(input.isPublic),
        IsDefault: isDefaultDeck,
        CardCount: cardCount,
        Cards: normalizedCards,
        RuneDeck: normalizedRunes,
        Battlefields: normalizedBattlefields,
        SideDeck: normalizedSideDeck,
        CreatedAt: createdAt,
        UpdatedAt: now
      };
      if (sanitizedLegend) {
        item.ChampionLegend = sanitizedLegend;
      }
      if (sanitizedLeader) {
        item.ChampionLeader = sanitizedLeader;
      }

      await dynamodb
        .put({
          TableName: decklistsTableName,
          Item: item
        })
        .promise();

      if (isDefaultDeck) {
        const existingDefaults = await dynamodb
          .query({
            TableName: decklistsTableName,
            KeyConditionExpression: 'UserId = :userId',
            ExpressionAttributeValues: {
              ':userId': input.userId
            }
          })
          .promise();

        const updates = (existingDefaults.Items || [])
          .filter((deck) => deck.DeckId !== deckId && deck.IsDefault)
          .map((deck) =>
            dynamodb
              .update({
                TableName: decklistsTableName,
                Key: { UserId: deck.UserId, DeckId: deck.DeckId },
                UpdateExpression: 'SET #isDefault = :false',
                ExpressionAttributeNames: { '#isDefault': 'IsDefault' },
                ExpressionAttributeValues: { ':false': false }
              })
              .promise()
          );
        if (updates.length) {
          await Promise.all(updates);
        }
      }

      return mapDecklistItem(item);
    } catch (error) {
      logger.error('Error saving decklist:', error);
      throw error;
    }
  },

  async deleteDecklist(
    _parent: any,
    { userId, deckId }: { userId: string; deckId: string },
    context: ResolverContext
  ) {
    try {
      if (!userId || !deckId) {
        throw new Error('User ID and Deck ID are required');
      }
      requireUser(context, userId);

      await dynamodb
        .delete({
          TableName: decklistsTableName,
          Key: { UserId: userId, DeckId: deckId }
        })
        .promise();

      return true;
    } catch (error) {
      logger.error('Error deleting decklist:', error);
      throw error;
    }
  },

  async joinMatchmakingQueue(
    _parent: any,
    { input }: { input: { userId: string; mode: MatchMode; deckId?: string } },
    context: ResolverContext
  ) {
    try {
      requireUser(context, input.userId);
      const normalizedMode = normalizeMatchMode(input.mode);
      const userId = input.userId;
      const existing = await getQueueEntry(normalizedMode, userId);

      if (existing && existing.State === MATCHMAKING_STATE.MATCHED) {
        return {
          mode: normalizedMode,
          queued: false,
          matchFound: true,
          matchId: existing.MatchId ?? null,
          opponentId: existing.OpponentId ?? null,
          mmr: existing.MMR ?? (await getUserMmr(userId)),
          estimatedWaitSeconds: getEstimatedWaitSeconds(normalizedMode, await getQueueLength(normalizedMode))
        };
      }

      const mmr = await getUserMmr(userId);
      const now = Date.now();

      await dynamodb
        .put({
          TableName: MATCHMAKING_QUEUE_TABLE,
          Item: {
            Mode: normalizedMode,
            UserId: userId,
            DeckId: input.deckId ?? null,
            State: MATCHMAKING_STATE.QUEUED,
            MMR: mmr,
            QueuedAt: now,
            Ranked: normalizedMode === 'ranked',
            ExpiresAt: queueTtlSeconds()
          }
        })
        .promise();

      const match = await attemptMatch(normalizedMode);
      const queueLength = await getQueueLength(normalizedMode);
      const estimatedWaitSeconds = getEstimatedWaitSeconds(normalizedMode, queueLength);
      const participant = match?.players.find((player) => player.userId === userId);

      return {
        mode: normalizedMode,
        queued: !participant,
        matchFound: Boolean(participant),
        matchId: participant ? match?.matchId ?? null : null,
        opponentId: participant
          ? match?.players.find((player) => player.userId !== userId)?.userId ?? null
          : null,
        mmr,
        estimatedWaitSeconds
      };
    } catch (error) {
      logger.error('Error joining matchmaking queue:', error);
      throw error;
    }
  },

  async leaveMatchmakingQueue(
    _parent: any,
    { userId, mode }: { userId: string; mode: MatchMode },
    context: ResolverContext
  ) {
    try {
      requireUser(context, userId);
      const normalizedMode = normalizeMatchMode(mode);
      await dynamodb
        .delete({
          TableName: MATCHMAKING_QUEUE_TABLE,
          Key: queueKey(normalizedMode, userId)
        })
        .promise();
      return true;
    } catch (error) {
      logger.error('Error leaving matchmaking queue:', error);
      throw error;
    }
  }
};

// ============================================================================
// SUBSCRIPTION RESOLVERS
// ============================================================================

export const subscriptionResolvers = {
  gameStateChanged: {
    subscribe: (_parent: any, { matchId }: { matchId: string }) => {
      return pubSub.asyncIterator([`${SubscriptionEvents.GAME_STATE_CHANGED}:${matchId}`]);
    },
  },

  playerGameStateChanged: {
    subscribe: (_parent: any, { matchId, playerId }: { matchId: string; playerId: string }) => {
      return pubSub.asyncIterator([
        `${SubscriptionEvents.PLAYER_GAME_STATE_CHANGED}:${matchId}:${playerId}`,
      ]);
    },
  },

  matchCompleted: {
    subscribe: (_parent: any, { matchId }: { matchId: string }) => {
      return pubSub.asyncIterator([`${SubscriptionEvents.MATCH_COMPLETED}:${matchId}`]);
    },
  },

  leaderboardUpdated: {
    subscribe: () => {
      return pubSub.asyncIterator([SubscriptionEvents.LEADERBOARD_UPDATED]);
    },
  },

  cardPlayed: {
    subscribe: (_parent: any, { matchId }: { matchId: string }) => {
      return pubSub.asyncIterator([`${SubscriptionEvents.CARD_PLAYED}:${matchId}`]);
    },
  },

  attackDeclared: {
    subscribe: (_parent: any, { matchId }: { matchId: string }) => {
      return pubSub.asyncIterator([`${SubscriptionEvents.ATTACK_DECLARED}:${matchId}`]);
    },
  },

  phaseChanged: {
    subscribe: (_parent: any, { matchId }: { matchId: string }) => {
      return pubSub.asyncIterator([`${SubscriptionEvents.PHASE_CHANGED}:${matchId}`]);
    },
  },
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function fetchLeaderboardEntries(limit = 100): Promise<LeaderboardEntry[]> {
  const result = await dynamodb.scan({
    TableName: process.env.USERS_TABLE || 'riftbound-online-users-dev',
    Limit: limit
  }).promise();

  return (result.Items || [])
    .map((item: any) => ({
      userId: item.UserId,
      username: item.Username,
      wins: item.Wins || 0,
      totalMatches: item.TotalMatches || 0,
      winRate: item.TotalMatches ? ((item.Wins || 0) / item.TotalMatches) : 0,
    }))
    .sort((a, b) => b.wins - a.wins)
    .slice(0, limit);
}

async function broadcastLeaderboardUpdate(limit = 100): Promise<void> {
  try {
    const leaderboard = await fetchLeaderboardEntries(limit);
    publishLeaderboardUpdate(leaderboard);
  } catch (error) {
    logger.error('[LEADERBOARD] Failed to publish update:', error);
  }
}

async function saveGameState(matchId: string, engine: RiftboundGameEngine): Promise<void> {
  try {
    const gameState = serializeGameState(engine.getGameState());
    await dynamodb.put({
      TableName: process.env.STATE_TABLE || 'riftbound-online-match-states-dev',
      Item: {
        MatchId: matchId,
        GameState: gameState,
        Timestamp: Date.now(),
        Status: gameState.status,
        TurnNumber: gameState.turnNumber,
        CurrentPhase: gameState.currentPhase,
      },
    }).promise();
  } catch (error) {
    logger.error('[STATE-SAVE] Failed to save game state:', error);
  }
}

// Export active games map for use in server setup
export { activeGames };
