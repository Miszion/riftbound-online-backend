import AWS from 'aws-sdk';
import { v4 as uuidv4 } from 'uuid';
import { GraphQLError } from 'graphql';
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
import {
  getCardCatalog,
  findCardById as findCatalogCardById,
  findCardBySlug as findCatalogCardBySlug,
  getImageManifest,
  buildActivationStateIndex,
} from '../card-catalog';
import type { EnrichedCardRecord } from '../card-catalog';

// Initialize AWS SDK
const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || 'us-east-1'
});
const sqs = new AWS.SQS({
  region: process.env.AWS_REGION || 'us-east-1'
});

const internalApiHost =
  process.env.INTERNAL_API_BASE_URL ||
  process.env.API_BASE_URL ||
  `http://localhost:${process.env.PORT || 3000}`;
const internalApiBaseUrl = internalApiHost.startsWith('http') ? internalApiHost : `http://${internalApiHost}`;

const INTERNAL_API_MAX_RETRIES = 5;
const INTERNAL_API_RETRY_DELAY_MS = 500;
const RETRYABLE_STATUS = new Set([502, 503, 504]);

const defaultJsonHeaders = {
  'Content-Type': 'application/json'
};

const wait = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const buildAuthHeaders = (authToken?: string | null): Record<string, string> => {
  if (!authToken) {
    return {};
  }
  return {
    Authorization: `Bearer ${authToken}`,
    'x-id-token': authToken
  };
};

const internalApiRequest = async <T>(
  path: string,
  init?: RequestInit,
  authToken?: string | null
): Promise<T> => {
  let attempt = 0;
  let lastError: any = null;
  const authHeaders = buildAuthHeaders(authToken);
  while (attempt < INTERNAL_API_MAX_RETRIES) {
    try {
      const initHeaders = (init?.headers as Record<string, string>) || {};
      const response = await fetch(`${internalApiBaseUrl}${path}`, {
        ...init,
        headers: {
          ...defaultJsonHeaders,
          ...authHeaders,
          ...initHeaders
        }
      });
      const rawBody = await response.text();
      let parsed: any = null;
      if (rawBody) {
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          parsed = rawBody;
        }
      }
      if (!response.ok) {
        const message =
          parsed?.error ||
          parsed?.message ||
          `Game API error (${response.status})`;
        if (
          RETRYABLE_STATUS.has(response.status) &&
          attempt < INTERNAL_API_MAX_RETRIES - 1
        ) {
          await wait(INTERNAL_API_RETRY_DELAY_MS * (attempt + 1));
          attempt += 1;
          continue;
        }
        const error = new Error(message);
        (error as any).statusCode = response.status;
        throw error;
      }
      return parsed as T;
    } catch (error) {
      lastError = error;
      const statusCode = (error as any)?.statusCode;
      const shouldRetry =
        (statusCode && RETRYABLE_STATUS.has(statusCode)) ||
        (!statusCode && attempt < INTERNAL_API_MAX_RETRIES - 1);
      if (shouldRetry && attempt < INTERNAL_API_MAX_RETRIES - 1) {
        await wait(INTERNAL_API_RETRY_DELAY_MS * (attempt + 1));
        attempt += 1;
        continue;
      }
      throw error;
    }
  }
  throw lastError;
};

const ensureGameStateDefaults = (state: any) => {
  if (!state || typeof state !== 'object') {
    return state;
  }
  if (!Array.isArray(state.duelLog)) {
    state.duelLog = [];
  }
  if (!Array.isArray(state.chatLog)) {
    state.chatLog = [];
  }
  return state;
};

const fetchSpectatorState = async (matchId: string, authToken?: string | null) => {
  const state = await internalApiRequest<any>(`/matches/${matchId}`, undefined, authToken);
  return ensureGameStateDefaults(state);
};

const fetchPlayerView = (matchId: string, playerId: string, authToken?: string | null) =>
  internalApiRequest<any>(`/matches/${matchId}/player/${playerId}`, undefined, authToken);

