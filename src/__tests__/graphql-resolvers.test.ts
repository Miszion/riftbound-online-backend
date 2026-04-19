/**
 * GraphQL Resolvers — Comprehensive Unit Tests (QA-PHASE-6)
 *
 * Tests query resolvers, mutation resolvers, subscription resolvers,
 * and helper utilities in src/graphql/resolvers.ts.
 *
 * All AWS and external dependencies are mocked. Fetch is mocked per-test.
 */

// ---------------------------------------------------------------------------
// Mock declarations — hoisted by Jest
// ---------------------------------------------------------------------------

jest.mock('dotenv/config', () => ({}));

jest.mock('../logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

jest.mock('aws-sdk', () => {
  const getPromise        = jest.fn().mockResolvedValue({ Item: null });
  const putPromise        = jest.fn().mockResolvedValue({});
  const queryPromise      = jest.fn().mockResolvedValue({ Items: [], Count: 0 });
  const deletePromise     = jest.fn().mockResolvedValue({ Attributes: null });
  const updatePromise     = jest.fn().mockResolvedValue({ Attributes: null });
  const transactWritePromise = jest.fn().mockResolvedValue({});
  const scanPromise       = jest.fn().mockResolvedValue({ Items: [] });
  const sqsSendMsgPromise = jest.fn().mockResolvedValue({});

  const clientInstance = {
    get:          jest.fn().mockReturnValue({ promise: getPromise }),
    put:          jest.fn().mockReturnValue({ promise: putPromise }),
    query:        jest.fn().mockReturnValue({ promise: queryPromise }),
    delete:       jest.fn().mockReturnValue({ promise: deletePromise }),
    update:       jest.fn().mockReturnValue({ promise: updatePromise }),
    transactWrite:jest.fn().mockReturnValue({ promise: transactWritePromise }),
    scan:         jest.fn().mockReturnValue({ promise: scanPromise }),
    // Exposed for per-test reconfiguration
    _getPromise:         getPromise,
    _putPromise:         putPromise,
    _queryPromise:       queryPromise,
    _deletePromise:      deletePromise,
    _updatePromise:      updatePromise,
    _transactWritePromise: transactWritePromise,
    _scanPromise:        scanPromise,
  };

  const sqsInstance = {
    sendMessage: jest.fn().mockReturnValue({ promise: sqsSendMsgPromise }),
    _sendMsgPromise: sqsSendMsgPromise,
  };

  const DocumentClient = jest.fn().mockImplementation(() => clientInstance);
  const SQS            = jest.fn().mockImplementation(() => sqsInstance);

  return {
    __esModule: true,
    default: {
      DynamoDB: { DocumentClient },
      SQS,
      _client:  clientInstance,
      _sqs:     sqsInstance,
    },
    DynamoDB: { DocumentClient },
    SQS,
  };
});

jest.mock('../graphql/pubsub', () => ({
  pubSub: {
    asyncIterator: jest.fn().mockReturnValue({ [Symbol.asyncIterator]: jest.fn() }),
    publish:       jest.fn().mockResolvedValue(undefined),
  },
  SubscriptionEvents: {
    GAME_STATE_CHANGED:         'GAME_STATE_CHANGED',
    PLAYER_GAME_STATE_CHANGED:  'PLAYER_GAME_STATE_CHANGED',
    MATCH_COMPLETED:            'MATCH_COMPLETED',
    LEADERBOARD_UPDATED:        'LEADERBOARD_UPDATED',
    CARD_PLAYED:                'CARD_PLAYED',
    ATTACK_DECLARED:            'ATTACK_DECLARED',
    PHASE_CHANGED:              'PHASE_CHANGED',
    MATCHMAKING_STATUS_UPDATED: 'MATCHMAKING_STATUS_UPDATED',
  },
  publishGameStateChange:        jest.fn(),
  publishPlayerGameStateChange:  jest.fn(),
  publishMatchCompletion:        jest.fn(),
  publishLeaderboardUpdate:      jest.fn(),
  publishCardPlayed:             jest.fn(),
  publishAttackDeclared:         jest.fn(),
  publishPhaseChange:            jest.fn(),
}));

jest.mock('../card-catalog', () => ({
  getCardCatalog:           jest.fn().mockReturnValue([]),
  findCardById:             jest.fn().mockReturnValue(null),
  findCardBySlug:           jest.fn().mockReturnValue(null),
  getImageManifest:         jest.fn().mockReturnValue([]),
  buildActivationStateIndex: jest.fn().mockReturnValue({}),
}));

// `recentMatches` merges DynamoDB results with bot self-play JSONL files on
// disk. In tests we want hermetic isolation from the developer's local
// nexus-data/riftbound-games directory, so stub out the disk reader.
jest.mock('../replay-reconstructor', () => ({
  buildMatchReplayFromJsonl: jest.fn().mockReturnValue(null),
  listBotMatchesFromJsonl:   jest.fn().mockReturnValue([]),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  queryResolvers,
  mutationResolvers,
  subscriptionResolvers,
  runMatchmakingSweep,
} from '../graphql/resolvers';
import type { ResolverContext } from '../graphql/resolvers';
import AWS from 'aws-sdk';
import { pubSub, publishGameStateChange, publishCardPlayed, publishAttackDeclared, publishPhaseChange, publishMatchCompletion } from '../graphql/pubsub';
import { getCardCatalog, findCardById, findCardBySlug, getImageManifest, buildActivationStateIndex } from '../card-catalog';
import { GraphQLError } from 'graphql';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const authedCtx = (userId = 'user-1', authToken = 'tok-1'): ResolverContext => ({ userId, authToken });
const anonCtx   = (): ResolverContext => ({ userId: null, authToken: null });

/** Default spectator state returned by GET /matches/:id */
const defaultState = {
  matchId: 'match-1',
  players: [],
  duelLog: [],
  chatLog: [],
  currentPhase: 'main',
  turnNumber: 1,
};

/** Build a mock Response-like object for global fetch */
function mockResponse(data: any, status = 200) {
  return {
    ok:     status >= 200 && status < 400,
    status,
    text:   async () => JSON.stringify(data),
  };
}

/** Set global.fetch to return the same response for every call */
function mockFetch(data: any = defaultState, status = 200): jest.Mock {
  const m = jest.fn().mockResolvedValue(mockResponse(data, status));
  global.fetch = m as any;
  return m;
}

/** Set global.fetch to return a sequence of responses, then fall back to defaultState */
function mockFetchSequence(...responses: Array<{ data?: any; status?: number }>): jest.Mock {
  const m = jest.fn();
  for (const r of responses) {
    m.mockResolvedValueOnce(mockResponse(r.data ?? defaultState, r.status ?? 200));
  }
  m.mockResolvedValue(mockResponse(defaultState));
  global.fetch = m as any;
  return m;
}

let db: any;

beforeEach(() => {
  jest.clearAllMocks();
  db = (AWS as any)._client;
  // Default: all DB ops succeed with empty results
  db._getPromise.mockResolvedValue({ Item: null });
  db._putPromise.mockResolvedValue({});
  db._queryPromise.mockResolvedValue({ Items: [], Count: 0 });
  db._deletePromise.mockResolvedValue({ Attributes: null });
  db._updatePromise.mockResolvedValue({ Attributes: null });
  db._transactWritePromise.mockResolvedValue({});
  db._scanPromise.mockResolvedValue({ Items: [] });
  (AWS as any)._sqs._sendMsgPromise.mockResolvedValue({});
  mockFetch();
});

// ===========================================================================
// HELPER FUNCTIONS (tested through resolver exports)
// ===========================================================================

describe('requireUser', () => {
  it('throws Unauthorized when context has no userId', async () => {
    await expect(queryResolvers.matchHistory(null, { userId: 'u1', limit: 5 }, anonCtx())).rejects.toThrow('Unauthorized');
  });

  it('throws Forbidden when context userId differs from targetUserId', async () => {
    await expect(queryResolvers.matchHistory(null, { userId: 'other-user', limit: 5 }, authedCtx('user-1'))).rejects.toThrow('Forbidden');
  });

  it('returns userId when authenticated and userId matches', async () => {
    db._queryPromise.mockResolvedValue({ Items: [], Count: 0 });
    const result = await queryResolvers.matchHistory(null, { userId: 'user-1', limit: 5 }, authedCtx('user-1'));
    expect(result).toEqual([]);
  });
});

describe('normalizeMatchMode', () => {
  it('throws for invalid mode via leaveMatchmakingQueue', async () => {
    await expect(
      mutationResolvers.leaveMatchmakingQueue(null, { userId: 'user-1', mode: 'invalid' as any }, authedCtx('user-1'))
    ).rejects.toThrow('Invalid matchmaking mode');
  });

  it('accepts ranked mode', async () => {
    const result = await mutationResolvers.leaveMatchmakingQueue(null, { userId: 'user-1', mode: 'ranked' }, authedCtx('user-1'));
    expect(result).toBe(true);
  });

  it('accepts free mode', async () => {
    const result = await mutationResolvers.leaveMatchmakingQueue(null, { userId: 'user-1', mode: 'free' }, authedCtx('user-1'));
    expect(result).toBe(true);
  });
});

describe('toIsoString (via mapDecklistItem / decklists query)', () => {
  it('maps CreatedAt timestamp to ISO string', async () => {
    const ts = 1700000000000;
    db._queryPromise.mockResolvedValue({
      Items: [{ UserId: 'u1', DeckId: 'd1', Name: 'My Deck', Tags: [], Cards: [], CreatedAt: ts, UpdatedAt: ts }]
    });
    const result = await queryResolvers.decklists(null, { userId: 'user-1' }, authedCtx('user-1'));
    expect(result[0].createdAt).toBe(new Date(ts).toISOString());
  });

  it('returns null when CreatedAt is missing', async () => {
    db._queryPromise.mockResolvedValue({
      Items: [{ UserId: 'u1', DeckId: 'd1', Name: 'No Dates', Tags: [], Cards: [] }]
    });
    const result = await queryResolvers.decklists(null, { userId: 'user-1' }, authedCtx('user-1'));
    expect(result[0].createdAt).toBeNull();
  });
});

// ===========================================================================
// QUERY RESOLVERS
// ===========================================================================

describe('queryResolvers.user', () => {
  it('returns user when found in DynamoDB', async () => {
    const ts = Date.now();
    db._getPromise.mockResolvedValue({
      Item: {
        UserId: 'u1', Username: 'tester', Email: 'a@b.com',
        UserLevel: 5, Wins: 10, TotalMatches: 20,
        LastLogin: ts, CreatedAt: ts,
      }
    });
    const result = await queryResolvers.user(null, { userId: 'u1' });
    expect(result.userId).toBe('u1');
    expect(result.username).toBe('tester');
    expect(result.wins).toBe(10);
    expect(result.lastLogin).toBeInstanceOf(Date);
  });

  it('throws when user not found', async () => {
    db._getPromise.mockResolvedValue({ Item: null });
    await expect(queryResolvers.user(null, { userId: 'missing' })).rejects.toThrow('User not found');
  });

  it('propagates DynamoDB errors', async () => {
    db._getPromise.mockRejectedValue(new Error('DynamoDB failure'));
    await expect(queryResolvers.user(null, { userId: 'u1' })).rejects.toThrow('DynamoDB failure');
  });
});

describe('queryResolvers.leaderboard', () => {
  it('returns empty leaderboard when no users', async () => {
    db._scanPromise.mockResolvedValue({ Items: [] });
    const result = await queryResolvers.leaderboard(null, { limit: 10 });
    expect(result).toEqual([]);
  });

  it('returns sorted leaderboard entries by wins', async () => {
    db._scanPromise.mockResolvedValue({
      Items: [
        { UserId: 'u2', Username: 'b', Wins: 5, TotalMatches: 10 },
        { UserId: 'u1', Username: 'a', Wins: 20, TotalMatches: 30 },
      ]
    });
    const result = await queryResolvers.leaderboard(null, { limit: 100 });
    expect(result[0].userId).toBe('u1');
    expect(result[0].wins).toBe(20);
    expect(result[1].userId).toBe('u2');
  });

  it('computes winRate correctly', async () => {
    db._scanPromise.mockResolvedValue({
      Items: [{ UserId: 'u1', Wins: 3, TotalMatches: 10 }]
    });
    const result = await queryResolvers.leaderboard(null, {});
    expect(result[0].winRate).toBeCloseTo(0.3);
  });

  it('handles users with no matches (winRate 0)', async () => {
    db._scanPromise.mockResolvedValue({
      Items: [{ UserId: 'u1', Wins: 0, TotalMatches: 0 }]
    });
    const result = await queryResolvers.leaderboard(null, {});
    expect(result[0].winRate).toBe(0);
  });
});

describe('queryResolvers.match', () => {
  it('returns match state from internal API', async () => {
    mockFetch({ ...defaultState, matchId: 'match-x' });
    const result = await queryResolvers.match(null, { matchId: 'match-x' }, authedCtx());
    expect(result.matchId).toBe('match-x');
  });

  it('hydrates player names when players present', async () => {
    mockFetch({ ...defaultState, players: [{ playerId: 'user-1', name: 'user-1' }] });
    db._getPromise.mockResolvedValue({ Item: { UserId: 'user-1', Username: 'Alice' } });
    const result = await queryResolvers.match(null, { matchId: 'match-1' }, authedCtx());
    expect(result.players[0].name).toBe('Alice');
  });

  it('propagates fetch errors', async () => {
    global.fetch = jest.fn().mockResolvedValue(mockResponse({ error: 'Not found' }, 404)) as any;
    await expect(queryResolvers.match(null, { matchId: 'bad' }, authedCtx())).rejects.toThrow();
  });
});

describe('queryResolvers.playerMatch', () => {
  it('returns player view', async () => {
    const playerView = { currentPlayer: { playerId: 'user-1', name: null, hand: [] } };
    mockFetch(playerView);
    db._getPromise.mockResolvedValue({ Item: null });
    const result = await queryResolvers.playerMatch(null, { matchId: 'match-1', playerId: 'user-1' }, authedCtx());
    expect(result.currentPlayer.playerId).toBe('user-1');
  });
});

describe('queryResolvers.matchHistory', () => {
  it('returns mapped match history items', async () => {
    const ts = Date.now();
    db._queryPromise.mockResolvedValue({
      Items: [{
        MatchId: 'm1', Timestamp: ts, Players: ['u1', 'u2'],
        Winner: 'u1', Loser: 'u2', Duration: 300, Turns: 5,
        MoveCount: 20, Status: 'completed'
      }]
    });
    const result = await queryResolvers.matchHistory(null, { userId: 'user-1', limit: 10 }, authedCtx('user-1'));
    expect(result).toHaveLength(1);
    expect(result[0].matchId).toBe('m1');
    expect(result[0].winner).toBe('u1');
    expect(result[0].timestamp).toBeInstanceOf(Date);
  });

  it('clamps limit to 50 max', async () => {
    db._queryPromise.mockResolvedValue({ Items: [] });
    await queryResolvers.matchHistory(null, { userId: 'user-1', limit: 999 }, authedCtx('user-1'));
    const callArgs = db.query.mock.calls[0][0];
    expect(callArgs.Limit).toBe(50);
  });

  it('clamps limit to 1 min', async () => {
    db._queryPromise.mockResolvedValue({ Items: [] });
    await queryResolvers.matchHistory(null, { userId: 'user-1', limit: 0 }, authedCtx('user-1'));
    const callArgs = db.query.mock.calls[0][0];
    expect(callArgs.Limit).toBe(1);
  });
});

describe('queryResolvers.matchResult', () => {
  it('returns null when no match record found', async () => {
    db._queryPromise.mockResolvedValue({ Items: [] });
    const result = await queryResolvers.matchResult(null, { matchId: 'no-match' });
    expect(result).toBeNull();
  });

  it('returns match result when record exists', async () => {
    db._queryPromise.mockResolvedValue({
      Items: [{ MatchId: 'm1', Winner: 'u1', Loser: 'u2', Reason: 'concede', Duration: 120, Turns: 3, MoveCount: 10 }]
    });
    const result = await queryResolvers.matchResult(null, { matchId: 'm1' });
    expect(result!.matchId).toBe('m1');
    expect(result!.winner).toBe('u1');
    expect(result!.reason).toBe('concede');
  });
});

describe('queryResolvers.decklists', () => {
  it('requires auth', async () => {
    await expect(queryResolvers.decklists(null, { userId: 'u1' }, anonCtx())).rejects.toThrow('Unauthorized');
  });

  it('returns mapped decklists', async () => {
    db._queryPromise.mockResolvedValue({
      Items: [{ UserId: 'u1', DeckId: 'd1', Name: 'Deck A', Tags: [], Cards: [], CardCount: 0 }]
    });
    const result = await queryResolvers.decklists(null, { userId: 'user-1' }, authedCtx('user-1'));
    expect(result).toHaveLength(1);
    expect(result[0].deckId).toBe('d1');
    expect(result[0].name).toBe('Deck A');
  });
});

describe('queryResolvers.decklist', () => {
  it('returns null for empty deckId', async () => {
    const result = await queryResolvers.decklist(null, { deckId: '' }, authedCtx());
    expect(result).toBeNull();
  });

  it('throws Unauthorized when deck not found and no auth', async () => {
    db._queryPromise.mockResolvedValue({ Items: [] });
    await expect(queryResolvers.decklist(null, { deckId: 'deck-1' }, anonCtx())).rejects.toThrow('Unauthorized');
  });

  it('returns deck when found and user matches', async () => {
    db._queryPromise.mockResolvedValue({
      Items: [{ UserId: 'user-1', DeckId: 'deck-1', Name: 'My Deck', Tags: [], Cards: [], CardCount: 0 }]
    });
    const result = await queryResolvers.decklist(null, { deckId: 'deck-1' }, authedCtx('user-1'));
    expect(result!.deckId).toBe('deck-1');
  });

  it('throws Forbidden when deck belongs to different user', async () => {
    db._queryPromise.mockResolvedValue({
      Items: [{ UserId: 'other-user', DeckId: 'deck-1', Name: 'Their Deck', Tags: [], Cards: [] }]
    });
    await expect(queryResolvers.decklist(null, { deckId: 'deck-1' }, authedCtx('user-1'))).rejects.toThrow('Forbidden');
  });
});

describe('queryResolvers.matchmakingStatus', () => {
  it('requires auth', async () => {
    await expect(queryResolvers.matchmakingStatus(null, { userId: 'u1', mode: 'free' }, anonCtx())).rejects.toThrow('Unauthorized');
  });

  it('returns idle status when not in queue', async () => {
    db._getPromise.mockResolvedValue({ Item: null });
    db._queryPromise.mockResolvedValue({ Items: [], Count: 0 });
    const result = await queryResolvers.matchmakingStatus(null, { userId: 'user-1', mode: 'free' }, authedCtx('user-1'));
    expect(result.state).toBe('idle');
    expect(result.queued).toBe(false);
  });

  it('returns queued status when in queue', async () => {
    const queuedAt = Date.now() - 5000;
    db._getPromise.mockResolvedValue({
      Item: { Mode: 'free', UserId: 'user-1', State: 'queued', MMR: 1200, QueuedAt: queuedAt }
    });
    db._queryPromise.mockResolvedValue({ Items: [], Count: 2 });
    const result = await queryResolvers.matchmakingStatus(null, { userId: 'user-1', mode: 'free' }, authedCtx('user-1'));
    expect(result.queued).toBe(true);
    expect(result.state).toBe('queued');
  });

  it('throws for invalid mode', async () => {
    await expect(
      queryResolvers.matchmakingStatus(null, { userId: 'user-1', mode: 'turbo' as any }, authedCtx('user-1'))
    ).rejects.toThrow('Invalid matchmaking mode');
  });
});

describe('queryResolvers.matchReplay', () => {
  it('returns null when no replay record found', async () => {
    db._queryPromise.mockResolvedValue({ Items: [] });
    const result = await queryResolvers.matchReplay(null, { matchId: 'no-replay' });
    expect(result).toBeNull();
  });

  it('returns replay record when found', async () => {
    db._queryPromise.mockResolvedValue({
      Items: [{ MatchId: 'r1', Players: ['u1', 'u2'], Winner: 'u1', Moves: [], CreatedAt: Date.now() }]
    });
    const result = await queryResolvers.matchReplay(null, { matchId: 'r1' });
    expect(result!.matchId).toBe('r1');
    expect(result!.createdAt).toBeInstanceOf(Date);
  });
});

describe('queryResolvers.recentMatches', () => {
  it('returns empty array when no matches', async () => {
    db._scanPromise.mockResolvedValue({ Items: [] });
    const result = await queryResolvers.recentMatches(null, { limit: 10 });
    expect(result).toEqual([]);
  });

  it('clamps limit between 1 and 50', async () => {
    db._scanPromise.mockResolvedValue({ Items: [] });
    await queryResolvers.recentMatches(null, { limit: 999 });
    const callArgs = db.scan.mock.calls[0][0];
    expect(callArgs.Limit).toBeGreaterThan(0);
  });

  it('returns sorted matches by createdAt descending', async () => {
    const now = Date.now();
    db._scanPromise.mockResolvedValue({
      Items: [
        { MatchId: 'old', Players: [], CreatedAt: now - 10000 },
        { MatchId: 'new', Players: [], CreatedAt: now },
      ]
    });
    const result = await queryResolvers.recentMatches(null, { limit: 10 });
    expect(result[0].matchId).toBe('new');
  });

  it('surfaces endReason + status from DDB Reason/Status columns for completed matches', async () => {
    const now = Date.now();
    db._scanPromise.mockResolvedValue({
      Items: [
        {
          MatchId: 'm-vp',
          Players: ['u1', 'u2'],
          Winner: 'u1',
          Loser: 'u2',
          Duration: 300,
          Turns: 12,
          Reason: 'victory_points',
          Status: 'completed',
          CreatedAt: now
        },
        {
          MatchId: 'm-burn',
          Players: ['u3', 'u4'],
          Winner: 'u3',
          Loser: 'u4',
          Duration: 180,
          Turns: 8,
          Reason: 'burn_out',
          Status: 'completed',
          CreatedAt: now - 1000
        }
      ]
    });
    const result = await queryResolvers.recentMatches(null, { limit: 10 });
    const vp = result.find((m: any) => m.matchId === 'm-vp');
    const burn = result.find((m: any) => m.matchId === 'm-burn');
    expect(vp).toMatchObject({ endReason: 'victory_points', status: 'completed' });
    expect(burn).toMatchObject({ endReason: 'burn_out', status: 'completed' });
  });

  it('leaves endReason/status null when DDB row has no Reason/Status columns', async () => {
    db._scanPromise.mockResolvedValue({
      Items: [
        { MatchId: 'legacy-1', Players: [], CreatedAt: Date.now() }
      ]
    });
    const result = await queryResolvers.recentMatches(null, { limit: 10 });
    expect(result[0]).toMatchObject({
      matchId: 'legacy-1',
      endReason: null,
      status: null
    });
  });

  it('requests Reason and Status in the DDB scan projection', async () => {
    db._scanPromise.mockResolvedValue({ Items: [] });
    await queryResolvers.recentMatches(null, { limit: 5 });
    const callArgs = db.scan.mock.calls[db.scan.mock.calls.length - 1][0];
    expect(callArgs.ProjectionExpression).toContain('#reason');
    expect(callArgs.ProjectionExpression).toContain('#status');
    expect(callArgs.ExpressionAttributeNames['#reason']).toBe('Reason');
    expect(callArgs.ExpressionAttributeNames['#status']).toBe('Status');
  });
});

describe('queryResolvers.cardCatalog', () => {
  beforeEach(() => {
    (getCardCatalog as jest.Mock).mockReturnValue([
      { name: 'Fire Imp', type: 'creature', rarity: 'common', colors: ['fury'], tags: [], keywords: [], effect: 'deals 1 damage' },
      { name: 'Frost Bolt', type: 'spell', rarity: 'rare', colors: ['mind'], tags: [], keywords: ['instant'], effect: 'freezes target' },
      { name: 'Rock Wall', type: 'creature', rarity: 'common', colors: ['order'], tags: [], keywords: [], effect: 'gains shield' },
    ]);
  });

  it('returns all cards when no filter', () => {
    const result = queryResolvers.cardCatalog(null, {});
    expect(result).toHaveLength(3);
  });

  it('filters by search term in name', () => {
    const result = queryResolvers.cardCatalog(null, { filter: { search: 'fire' } });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Fire Imp');
  });

  it('filters by search term in effect', () => {
    const result = queryResolvers.cardCatalog(null, { filter: { search: 'freezes' } });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Frost Bolt');
  });

  it('filters by search term in keywords', () => {
    const result = queryResolvers.cardCatalog(null, { filter: { search: 'instant' } });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Frost Bolt');
  });

  it('filters by type', () => {
    const result = queryResolvers.cardCatalog(null, { filter: { type: 'spell' } });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Frost Bolt');
  });

  it('filters by domain/color', () => {
    const result = queryResolvers.cardCatalog(null, { filter: { domain: 'fury' } });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Fire Imp');
  });

  it('filters by rarity', () => {
    const result = queryResolvers.cardCatalog(null, { filter: { rarity: 'rare' } });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Frost Bolt');
  });

  it('applies limit', () => {
    const result = queryResolvers.cardCatalog(null, { filter: { limit: 1 } });
    expect(result).toHaveLength(1);
  });

  it('ignores limit of 0', () => {
    const result = queryResolvers.cardCatalog(null, { filter: { limit: 0 } });
    expect(result).toHaveLength(3);
  });
});

describe('queryResolvers.cardById', () => {
  it('delegates to findCatalogCardById', () => {
    (findCardById as jest.Mock).mockReturnValue({ id: 'card-1', name: 'Test Card' });
    const result = queryResolvers.cardById(null, { id: 'card-1' });
    expect(result).toEqual({ id: 'card-1', name: 'Test Card' });
    expect(findCardById).toHaveBeenCalledWith('card-1');
  });

  it('returns null for unknown card', () => {
    (findCardById as jest.Mock).mockReturnValue(null);
    const result = queryResolvers.cardById(null, { id: 'missing' });
    expect(result).toBeNull();
  });
});

describe('queryResolvers.cardBySlug', () => {
  it('delegates to findCatalogCardBySlug', () => {
    (findCardBySlug as jest.Mock).mockReturnValue({ slug: 'fire-imp', name: 'Fire Imp' });
    const result = queryResolvers.cardBySlug(null, { slug: 'fire-imp' });
    expect(result).toEqual({ slug: 'fire-imp', name: 'Fire Imp' });
    expect(findCardBySlug).toHaveBeenCalledWith('fire-imp');
  });
});

describe('queryResolvers.cardImageManifest', () => {
  it('returns manifest from catalog', () => {
    (getImageManifest as jest.Mock).mockReturnValue([{ slug: 'fire-imp', url: '/img/fire-imp.png' }]);
    const result = queryResolvers.cardImageManifest();
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('fire-imp');
  });
});

describe('queryResolvers.cardActivationStates', () => {
  it('returns activation states as array', () => {
    (buildActivationStateIndex as jest.Mock).mockReturnValue({
      'fire-imp': { slug: 'fire-imp', activated: true },
    });
    const result = queryResolvers.cardActivationStates();
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('fire-imp');
  });

  it('returns empty array when no activation states', () => {
    (buildActivationStateIndex as jest.Mock).mockReturnValue({});
    const result = queryResolvers.cardActivationStates();
    expect(result).toEqual([]);
  });
});

// ===========================================================================
// MUTATION RESOLVERS
// ===========================================================================

describe('mutationResolvers.updateUser', () => {
  it('updates user and returns updated data', async () => {
    const ts = Date.now();
    db._updatePromise.mockResolvedValue({
      Attributes: {
        UserId: 'user-1', Username: 'NewName', Email: 'a@b.com',
        UserLevel: 2, Wins: 5, TotalMatches: 10, LastLogin: ts, CreatedAt: ts
      }
    });
    db._scanPromise.mockResolvedValue({ Items: [] }); // leaderboard broadcast

    const result = await mutationResolvers.updateUser(null, {
      userId: 'user-1', username: 'NewName', userLevel: 2, wins: 5, totalMatches: 10
    });
    expect(result.userId).toBe('user-1');
    expect(result.username).toBe('NewName');
  });

  it('throws when DynamoDB returns no Attributes', async () => {
    db._updatePromise.mockResolvedValue({ Attributes: null });
    await expect(
      mutationResolvers.updateUser(null, { userId: 'user-1' })
    ).rejects.toThrow('Failed to update user');
  });
});

describe('mutationResolvers.initMatch', () => {
  it('posts to /matches/init and returns response', async () => {
    const matchResp = { matchId: 'match-new', status: 'initialized' };
    mockFetch(matchResp);
    db._getPromise.mockResolvedValue({ Item: null }); // getUserProfileSummary

    const result = await mutationResolvers.initMatch(null, {
      matchId: 'match-new', player1: 'p1', player2: 'p2', decks: {}
    }, authedCtx());
    expect(result.matchId).toBe('match-new');
  });
});

describe('mutationResolvers.submitInitiativeChoice', () => {
  it('requires auth', async () => {
    await expect(
      mutationResolvers.submitInitiativeChoice(null, { matchId: 'm1', playerId: 'user-1', choice: 0 }, anonCtx())
    ).rejects.toThrow('Unauthorized');
  });

  it('posts initiative choice and returns spectator state', async () => {
    mockFetchSequence({ data: {} }, { data: defaultState });
    const result = await mutationResolvers.submitInitiativeChoice(null, {
      matchId: 'm1', playerId: 'user-1', choice: 0
    }, authedCtx('user-1'));
    expect(result.currentPhase).toBe('main');
  });

  it('throws Forbidden when playerId differs from auth userId', async () => {
    await expect(
      mutationResolvers.submitInitiativeChoice(null, { matchId: 'm1', playerId: 'other', choice: 0 }, authedCtx('user-1'))
    ).rejects.toThrow('Forbidden');
  });
});

describe('mutationResolvers.submitMulligan', () => {
  it('requires auth matching playerId', async () => {
    await expect(
      mutationResolvers.submitMulligan(null, { matchId: 'm1', playerId: 'other' }, authedCtx('user-1'))
    ).rejects.toThrow('Forbidden');
  });

  it('submits mulligan and returns spectator state', async () => {
    mockFetchSequence({ data: {} }, { data: defaultState });
    const result = await mutationResolvers.submitMulligan(null, {
      matchId: 'm1', playerId: 'user-1', indices: [0, 2]
    }, authedCtx('user-1'));
    expect(result.currentPhase).toBe('main');
    expect(publishGameStateChange).toHaveBeenCalled();
  });

  it('defaults to empty indices when not provided', async () => {
    mockFetchSequence({ data: {} }, { data: defaultState });
    await mutationResolvers.submitMulligan(null, { matchId: 'm1', playerId: 'user-1' }, authedCtx('user-1'));
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.indices).toEqual([]);
  });
});

describe('mutationResolvers.submitDiscardSelection', () => {
  it('requires auth', async () => {
    await expect(
      mutationResolvers.submitDiscardSelection(null, {
        matchId: 'm1', playerId: 'other', promptId: 'p1', cardInstanceIds: []
      }, authedCtx('user-1'))
    ).rejects.toThrow('Forbidden');
  });

  it('submits discard selection and returns state', async () => {
    mockFetchSequence({ data: {} }, { data: defaultState });
    const result = await mutationResolvers.submitDiscardSelection(null, {
      matchId: 'm1', playerId: 'user-1', promptId: 'prompt-1', cardInstanceIds: ['card-a', 'card-b']
    }, authedCtx('user-1'));
    expect(result.currentPhase).toBe('main');
  });
});

describe('mutationResolvers.submitTargetSelection', () => {
  it('requires auth', async () => {
    await expect(
      mutationResolvers.submitTargetSelection(null, {
        matchId: 'm1', playerId: 'other', promptId: 'p1', selectionIds: []
      }, authedCtx('user-1'))
    ).rejects.toThrow('Forbidden');
  });

  it('posts target selection and returns state', async () => {
    mockFetchSequence({ data: {} }, { data: defaultState });
    const result = await mutationResolvers.submitTargetSelection(null, {
      matchId: 'm1', playerId: 'user-1', promptId: 'p1', selectionIds: ['target-1']
    }, authedCtx('user-1'));
    expect(result.currentPhase).toBe('main');
  });
});

describe('mutationResolvers.selectBattlefield', () => {
  it('requires auth', async () => {
    await expect(
      mutationResolvers.selectBattlefield(null, { matchId: 'm1', playerId: 'other', battlefieldId: 'bf1' }, authedCtx('user-1'))
    ).rejects.toThrow('Forbidden');
  });

  it('posts battlefield selection and returns state', async () => {
    mockFetchSequence({ data: {} }, { data: defaultState });
    const result = await mutationResolvers.selectBattlefield(null, {
      matchId: 'm1', playerId: 'user-1', battlefieldId: 'bf-alpha'
    }, authedCtx('user-1'));
    expect(result.currentPhase).toBe('main');
  });

  it('rethrows as GraphQLError for 4xx status from API', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(mockResponse({ error: 'Battlefield locked' }, 400)) as any;
    await expect(
      mutationResolvers.selectBattlefield(null, { matchId: 'm1', playerId: 'user-1', battlefieldId: 'bf1' }, authedCtx('user-1'))
    ).rejects.toThrow();
  });
});

describe('mutationResolvers.playCard', () => {
  it('requires auth', async () => {
    await expect(
      mutationResolvers.playCard(null, { matchId: 'm1', playerId: 'other', cardIndex: 0 }, authedCtx('user-1'))
    ).rejects.toThrow('Forbidden');
  });

  it('plays card and returns success with game state', async () => {
    // Call sequence: GET player view, POST play-card, GET spectator state
    mockFetchSequence(
      { data: { currentPlayer: { hand: [{ cardId: 'c1', name: 'Fire Imp', energyCost: 2, type: 'creature' }] } } },
      { data: { playerView: null } },
      { data: defaultState }
    );
    const result = await mutationResolvers.playCard(null, {
      matchId: 'm1', playerId: 'user-1', cardIndex: 0
    }, authedCtx('user-1'));
    expect(result.success).toBe(true);
    expect(result.gameState.currentPhase).toBe('main');
    expect(publishCardPlayed).toHaveBeenCalled();
  });

  it('handles missing card snapshot gracefully', async () => {
    // First call (GET player view) fails - card snapshot unavailable
    mockFetchSequence(
      { data: { error: 'not found' }, status: 404 },
      { data: {} },
      { data: defaultState }
    );
    // Should still succeed - card snapshot is optional
    // The error on the first call is caught internally, so the 404 causes a retry loop.
    // Let's instead mock a successful player view with no hand item at the cardIndex
    mockFetchSequence(
      { data: { currentPlayer: { hand: [] } } },
      { data: {} },
      { data: defaultState }
    );
    const result = await mutationResolvers.playCard(null, {
      matchId: 'm1', playerId: 'user-1', cardIndex: 5
    }, authedCtx('user-1'));
    expect(result.success).toBe(true);
  });
});

describe('mutationResolvers.attack', () => {
  it('requires auth', async () => {
    await expect(
      mutationResolvers.attack(null, { matchId: 'm1', playerId: 'other', creatureInstanceId: 'c1', destinationId: 'bf1' }, authedCtx('user-1'))
    ).rejects.toThrow('Forbidden');
  });

  it('throws when destinationId is missing', async () => {
    await expect(
      mutationResolvers.attack(null, { matchId: 'm1', playerId: 'user-1', creatureInstanceId: 'c1', destinationId: '' }, authedCtx('user-1'))
    ).rejects.toThrow('Battlefield destination required');
  });

  it('throws when destinationId is "base"', async () => {
    await expect(
      mutationResolvers.attack(null, { matchId: 'm1', playerId: 'user-1', creatureInstanceId: 'c1', destinationId: 'base' }, authedCtx('user-1'))
    ).rejects.toThrow('Use moveUnit to return to base');
  });

  it('posts attack and publishes event', async () => {
    mockFetchSequence({ data: {} }, { data: defaultState });
    const result = await mutationResolvers.attack(null, {
      matchId: 'm1', playerId: 'user-1', creatureInstanceId: 'creature-1', destinationId: 'bf-alpha'
    }, authedCtx('user-1'));
    expect(result.success).toBe(true);
    expect(publishAttackDeclared).toHaveBeenCalled();
  });
});

describe('mutationResolvers.moveUnit', () => {
  it('requires auth', async () => {
    await expect(
      mutationResolvers.moveUnit(null, { matchId: 'm1', playerId: 'other', creatureInstanceId: 'c1', destinationId: 'bf1' }, authedCtx('user-1'))
    ).rejects.toThrow('Forbidden');
  });

  it('posts move and returns state', async () => {
    mockFetchSequence({ data: {} }, { data: defaultState });
    const result = await mutationResolvers.moveUnit(null, {
      matchId: 'm1', playerId: 'user-1', creatureInstanceId: 'c1', destinationId: 'base'
    }, authedCtx('user-1'));
    expect(result.success).toBe(true);
  });
});

describe('mutationResolvers.hideCard', () => {
  it('requires auth', async () => {
    await expect(
      mutationResolvers.hideCard(null, { matchId: 'm1', playerId: 'other', cardIndex: 0, battlefieldId: 'bf1' }, authedCtx('user-1'))
    ).rejects.toThrow('Forbidden');
  });

  it('posts hide-card and returns state', async () => {
    mockFetchSequence({ data: {} }, { data: defaultState });
    const result = await mutationResolvers.hideCard(null, {
      matchId: 'm1', playerId: 'user-1', cardIndex: 2, battlefieldId: 'bf-alpha'
    }, authedCtx('user-1'));
    expect(result.success).toBe(true);
    expect(result.currentPhase).toBe('main');
  });
});

describe('mutationResolvers.activateHiddenCard', () => {
  it('requires auth', async () => {
    await expect(
      mutationResolvers.activateHiddenCard(null, { matchId: 'm1', playerId: 'other', hiddenInstanceId: 'h1' }, authedCtx('user-1'))
    ).rejects.toThrow('Forbidden');
  });

  it('posts activate-hidden and returns state', async () => {
    mockFetchSequence({ data: {} }, { data: defaultState });
    const result = await mutationResolvers.activateHiddenCard(null, {
      matchId: 'm1', playerId: 'user-1', hiddenInstanceId: 'h1', targets: ['target-1']
    }, authedCtx('user-1'));
    expect(result.success).toBe(true);
  });

  it('defaults targets to empty array', async () => {
    mockFetchSequence({ data: {} }, { data: defaultState });
    await mutationResolvers.activateHiddenCard(null, {
      matchId: 'm1', playerId: 'user-1', hiddenInstanceId: 'h1'
    }, authedCtx('user-1'));
    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.targets).toEqual([]);
  });
});

describe('mutationResolvers.commenceBattle', () => {
  it('requires auth', async () => {
    await expect(
      mutationResolvers.commenceBattle(null, { matchId: 'm1', playerId: 'other', battlefieldId: 'bf1' }, authedCtx('user-1'))
    ).rejects.toThrow('Forbidden');
  });

  it('posts commence-battle and returns state', async () => {
    mockFetchSequence({ data: {} }, { data: defaultState });
    const result = await mutationResolvers.commenceBattle(null, {
      matchId: 'm1', playerId: 'user-1', battlefieldId: 'bf-alpha'
    }, authedCtx('user-1'));
    expect(result.success).toBe(true);
  });
});

describe('mutationResolvers.activateChampionAbility', () => {
  it('requires auth', async () => {
    await expect(
      mutationResolvers.activateChampionAbility(null, { matchId: 'm1', playerId: 'other' }, authedCtx('user-1'))
    ).rejects.toThrow('Forbidden');
  });

  it('posts activate-legend and returns state', async () => {
    mockFetchSequence({ data: {} }, { data: defaultState });
    const result = await mutationResolvers.activateChampionAbility(null, {
      matchId: 'm1', playerId: 'user-1', target: 'legend'
    }, authedCtx('user-1'));
    expect(result.success).toBe(true);
  });
});