const postMatchAction = (
  matchId: string,
  action: string,
  body: Record<string, unknown>,
  authToken?: string | null
) =>
  internalApiRequest<any>(
    `/matches/${matchId}/actions/${action}`,
    {
      method: 'POST',
      body: JSON.stringify(body)
    },
    authToken
  );

const postChatMessage = async (
  matchId: string,
  payload: { playerId: string; message: string; playerName?: string | null },
  authToken?: string | null
) => {
  try {
    return await postMatchAction(matchId, 'chat', payload, authToken);
  } catch (error: any) {
    if (error?.statusCode === 404) {
      return internalApiRequest(
        `/matches/${matchId}/chat`,
        {
          method: 'POST',
          body: JSON.stringify(payload)
        },
        authToken
      );
    }
    throw error;
  }
};

const syncMatchStateFromService = async (matchId: string, authToken?: string | null) => {
  const spectatorState = await fetchSpectatorState(matchId, authToken);
  publishGameStateChange(matchId, spectatorState);
  const players = spectatorState?.players ?? [];
  await Promise.all(
    players.map(async (player: { playerId: string }) => {
      try {
        const playerView = await fetchPlayerView(matchId, player.playerId, authToken);
        publishPlayerGameStateChange(matchId, player.playerId, playerView);
      } catch (error) {
        logger.warn('[MATCH-SYNC] Failed to publish player snapshot', {
          matchId,
          playerId: player.playerId,
          error
        });
      }
    })
  );
  return spectatorState;
};

const spawnMatchService = async ({
  matchId,
  player1,
  player2,
  decks,
  authToken,
  playerProfiles,
}: {
  matchId: string;
  player1: string;
  player2: string;
  decks: any;
  authToken?: string | null;
  playerProfiles?: PlayerProfileMap;
}) => {
  const payload = await internalApiRequest<any>(
    '/matches/init',
    {
      method: 'POST',
      body: JSON.stringify({
        matchId,
        player1,
        player2,
        decks,
        playerProfiles
      })
    },
    authToken
  );

  logger.info(`[MATCH-INIT] Match ${matchId} initialized between ${player1} and ${player2}`);
  return payload;
};

const rethrowGraphQLError = (error: unknown, fallbackMessage: string) => {
  const statusCode = (error as any)?.statusCode;
  const message = error instanceof Error ? error.message : fallbackMessage;
  if (statusCode && statusCode >= 400 && statusCode < 500) {
    throw new GraphQLError(message, {
      extensions: {
        code: 'BAD_USER_INPUT',
        http: { status: statusCode }
      }
    });
  }
  throw error instanceof Error ? error : new Error(fallbackMessage);
};

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

const decklistsTableName =
  process.env.DECKLISTS_TABLE ||
  process.env.DECKS_TABLE ||
  'riftbound-online-decklists-dev';
const deckIdIndexName = 'DeckIdIndex';
const MIN_DECK_SIZE = 39;
const MAX_DECK_SIZE = 39;
const MAX_CARD_COPIES = 3;
const MAX_RUNE_COPIES = 12;
const MAX_RUNE_TOTAL = 12;
const MAX_SIDE_DECK_CARDS = 8;
const BATTLEFIELD_SLOTS = 3;
const matchTableName =
  process.env.MATCH_TABLE ||
  process.env.MATCH_HISTORY_TABLE ||
  'riftbound-online-matches-dev';
export type MatchMode = 'ranked' | 'free';
const rankedMatchmakingQueueUrl =
  process.env.MATCHMAKING_RANKED_QUEUE_URL ||
  process.env.MATCHMAKING_COMPETITIVE_QUEUE_URL ||
  null;
const quickPlayMatchmakingQueueUrl =
  process.env.MATCHMAKING_FREE_QUEUE_URL ||
  process.env.MATCHMAKING_NORMAL_QUEUE_URL ||
  process.env.MATCHMAKING_QUICKPLAY_QUEUE_URL ||
  null;