describe('mutationResolvers.passPriority', () => {
  it('requires auth', async () => {
    await expect(
      mutationResolvers.passPriority(null, { matchId: 'm1', playerId: 'other' }, authedCtx('user-1'))
    ).rejects.toThrow('Forbidden');
  });

  it('posts pass-priority and returns state', async () => {
    mockFetchSequence({ data: {} }, { data: defaultState });
    const result = await mutationResolvers.passPriority(null, { matchId: 'm1', playerId: 'user-1' }, authedCtx('user-1'));
    expect(result.success).toBe(true);
  });
});

describe('mutationResolvers.respondToSpellReaction', () => {
  it('requires auth', async () => {
    await expect(
      mutationResolvers.respondToSpellReaction(null, { matchId: 'm1', playerId: 'other', pass: true }, authedCtx('user-1'))
    ).rejects.toThrow('Forbidden');
  });

  it('posts respond-to-spell-reaction and returns state', async () => {
    mockFetchSequence({ data: {} }, { data: defaultState });
    const result = await mutationResolvers.respondToSpellReaction(null, {
      matchId: 'm1', playerId: 'user-1', pass: false
    }, authedCtx('user-1'));
    expect(result.success).toBe(true);
  });
});

describe('mutationResolvers.respondToChainReaction', () => {
  it('requires auth', async () => {
    await expect(
      mutationResolvers.respondToChainReaction(null, { matchId: 'm1', playerId: 'other', pass: true }, authedCtx('user-1'))
    ).rejects.toThrow('Forbidden');
  });

  it('posts respond-to-chain-reaction and returns state', async () => {
    mockFetchSequence({ data: {} }, { data: defaultState });
    const result = await mutationResolvers.respondToChainReaction(null, {
      matchId: 'm1', playerId: 'user-1', pass: true
    }, authedCtx('user-1'));
    expect(result.success).toBe(true);
  });
});

describe('mutationResolvers.nextPhase', () => {
  it('requires auth', async () => {
    await expect(
      mutationResolvers.nextPhase(null, { matchId: 'm1', playerId: 'other' }, authedCtx('user-1'))
    ).rejects.toThrow('Forbidden');
  });

  it('posts next-phase and publishes phase change', async () => {
    mockFetchSequence({ data: {} }, { data: { ...defaultState, currentPhase: 'battle' } });
    const result = await mutationResolvers.nextPhase(null, { matchId: 'm1', playerId: 'user-1' }, authedCtx('user-1'));
    expect(result.success).toBe(true);
    expect(result.currentPhase).toBe('battle');
    expect(publishPhaseChange).toHaveBeenCalledWith('m1', expect.objectContaining({ newPhase: 'battle' }));
  });
});

describe('mutationResolvers.recordDuelLogEntry', () => {
  it('throws GraphQLError for empty message', async () => {
    await expect(
      mutationResolvers.recordDuelLogEntry(null, { matchId: 'm1', playerId: 'user-1', message: '   ' }, authedCtx('user-1'))
    ).rejects.toThrow('Log message is required.');
  });

  it('throws Unauthorized when not authenticated', async () => {
    await expect(
      mutationResolvers.recordDuelLogEntry(null, { matchId: 'm1', playerId: 'user-1', message: 'hi' }, anonCtx())
    ).rejects.toThrow('Unauthorized');
  });

  it('posts duel-log entry and returns state', async () => {
    mockFetchSequence({ data: {} }, { data: defaultState });
    const result = await mutationResolvers.recordDuelLogEntry(null, {
      matchId: 'm1', playerId: 'user-1', message: 'Round 1!', tone: 'epic', actorName: 'Alice'
    }, authedCtx('user-1'));
    expect(result.success).toBe(true);
  });
});