const matchmakingQueueUrls: Record<MatchMode, string | null> = {
  ranked: rankedMatchmakingQueueUrl,
  free: quickPlayMatchmakingQueueUrl
};
const MATCHMAKING_QUEUE_TABLE =
  process.env.MATCHMAKING_QUEUE_TABLE || 'riftbound-online-matchmaking-queue-dev';
const MATCHMAKING_MODES: MatchMode[] = ['ranked', 'free'];
const MATCHMAKING_STATE = {
  QUEUED: 'queued',
  MATCHED: 'matched'
} as const;

export interface ResolverContext {
  userId?: string | null;
  authToken?: string | null;
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

const getUserProfileSummary = async (
  userId: string
): Promise<{ userId: string; username?: string | null } | null> => {
  if (!userId) {
    return null;
  }
  try {
    const result = await dynamodb
      .get({
        TableName: process.env.USERS_TABLE || 'riftbound-online-users-dev',
        Key: { UserId: userId },
        ProjectionExpression: 'UserId, Username'
      })
      .promise();
    if (!result.Item) {
      return null;
    }
    return {
      userId: result.Item.UserId,
      username: result.Item.Username ?? null
    };
  } catch {
    return null;
  }
};

const getUsernameForUser = async (userId?: string | null): Promise<string | null> => {
  if (!userId) {
    return null;
  }
  const profile = await getUserProfileSummary(userId);
  return profile?.username ?? null;
};

type PlayerProfileMap = Record<string, { username?: string | null }>;

type MatchPlayerLike = {
  playerId?: string | null;
  name?: string | null;
};

const hydratePlayerName = async (player?: MatchPlayerLike) => {
  if (!player?.playerId) {
    return;
  }
  if (!player.name || player.name === player.playerId) {
    const username = await getUsernameForUser(player.playerId);
    if (username) {
      player.name = username;
    }
  }
};

const buildPlayerProfileMap = async (playerIds: string[]): Promise<PlayerProfileMap> => {
  const profiles: PlayerProfileMap = {};
  await Promise.all(
    playerIds.map(async (playerId) => {
      const username = await getUsernameForUser(playerId);
      profiles[playerId] = { username: username ?? null };
    })
  );
  return profiles;
};

const queueKey = (mode: MatchMode, userId: string) => ({
  Mode: mode,
  UserId: userId
});

const queueTtlSeconds = () => Math.floor((Date.now() + 15 * 60 * 1000) / 1000);

const emitMatchmakingQueueEvent = async (
  mode: MatchMode,
  event: Record<string, any>
) => {
  const queueUrl = matchmakingQueueUrls[mode];
  if (!queueUrl) {
    return;
  }
  try {
    await sqs
      .sendMessage({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
          ...event,
          mode,
          timestamp: Date.now()
        }),
        MessageAttributes: {
          Mode: { DataType: 'String', StringValue: mode },
          EventType: {
            DataType: 'String',
            StringValue: event.type ?? 'unknown'
          }
        }
      })
      .promise();
  } catch (error) {
    logger.warn('[MATCHMAKING] Failed to publish matchmaking event', {
      mode,
      eventType: event.type,
      error
    });
  }
};