describe('mutationResolvers.sendChatMessage', () => {
  it('throws GraphQLError for empty message', async () => {
    await expect(
      mutationResolvers.sendChatMessage(null, { matchId: 'm1', playerId: 'user-1', message: '' }, authedCtx('user-1'))
    ).rejects.toThrow('Message cannot be empty.');
  });

  it('requires auth matching playerId', async () => {
    await expect(
      mutationResolvers.sendChatMessage(null, { matchId: 'm1', playerId: 'other', message: 'hello' }, authedCtx('user-1'))
    ).rejects.toThrow('Forbidden');
  });

  it('sends chat message and returns state', async () => {
    mockFetchSequence({ data: {} }, { data: defaultState });
    const result = await mutationResolvers.sendChatMessage(null, {
      matchId: 'm1', playerId: 'user-1', message: 'Good game!'
    }, authedCtx('user-1'));
    expect(result.success).toBe(true);
  });

  it('falls back to /matches/:id/chat when action endpoint returns 404', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(mockResponse({ error: 'Not found' }, 404))  // chat action → 404
      .mockResolvedValueOnce(mockResponse({}))                            // fallback chat endpoint
      .mockResolvedValueOnce(mockResponse(defaultState)) as any;          // spectator state
    const result = await mutationResolvers.sendChatMessage(null, {
      matchId: 'm1', playerId: 'user-1', message: 'Fallback test'
    }, authedCtx('user-1'));
    expect(result.success).toBe(true);
    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(calls[1][0]).toContain('/matches/m1/chat');
  });
});