const listQueuedEntries = async (mode: MatchMode) => {
  const result = await dynamodb
    .query({
      TableName: MATCHMAKING_QUEUE_TABLE,
      KeyConditionExpression: '#mode = :mode',
      ExpressionAttributeValues: {
        ':mode': mode,
        ':queued': MATCHMAKING_STATE.QUEUED
      },
      ExpressionAttributeNames: {
        '#state': 'State',
        '#mode': 'Mode'
      },
      FilterExpression: '#state = :queued'
    })
    .promise();
  return (result.Items || []).map((item) => ({
    userId: item.UserId as string,
    deckId: item.DeckId ?? null,
    mmr: Number(item.MMR ?? defaultMmr),
    queuedAt: Number(item.QueuedAt ?? Date.now()),
    state: item.State as string,
    authToken: item.AuthToken ?? null
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
      KeyConditionExpression: '#mode = :mode',
      ExpressionAttributeValues: {
        ':mode': mode,
        ':queued': MATCHMAKING_STATE.QUEUED
      },
      ExpressionAttributeNames: {
        '#state': 'State',
        '#mode': 'Mode'
      },
      FilterExpression: '#state = :queued',
      Select: 'COUNT'
    })
    .promise();
  return Number(result.Count ?? 0);
};

const buildMatchmakingStatusPayload = async (userId: string, mode: MatchMode) => {
  const entry = await getQueueEntry(mode, userId);
  const queueLength = await getQueueLength(mode);
  const estimatedWaitSeconds = getEstimatedWaitSeconds(mode, queueLength);

  if (!entry) {
    const mmr = await getUserMmr(userId);
    return {
      mode,
      state: 'idle',
      queued: false,
      mmr,
      queuedAt: null,
      estimatedWaitSeconds,
      matchId: null,
      opponentId: null,
      opponentName: null,
    };
  }

  const opponentId = entry.OpponentId ?? null;
  const opponentName = await getUsernameForUser(opponentId);

  return {
    mode,
    state: entry.State || MATCHMAKING_STATE.QUEUED,
    queued: entry.State === MATCHMAKING_STATE.QUEUED,
    mmr: entry.MMR ?? (await getUserMmr(userId)),
    queuedAt: entry.QueuedAt ? new Date(entry.QueuedAt) : null,
    estimatedWaitSeconds,
    matchId: entry.MatchId ?? null,
    opponentId,
    opponentName,
  };
};

const publishMatchmakingStatusUpdate = async (userId: string, mode: MatchMode) => {
  try {
    const payload = await buildMatchmakingStatusPayload(userId, mode);
    await pubSub.publish(
      `${SubscriptionEvents.MATCHMAKING_STATUS_UPDATED}:${mode}:${userId}`,
      {
        matchmakingStatusUpdated: payload,
      }
    );
  } catch (error) {
    logger.warn('[MATCHMAKING] Failed to publish matchmaking status update', {
      userId,
      mode,
      error,
    });
  }
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
      const tolerance = mode === 'free' ? Number.POSITIVE_INFINITY : getMmrTolerance(mode, waitMs);
      if (mode === 'free' || Math.abs(a.mmr - b.mmr) <= tolerance) {
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
          const playerIds = [a.userId, b.userId];
          await Promise.all(
            playerIds.map((playerId) => publishMatchmakingStatusUpdate(playerId, mode))
          );
          const requeuePlayers = async (reason: string) => {
            const resetAt = Date.now();
            await Promise.all(
              playerIds.map(async (playerId) => {
                try {
                  await dynamodb
                    .update({
                      TableName: MATCHMAKING_QUEUE_TABLE,
                      Key: queueKey(mode, playerId),
                      ConditionExpression: '#state = :matched AND MatchId = :matchId',
                      UpdateExpression:
                        'SET #state = :queued, UpdatedAt = :now REMOVE MatchId, OpponentId',
                      ExpressionAttributeNames: {
                        '#state': 'State'
                      },
                      ExpressionAttributeValues: {
                        ':matched': MATCHMAKING_STATE.MATCHED,
                        ':queued': MATCHMAKING_STATE.QUEUED,
                        ':matchId': matchId,
                        ':now': resetAt
                      }
                    })
                    .promise();
                } catch (error) {
                  logger.warn(
                    `[MATCHMAKING] Failed to requeue player ${playerId} after ${reason}`,
                    error
                  );
                }
              })
            );
            await Promise.all(
              playerIds.map((playerId) => publishMatchmakingStatusUpdate(playerId, mode))
  );
};

          const ejectPlayersFromQueue = async (reason: string) => {
            await Promise.all(
              playerIds.map(async (playerId) => {
                try {
                  await dynamodb
                    .delete({
                      TableName: MATCHMAKING_QUEUE_TABLE,
                      Key: queueKey(mode, playerId)
                    })
                    .promise();
                  await emitMatchmakingQueueEvent(mode, {
                    type: 'exit_queue',
                    userId: playerId,
                    reason
                  });
                } catch (error) {
                  logger.warn(
                    `[MATCHMAKING] Failed to remove player ${playerId} for ${reason}`,
                    error
                  );
                }
              })
            );
            await Promise.all(
              playerIds.map((playerId) => publishMatchmakingStatusUpdate(playerId, mode))
            );
          };

          const decksByUser = new Map<string, any>();
          await Promise.all(
            playerIds.map(async (playerId) => {
              const preferredDeckId =
                playerId === a.userId ? a.deckId ?? null : playerId === b.userId ? b.deckId ?? null : null;
              const deckResult = await dynamodb
                .query({
                  TableName: decklistsTableName,
                  KeyConditionExpression: 'UserId = :userId',
                  ExpressionAttributeValues: {
                    ':userId': playerId
                  }
                })
                .promise();
              const userDecks = deckResult.Items || [];
              if (!userDecks.length) {
                return;
              }
              const chosenDeck =
                (preferredDeckId
                  ? userDecks.find((deck) => deck.DeckId === preferredDeckId)
                  : undefined) || userDecks.find((deck) => deck.IsDefault) || userDecks[0];
              if (!chosenDeck) {
                return;
              }
              const mapped = mapDecklistItem(chosenDeck);
              if (mapped) {
                decksByUser.set(playerId, mapped);
              }
            })
          );

          if (decksByUser.size !== playerIds.length) {
            logger.warn(
              `[MATCHMAKING] Missing decklists for players ${playerIds.join(
                ', '
              )}; deferring match initialization`
            );
            await requeuePlayers('missing decklists');
            continue;
          }

          const playerProfiles = await buildPlayerProfileMap(playerIds);
          const decksPayload: Record<string, any> = {};
          playerIds.forEach((playerId) => {
            decksPayload[playerId] = decksByUser.get(playerId);
          });

          const authTokenForInit = a.authToken || b.authToken || null;
          if (!authTokenForInit) {
            logger.warn(
              `[MATCHMAKING] Missing auth token for players ${playerIds.join(
                ', '
              )}; removing them from queue`
            );
            await ejectPlayersFromQueue('missing auth token');
            continue;
          }

          try {
            await spawnMatchService({
              matchId,
              player1: playerIds[0],
              player2: playerIds[1],
              decks: decksPayload,
              authToken: authTokenForInit,
              playerProfiles
            });
            await Promise.all(
              playerIds.map((playerId) => publishMatchmakingStatusUpdate(playerId, mode))
            );
          } catch (error) {
            logger.error('[MATCHMAKING] Failed to init match', error);
            await requeuePlayers('match init failure');
            continue;
          }

          return {
            matchId,
            mode,
            players: [
              { userId: a.userId, mmr: a.mmr, deckId: a.deckId },
              { userId: b.userId, mmr: b.mmr, deckId: b.deckId }
            ],
            initialized: true
          };
        } catch {
          // Entry might have been removed; continue searching
        }
      }
    }
  }

  return null;
};