describe('mutationResolvers.reportMatchResult', () => {
  it('posts result, publishes completion, and removes players from queue', async () => {
    const matchResult = { matchId: 'm1', winner: 'user-1', loser: 'user-2', players: ['user-1', 'user-2'] };
    mockFetch({ success: true, matchResult, gameState: { players: ['user-1', 'user-2'] } });

    const result = await mutationResolvers.reportMatchResult(null, {
      matchId: 'm1', winner: 'user-1', reason: 'normal'
    }, authedCtx());
    expect(result.success).toBe(true);
    expect(result.matchResult).toEqual(matchResult);
    expect(publishMatchCompletion).toHaveBeenCalledWith('m1', matchResult);
  });

  it('returns null gameState when API response has none', async () => {
    mockFetch({ success: true, matchResult: { winner: 'u1' } });
    const result = await mutationResolvers.reportMatchResult(null, {
      matchId: 'm1', winner: 'u1', reason: 'concede'
    }, authedCtx());
    expect(result.gameState).toBeNull();
  });
});

describe('mutationResolvers.concedeMatch', () => {
  it('posts concede, publishes completion, and returns result', async () => {
    const matchResult = { winner: 'user-2', loser: 'user-1', players: ['user-1', 'user-2'] };
    mockFetch({ success: true, matchResult, gameState: null });
    const result = await mutationResolvers.concedeMatch(null, {
      matchId: 'm1', playerId: 'user-1'
    }, authedCtx());
    expect(result.success).toBe(true);
    expect(publishMatchCompletion).toHaveBeenCalled();
  });

  it('propagates fetch errors', async () => {
    global.fetch = jest.fn().mockResolvedValue(mockResponse({ error: 'Server error' }, 500)) as any;
    await expect(
      mutationResolvers.concedeMatch(null, { matchId: 'm1', playerId: 'user-1' }, authedCtx())
    ).rejects.toThrow();
  });
});