export const runMatchmakingSweep = async (mode: MatchMode) => {
  let matched = false;
  while (await attemptMatch(mode)) {
    matched = true;
  }
  return matched;
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
  async match(_parent: any, { matchId }: { matchId: string }, context: ResolverContext) {
    try {
      const state = await fetchSpectatorState(matchId, context.authToken);
      if (state?.players?.length) {
        await Promise.all(state.players.map((player: MatchPlayerLike) => hydratePlayerName(player)));
      }
      return state;
    } catch (error) {
      logger.error('Error fetching match:', error);
      throw error;
    }
  },

  async playerMatch(
    _parent: any,
    { matchId, playerId }: { matchId: string; playerId: string },
    context: ResolverContext
  ) {
    try {
      const view = await fetchPlayerView(matchId, playerId, context.authToken);
      await hydratePlayerName(view?.currentPlayer);
      return view;
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
    return buildMatchmakingStatusPayload(targetUserId, normalizedMode);
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
    },
    context: ResolverContext
  ) {
    try {
      const playerProfiles = await buildPlayerProfileMap([player1, player2]);
      return await spawnMatchService({
        matchId,
        player1,
        player2,
        decks,
        authToken: context.authToken,
        playerProfiles
      });
    } catch (error) {
      logger.error('[MATCH-INIT] Error:', error);
      throw error;
    }
  },

  async submitInitiativeChoice(
    _parent: any,
    { matchId, playerId, choice }: { matchId: string; playerId: string; choice: number },
    context: ResolverContext
  ) {
    const targetUser = requireUser(context, playerId);
    try {
      await postMatchAction(
        matchId,
        'initiative',
        {
          playerId,
          choice
        },
        context.authToken
      );

      const spectatorState = await syncMatchStateFromService(matchId, context.authToken);

      logger.info(
        `[INITIATIVE] Player ${playerId} (${targetUser}) locked initiative choice ${choice} for match ${matchId}`
      );

      return spectatorState;
    } catch (error) {
      logger.error('[INITIATIVE] Error:', error);
      throw error;
    }
  },

  async submitMulligan(
    _parent: any,
    { matchId, playerId, indices }: { matchId: string; playerId: string; indices?: number[] },
    context: ResolverContext
  ) {
    const targetUser = requireUser(context, playerId);
    try {
      await postMatchAction(matchId, 'mulligan', {
        playerId,
        indices: Array.isArray(indices) ? indices : []
      }, context.authToken);

      const spectatorState = await syncMatchStateFromService(matchId, context.authToken);

      logger.info(
        `[MULLIGAN] Player ${playerId} (${targetUser}) submitted mulligan for match ${matchId}`
      );

      return spectatorState;
    } catch (error) {
      logger.error('[MULLIGAN] Error:', error);
      throw error;
    }
  },

  async selectBattlefield(
    _parent: any,
    { matchId, playerId, battlefieldId }: { matchId: string; playerId: string; battlefieldId: string },
    context: ResolverContext
  ) {
    const targetUser = requireUser(context, playerId);
    try {
      await postMatchAction(matchId, 'select-battlefield', {
        playerId,
        battlefieldId
      }, context.authToken);

      const spectatorState = await syncMatchStateFromService(matchId, context.authToken);

      logger.info(
        `[BATTLEFIELD] Player ${playerId} (${targetUser}) selected battlefield ${battlefieldId} for match ${matchId}`
      );

      return spectatorState;
    } catch (error) {
      logger.error('[SELECT-BATTLEFIELD] Error:', error);
      rethrowGraphQLError(error, 'Unable to lock battlefield selection.');
    }
  },

  async playCard(
    _parent: any,
    {
      matchId,
      playerId,
      cardIndex,
      targets,
      destinationId,
    }: {
      matchId: string;
      playerId: string;
      cardIndex: number;
      targets?: string[];
      destinationId?: string | null;
    },
    context: ResolverContext
  ) {
    requireUser(context, playerId);
    try {
      let cardSnapshot: PublishedCard | null = null;
      try {
        const playerView = await fetchPlayerView(matchId, playerId, context.authToken);
        const selectedCard = playerView?.currentPlayer?.hand?.[cardIndex];
        cardSnapshot = selectedCard
          ? {
              cardId: selectedCard.cardId ?? selectedCard.id ?? null,
              name: selectedCard.name ?? 'Card',
              cost: selectedCard.cost ?? selectedCard.energyCost ?? 0,
              power: selectedCard.power ?? 0,
              toughness: selectedCard.toughness ?? 0,
              type: selectedCard.type ?? 'Unknown',
            }
          : null;
      } catch (error) {
        logger.warn('[PLAY-CARD] Unable to snapshot card before action', {
          matchId,
          playerId,
          error,
        });
      }

      const actionResult = await postMatchAction(
        matchId,
        'play-card',
        {
          playerId,
          cardIndex,
          targets: targets ?? [],
          destinationId,
        },
        context.authToken
      );

      const spectatorState = await syncMatchStateFromService(matchId, context.authToken);
      const playerView = actionResult?.playerView ?? null;
      const runePayment = actionResult?.runePayment ?? null;

      if (cardSnapshot) {
        publishCardPlayed(matchId, {
          matchId,
          playerId,
          card: cardSnapshot,
          timestamp: new Date(),
          playerView,
          runePayment,
        });
      }

      logger.info(`[PLAY-CARD] Player ${playerId} played card in match ${matchId}`);

      return {
        success: true,
        gameState: spectatorState,
        currentPhase: spectatorState.currentPhase,
        playerView,
        runePayment,
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
      destinationId,
    }: {
      matchId: string;
      playerId: string;
      creatureInstanceId: string;
      destinationId: string;
    },
    context: ResolverContext
  ) {
    requireUser(context, playerId);
    try {
      if (!destinationId) {
        throw new Error('Battlefield destination required');
      }
      if (destinationId === 'base') {
        throw new Error('Use moveUnit to return to base');
      }
      await postMatchAction(
        matchId,
        'attack',
        {
          playerId,
          creatureInstanceId,
          destinationId,
        },
        context.authToken
      );

      const spectatorState = await syncMatchStateFromService(matchId, context.authToken);
      publishAttackDeclared(matchId, {
        matchId,
        playerId,
        creatureInstanceId,
        destinationId,
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

  async moveUnit(
    _parent: any,
    {
      matchId,
      playerId,
      creatureInstanceId,
      destinationId,
    }: {
      matchId: string;
      playerId: string;
      creatureInstanceId: string;
      destinationId: string;
    },
    context: ResolverContext
  ) {
    requireUser(context, playerId);
    try {
      await postMatchAction(
        matchId,
        'move',
        {
          playerId,
          creatureInstanceId,
          destinationId,
        },
        context.authToken
      );

      const spectatorState = await syncMatchStateFromService(matchId, context.authToken);

      return {
        success: true,
        gameState: spectatorState,
        currentPhase: spectatorState.currentPhase,
      };
    } catch (error: any) {
      logger.error('[MOVE-UNIT] Error:', error);
      throw error;
    }
  },

  async recordDuelLogEntry(
    _parent: any,
    {
      matchId,
      playerId,
      message,
      tone,
      entryId,
      actorName,
    }: {
      matchId: string;
      playerId: string;
      message: string;
      tone?: string | null;
      entryId?: string | null;
      actorName?: string | null;
    },
    context: ResolverContext
  ) {
    const normalizedMessage = (message ?? '').trim();
    if (!normalizedMessage) {
      throw new GraphQLError('Log message is required.');
    }
    requireUser(context);
    try {
      await postMatchAction(
        matchId,
        'duel-log',
        {
          playerId,
          message: normalizedMessage,
          tone,
          entryId,
          actorName
        },
        context.authToken
      );

      const spectatorState = await syncMatchStateFromService(matchId, context.authToken);

      return {
        success: true,
        gameState: spectatorState,
        currentPhase: spectatorState.currentPhase
      };
    } catch (error: any) {
      logger.error('[DUEL-LOG] Error:', error);
      throw error;
    }
  },

  async sendChatMessage(
    _parent: any,
    {
      matchId,
      playerId,
      message,
    }: {
      matchId: string;
      playerId: string;
      message: string;
    },
    context: ResolverContext
  ) {
    const normalizedMessage = (message ?? '').trim();
    if (!normalizedMessage) {
      throw new GraphQLError('Message cannot be empty.');
    }
    requireUser(context, playerId);
    try {
      await postChatMessage(
        matchId,
        {
          playerId,
          message: normalizedMessage
        },
        context.authToken
      );

      const spectatorState = await syncMatchStateFromService(matchId, context.authToken);

      return {
        success: true,
        gameState: spectatorState,
        currentPhase: spectatorState.currentPhase
      };
    } catch (error: any) {
      logger.error('[CHAT] Error:', error);
      throw error;
    }
  },

  async nextPhase(
    _parent: any,
    { matchId, playerId }: { matchId: string; playerId: string },
    context: ResolverContext
  ) {
    requireUser(context, playerId);
    try {
      await postMatchAction(
        matchId,
        'next-phase',
        {
          playerId,
        },
        context.authToken
      );

      const spectatorState = await syncMatchStateFromService(matchId, context.authToken);
      publishPhaseChange(matchId, {
        matchId,
        newPhase: spectatorState.currentPhase,
        turnNumber: spectatorState.turnNumber,
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
    { matchId, winner, reason }: { matchId: string; winner: string; reason: string },
    context: ResolverContext
  ) {
    try {
      const response = await internalApiRequest<{
        success: boolean;
        matchResult: any;
      }>(
        `/matches/${matchId}/result`,
        {
          method: 'POST',
          body: JSON.stringify({ winner, reason }),
        },
        context.authToken
      );

      publishMatchCompletion(matchId, response.matchResult);

      logger.info(`[MATCH-COMPLETE] Match ${matchId} completed. Winner: ${winner}`);

      return {
        success: response.success,
        matchResult: response.matchResult,
      };
    } catch (error) {
      logger.error('[RESULT] Error:', error);
      throw error;
    }
  },

  async concedeMatch(
    _parent: any,
    { matchId, playerId }: { matchId: string; playerId: string },
    context: ResolverContext
  ) {
    try {
      const response = await internalApiRequest<{
        success: boolean;
        matchResult: any;
      }>(
        `/matches/${matchId}/concede`,
        {
          method: 'POST',
          body: JSON.stringify({ playerId }),
        },
        context.authToken
      );

      publishMatchCompletion(matchId, response.matchResult);

      logger.info(
        `[MATCH-CONCEDE] Match ${matchId} ended. Winner: ${response.matchResult.winner}`
      );

      return {
        success: response.success,
        matchResult: response.matchResult,
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
        const existingOpponentId = existing.OpponentId ?? null;
        const existingOpponentName = existingOpponentId
          ? await getUsernameForUser(existingOpponentId)
          : null;
        return {
          mode: normalizedMode,
          queued: false,
          matchFound: true,
          matchId: existing.MatchId ?? null,
          opponentId: existingOpponentId,
          opponentName: existingOpponentName,
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
            AuthToken: context.authToken ?? null,
            ExpiresAt: queueTtlSeconds()
          }
        })
        .promise();
      await emitMatchmakingQueueEvent(normalizedMode, {
        type: 'join_queue',
        userId,
        deckId: input.deckId ?? null,
        mmr,
        queuedAt: now
      });
      await publishMatchmakingStatusUpdate(userId, normalizedMode);

      const queueLength = await getQueueLength(normalizedMode);
      const estimatedWaitSeconds = getEstimatedWaitSeconds(normalizedMode, queueLength);
      const entry = await getQueueEntry(normalizedMode, userId);
      const state = entry?.State ?? MATCHMAKING_STATE.QUEUED;
      const matchId = entry?.MatchId ?? null;
      const opponentId = entry?.OpponentId ?? null;
      const opponentName = opponentId ? await getUsernameForUser(opponentId) : null;

      return {
        mode: normalizedMode,
        queued: state === MATCHMAKING_STATE.QUEUED,
        matchFound: state === MATCHMAKING_STATE.MATCHED,
        matchId,
        opponentId,
        opponentName,
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
      await emitMatchmakingQueueEvent(normalizedMode, {
        type: 'leave_queue',
        userId
      });
      await publishMatchmakingStatusUpdate(userId, normalizedMode);
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

  matchmakingStatusUpdated: {
    subscribe: (_parent: any, { userId, mode }: { userId: string; mode: MatchMode }) => {
      const normalizedMode = normalizeMatchMode(mode);
      return pubSub.asyncIterator([
        `${SubscriptionEvents.MATCHMAKING_STATUS_UPDATED}:${normalizedMode}:${userId}`,
      ]);
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