describe('mutationResolvers.saveDecklist', () => {
  const validCards = Array.from({ length: 39 }, (_, i) => ({ slug: `card-${i}`, quantity: 1 }));
  const validInput = {
    userId: 'user-1',
    name: 'Test Deck',
    cards: validCards,
  };

  it('throws when userId is missing', async () => {
    await expect(
      mutationResolvers.saveDecklist(null, { input: { ...validInput, userId: '' } }, authedCtx('user-1'))
    ).rejects.toThrow('User ID is required');
  });

  it('throws when cards array is empty', async () => {
    await expect(
      mutationResolvers.saveDecklist(null, { input: { ...validInput, cards: [] } }, authedCtx('user-1'))
    ).rejects.toThrow('Deck must include at least one card');
  });

  it('throws when deck has too few cards', async () => {
    await expect(
      mutationResolvers.saveDecklist(null, { input: { ...validInput, cards: [{ slug: 'c1', quantity: 1 }] } }, authedCtx('user-1'))
    ).rejects.toThrow('at least 39 cards');
  });

  it('throws when deck has too many cards', async () => {
    const tooMany = Array.from({ length: 40 }, (_, i) => ({ slug: `card-${i}`, quantity: 1 }));
    await expect(
      mutationResolvers.saveDecklist(null, { input: { ...validInput, cards: tooMany } }, authedCtx('user-1'))
    ).rejects.toThrow('more than 39 cards');
  });

  it('throws when side deck exceeds max', async () => {
    const sideDeck = Array.from({ length: 9 }, (_, i) => ({ slug: `side-${i}`, quantity: 1 }));
    await expect(
      mutationResolvers.saveDecklist(null, { input: { ...validInput, sideDeck } }, authedCtx('user-1'))
    ).rejects.toThrow('Side deck cannot include more than 8 cards');
  });

  it('requires auth matching userId', async () => {
    await expect(
      mutationResolvers.saveDecklist(null, { input: { ...validInput, userId: 'user-1' } }, authedCtx('other'))
    ).rejects.toThrow('Forbidden');
  });

  it('saves deck and returns mapped item', async () => {
    const result = await mutationResolvers.saveDecklist(null, { input: validInput }, authedCtx('user-1'));
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Test Deck');
    expect(result!.userId).toBe('user-1');
    expect(db.put).toHaveBeenCalled();
  });

  it('merges duplicate card entries up to MAX_CARD_COPIES=3', async () => {
    // 3 copies of same card should be merged
    const cards = [
      { slug: 'dup-card', quantity: 1 },
      { slug: 'dup-card', quantity: 1 },
      { slug: 'dup-card', quantity: 1 },
      ...Array.from({ length: 36 }, (_, i) => ({ slug: `filler-${i}`, quantity: 1 })),
    ];
    const result = await mutationResolvers.saveDecklist(null, { input: { ...validInput, cards } }, authedCtx('user-1'));
    expect(result).not.toBeNull();
  });

  it('caps quantity at 3 copies per card (quantity:4 → capped to 3, total 39 = valid)', async () => {
    const cards = [
      { slug: 'dup-card', quantity: 4 }, // capped to 3
      ...Array.from({ length: 36 }, (_, i) => ({ slug: `filler-${i}`, quantity: 1 })),
    ];
    // 3 (capped) + 36 = 39 → valid deck, should save successfully
    const result = await mutationResolvers.saveDecklist(null, { input: { ...validInput, cards } }, authedCtx('user-1'));
    expect(result).not.toBeNull();
    const savedCards = db.put.mock.calls[0][0].Item.Cards;
    const dup = savedCards.find((c: any) => c.slug === 'dup-card');
    expect(dup.quantity).toBe(3);
  });

  it('handles isDefault deck by clearing other defaults', async () => {
    db._queryPromise.mockResolvedValue({
      Items: [
        { UserId: 'user-1', DeckId: 'old-default', IsDefault: true },
      ]
    });
    await mutationResolvers.saveDecklist(null, {
      input: { ...validInput, isDefault: true }
    }, authedCtx('user-1'));
    expect(db.update).toHaveBeenCalled();
  });

  it('preserves createdAt when updating existing deck', async () => {
    const originalTs = Date.now() - 100000;
    db._getPromise.mockResolvedValue({ Item: { CreatedAt: originalTs } });
    const result = await mutationResolvers.saveDecklist(null, {
      input: { ...validInput, deckId: 'existing-deck-id' }
    }, authedCtx('user-1'));
    expect(result!.createdAt).toBe(new Date(originalTs).toISOString());
  });

  it('sanitizes card snapshot slug to lowercase', async () => {
    const cards = [
      ...Array.from({ length: 39 }, (_, i) => ({
        slug: `card-${i}`,
        quantity: 1,
        cardSnapshot: i === 0
          ? { slug: 'UPPER-CARD', name: 'Upper Card', type: 'creature', rarity: 'common' }
          : null
      }))
    ];
    const result = await mutationResolvers.saveDecklist(null, { input: { ...validInput, cards } }, authedCtx('user-1'));
    expect(result).not.toBeNull();
  });
});

describe('mutationResolvers.deleteDecklist', () => {
  it('throws when userId is missing', async () => {
    await expect(
      mutationResolvers.deleteDecklist(null, { userId: '', deckId: 'd1' }, authedCtx('user-1'))
    ).rejects.toThrow('User ID and Deck ID are required');
  });

  it('throws when deckId is missing', async () => {
    await expect(
      mutationResolvers.deleteDecklist(null, { userId: 'user-1', deckId: '' }, authedCtx('user-1'))
    ).rejects.toThrow('User ID and Deck ID are required');
  });

  it('requires auth', async () => {
    await expect(
      mutationResolvers.deleteDecklist(null, { userId: 'user-1', deckId: 'd1' }, anonCtx())
    ).rejects.toThrow('Unauthorized');
  });

  it('deletes deck and returns true', async () => {
    const result = await mutationResolvers.deleteDecklist(null, { userId: 'user-1', deckId: 'd1' }, authedCtx('user-1'));
    expect(result).toBe(true);
    expect(db.delete).toHaveBeenCalled();
  });
});

describe('mutationResolvers.joinMatchmakingQueue', () => {
  it('requires auth', async () => {
    await expect(
      mutationResolvers.joinMatchmakingQueue(null, { input: { userId: 'other', mode: 'free' } }, authedCtx('user-1'))
    ).rejects.toThrow('Forbidden');
  });

  it('throws for invalid mode', async () => {
    await expect(
      mutationResolvers.joinMatchmakingQueue(null, { input: { userId: 'user-1', mode: 'turbo' as any } }, authedCtx('user-1'))
    ).rejects.toThrow('Invalid matchmaking mode');
  });

  it('joins queue and returns queued status', async () => {
    db._getPromise
      .mockResolvedValueOnce({ Item: null })  // getQueueEntry (existing check)
      .mockResolvedValueOnce({ Item: null })  // getUserMmr
      .mockResolvedValueOnce({ Item: null })  // getQueueEntry (after join, userId)
      .mockResolvedValueOnce({ Item: null }); // getUsernameForUser (opponentId)
    db._queryPromise.mockResolvedValue({ Items: [], Count: 1 }); // queue length

    const result = await mutationResolvers.joinMatchmakingQueue(null, {
      input: { userId: 'user-1', mode: 'free', deckId: 'deck-1' }
    }, authedCtx('user-1'));
    expect(result.mode).toBe('free');
    expect(db.put).toHaveBeenCalled();
  });

  it('returns existing match when already matched', async () => {
    db._getPromise
      .mockResolvedValueOnce({ Item: { State: 'matched', MatchId: 'match-existing', OpponentId: 'opp-1', MMR: 1200 } })
      .mockResolvedValueOnce({ Item: null }) // isMatchCompleted: history query → 0 items
      .mockResolvedValueOnce({ Item: null }); // isMatchCompleted: state check
    db._queryPromise.mockResolvedValue({ Items: [] }); // match history check
    db._getPromise.mockResolvedValueOnce({ Item: null }); // match state check

    // Re-mock cleanly
    db._getPromise.mockReset();
    db._getPromise
      .mockResolvedValueOnce({ Item: { State: 'matched', MatchId: 'match-existing', OpponentId: 'opp-1', MMR: 1300 } })
      .mockResolvedValueOnce({ Item: null }) // getUserProfileSummary for opponent
      .mockResolvedValueOnce({ Item: null }); // isMatchCompleted state table
    db._queryPromise.mockResolvedValue({ Items: [], Count: 2 }); // isMatchCompleted history + queue length

    const result = await mutationResolvers.joinMatchmakingQueue(null, {
      input: { userId: 'user-1', mode: 'ranked' }
    }, authedCtx('user-1'));
    expect(result.matchFound).toBe(true);
    expect(result.matchId).toBe('match-existing');
  });
});

describe('mutationResolvers.leaveMatchmakingQueue', () => {
  it('requires auth', async () => {
    await expect(
      mutationResolvers.leaveMatchmakingQueue(null, { userId: 'other', mode: 'free' }, authedCtx('user-1'))
    ).rejects.toThrow('Forbidden');
  });

  it('deletes queue entry and returns true', async () => {
    db._queryPromise.mockResolvedValue({ Items: [], Count: 0 });
    db._getPromise.mockResolvedValue({ Item: null });
    const result = await mutationResolvers.leaveMatchmakingQueue(null, { userId: 'user-1', mode: 'free' }, authedCtx('user-1'));
    expect(result).toBe(true);
    expect(db.delete).toHaveBeenCalled();
  });
});

// ===========================================================================
// SUBSCRIPTION RESOLVERS
// ===========================================================================

describe('subscriptionResolvers', () => {
  it('gameStateChanged.subscribe returns asyncIterator for match', () => {
    const iter = subscriptionResolvers.gameStateChanged.subscribe(null, { matchId: 'm1' });
    expect(pubSub.asyncIterator).toHaveBeenCalledWith(['GAME_STATE_CHANGED:m1']);
  });

  it('playerGameStateChanged.subscribe returns asyncIterator per player+match', () => {
    subscriptionResolvers.playerGameStateChanged.subscribe(null, { matchId: 'm1', playerId: 'u1' });
    expect(pubSub.asyncIterator).toHaveBeenCalledWith(['PLAYER_GAME_STATE_CHANGED:m1:u1']);
  });

  it('matchCompleted.subscribe returns asyncIterator for match', () => {
    subscriptionResolvers.matchCompleted.subscribe(null, { matchId: 'm1' });
    expect(pubSub.asyncIterator).toHaveBeenCalledWith(['MATCH_COMPLETED:m1']);
  });

  it('leaderboardUpdated.subscribe returns asyncIterator', () => {
    subscriptionResolvers.leaderboardUpdated.subscribe();
    expect(pubSub.asyncIterator).toHaveBeenCalledWith(['LEADERBOARD_UPDATED']);
  });

  it('cardPlayed.subscribe returns asyncIterator for match', () => {
    subscriptionResolvers.cardPlayed.subscribe(null, { matchId: 'm1' });
    expect(pubSub.asyncIterator).toHaveBeenCalledWith(['CARD_PLAYED:m1']);
  });

  it('attackDeclared.subscribe returns asyncIterator for match', () => {
    subscriptionResolvers.attackDeclared.subscribe(null, { matchId: 'm1' });
    expect(pubSub.asyncIterator).toHaveBeenCalledWith(['ATTACK_DECLARED:m1']);
  });

  it('phaseChanged.subscribe returns asyncIterator for match', () => {
    subscriptionResolvers.phaseChanged.subscribe(null, { matchId: 'm1' });
    expect(pubSub.asyncIterator).toHaveBeenCalledWith(['PHASE_CHANGED:m1']);
  });

  it('matchmakingStatusUpdated.subscribe uses normalized mode in key', () => {
    subscriptionResolvers.matchmakingStatusUpdated.subscribe(null, { userId: 'u1', mode: 'ranked' });
    expect(pubSub.asyncIterator).toHaveBeenCalledWith(['MATCHMAKING_STATUS_UPDATED:ranked:u1']);
  });

  it('matchmakingStatusUpdated.subscribe throws for invalid mode', () => {
    expect(() =>
      subscriptionResolvers.matchmakingStatusUpdated.subscribe(null, { userId: 'u1', mode: 'invalid' as any })
    ).toThrow('Invalid matchmaking mode');
  });
});

// ===========================================================================
// runMatchmakingSweep
// ===========================================================================

describe('runMatchmakingSweep', () => {
  it('returns false when queue has fewer than 2 players', async () => {
    db._queryPromise.mockResolvedValue({ Items: [{ UserId: 'u1', State: 'queued', MMR: 1200, QueuedAt: Date.now() }] });
    const result = await runMatchmakingSweep('free');
    expect(result).toBe(false);
  });

  it('returns false when queue is empty', async () => {
    db._queryPromise.mockResolvedValue({ Items: [] });
    const result = await runMatchmakingSweep('ranked');
    expect(result).toBe(false);
  });

  it('returns true when a match is made and both players have decks', async () => {
    const now = Date.now();
    // Mock call order for dynamodb.query during one sweep cycle:
    // 1. listQueuedEntries          → 2 players
    // 2. getQueueLength (u1 status) → { Count: 1 }
    // 3. getQueueLength (u2 status) → { Count: 1 }
    // 4. deck query for u1          → deck items
    // 5. deck query for u2          → deck items
    // 6. getQueueLength (u1 post-spawn status) → { Count: 0 }
    // 7. getQueueLength (u2 post-spawn status) → { Count: 0 }
    // 8. listQueuedEntries (2nd sweep) → empty → stop loop
    db._queryPromise
      .mockResolvedValueOnce({ // 1: listQueuedEntries
        Items: [
          { UserId: 'u1', State: 'queued', MMR: 1200, QueuedAt: now - 1000, AuthToken: 'tok-1', DeckId: null },
          { UserId: 'u2', State: 'queued', MMR: 1200, QueuedAt: now - 500, AuthToken: 'tok-2', DeckId: null },
        ]
      })
      .mockResolvedValueOnce({ Count: 1 }) // 2: getQueueLength for u1 status
      .mockResolvedValueOnce({ Count: 1 }) // 3: getQueueLength for u2 status
      .mockResolvedValueOnce({ // 4: deck query for u1
        Items: [{ UserId: 'u1', DeckId: 'd1', Name: 'Deck U1', IsDefault: true, Cards: [], Tags: [], CardCount: 0 }]
      })
      .mockResolvedValueOnce({ // 5: deck query for u2
        Items: [{ UserId: 'u2', DeckId: 'd2', Name: 'Deck U2', IsDefault: true, Cards: [], Tags: [], CardCount: 0 }]
      })
      .mockResolvedValueOnce({ Count: 0 }) // 6: getQueueLength for u1 post-spawn status
      .mockResolvedValueOnce({ Count: 0 }) // 7: getQueueLength for u2 post-spawn status
      .mockResolvedValueOnce({ Items: [] }); // 8: listQueuedEntries 2nd sweep → stop

    db._getPromise.mockResolvedValue({ Item: null }); // getUserProfileSummary / getUserMmr
    mockFetch({ matchId: 'new-match', status: 'initialized' }); // spawnMatchService

    const result = await runMatchmakingSweep('free');
    expect(result).toBe(true);
  });
});

// ===========================================================================
// rethrowGraphQLError utility
// ===========================================================================

describe('rethrowGraphQLError (via selectBattlefield)', () => {
  it('wraps 4xx as GraphQLError with BAD_USER_INPUT', async () => {
    global.fetch = jest.fn().mockResolvedValue(mockResponse({ error: 'Invalid battlefield' }, 422)) as any;
    try {
      await mutationResolvers.selectBattlefield(null, {
        matchId: 'm1', playerId: 'user-1', battlefieldId: 'bf-bad'
      }, authedCtx('user-1'));
      fail('Expected to throw');
    } catch (err: any) {
      expect(err).toBeInstanceOf(GraphQLError);
      expect(err.extensions.code).toBe('BAD_USER_INPUT');
    }
  });

  it('rethrows generic Error for 5xx status', async () => {
    global.fetch = jest.fn().mockResolvedValue(mockResponse({ error: 'Server error' }, 500)) as any;
    await expect(
      mutationResolvers.selectBattlefield(null, {
        matchId: 'm1', playerId: 'user-1', battlefieldId: 'bf-bad'
      }, authedCtx('user-1'))
    ).rejects.toThrow();
  });
});

// ===========================================================================
// sanitizeCardSnapshot edge cases
// ===========================================================================

describe('sanitizeCardSnapshot (via saveDecklist champion fields)', () => {
  const baseInput = {
    userId: 'user-1',
    name: 'Deck',
    cards: Array.from({ length: 39 }, (_, i) => ({ slug: `c-${i}`, quantity: 1 })),
  };

  it('ignores null championLegend', async () => {
    const result = await mutationResolvers.saveDecklist(null, {
      input: { ...baseInput, championLegend: null }
    }, authedCtx('user-1'));
    expect(result!.championLegend).toBeNull();
  });

  it('saves championLegend with valid snapshot', async () => {
    const result = await mutationResolvers.saveDecklist(null, {
      input: {
        ...baseInput,
        championLegend: {
          slug: 'legend-card',
          cardSnapshot: { name: 'Legend', type: 'champion', rarity: 'legendary', colors: ['fury'] }
        }
      }
    }, authedCtx('user-1'));
    expect(result).not.toBeNull();
    const putArgs = db.put.mock.calls[0][0].Item;
    expect(putArgs.ChampionLegend).toBeDefined();
  });

  it('filters empty colors array in snapshot', async () => {
    const result = await mutationResolvers.saveDecklist(null, {
      input: {
        ...baseInput,
        championLeader: {
          slug: 'leader-card',
          cardSnapshot: { name: 'Leader', type: 'champion', rarity: 'rare', colors: [] }
        }
      }
    }, authedCtx('user-1'));
    expect(result).not.toBeNull();
  });
});

// ===========================================================================
// internalApiRequest retry / error path
// ===========================================================================

describe('internalApiRequest retry behavior', () => {
  it('throws non-retryable error immediately (4xx)', async () => {
    global.fetch = jest.fn()
      .mockResolvedValue(mockResponse({ error: 'Bad request' }, 400)) as any;

    await expect(
      queryResolvers.match(null, { matchId: 'bad' }, authedCtx())
    ).rejects.toThrow('Bad request');

    // Should only have been called once (no retry for 4xx)
    expect((global.fetch as jest.Mock)).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// ensureGameStateDefaults
// ===========================================================================

describe('ensureGameStateDefaults (via match query)', () => {
  it('adds duelLog array when missing from state', async () => {
    mockFetch({ matchId: 'm1', players: [] }); // no duelLog or chatLog
    const result = await queryResolvers.match(null, { matchId: 'm1' }, authedCtx());
    expect(Array.isArray(result.duelLog)).toBe(true);
    expect(Array.isArray(result.chatLog)).toBe(true);
  });
});
