/**
 * Match Routes API - Comprehensive Unit Tests
 *
 * Tests all route handlers in src/match-routes.ts:
 *   POST /matches/init
 *   GET  /matches/:matchId
 *   GET  /matches/:matchId/player/:playerId
 *   POST /matches/:matchId/actions/play-card
 *   POST /matches/:matchId/actions/select-battlefield
 *   POST /matches/:matchId/actions/mulligan
 *   POST /matches/:matchId/actions/discard
 *   POST /matches/:matchId/actions/target
 *   POST /matches/:matchId/actions/initiative
 *   POST /matches/:matchId/actions/attack
 *   POST /matches/:matchId/actions/move
 *   POST /matches/:matchId/actions/hide-card
 *   POST /matches/:matchId/actions/activate-hidden
 *   POST /matches/:matchId/actions/commence-battle
 *   POST /matches/:matchId/actions/activate-legend
 *   POST /matches/:matchId/actions/pass-priority
 *   POST /matches/:matchId/actions/respond-to-spell-reaction
 *   POST /matches/:matchId/actions/respond-to-chain-reaction
 *   POST /matches/:matchId/actions/next-phase
 *   POST /matches/:matchId/logs  (and /actions/duel-log)
 *   POST /matches/:matchId/chat  (and /actions/chat)
 *   POST /matches/:matchId/result
 *   POST /matches/:matchId/concede
 *   GET  /matches/:matchId/history
 */

// ---------------------------------------------------------------------------
// Mocks — hoisted by Jest before any import
// ---------------------------------------------------------------------------

jest.mock('dotenv/config', () => ({}));

jest.mock('../logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

// DynamoDB DocumentClient — expose promise functions via default export
jest.mock('aws-sdk', () => {
  const getPromise    = jest.fn().mockResolvedValue({ Item: null });
  const putPromise    = jest.fn().mockResolvedValue({});
  const queryPromise  = jest.fn().mockResolvedValue({ Items: [] });
  const batchWritePromise = jest.fn().mockResolvedValue({ UnprocessedItems: {} });
  const deletePromise = jest.fn().mockResolvedValue({ Attributes: null });

  const clientInstance = {
    get:        jest.fn().mockReturnValue({ promise: getPromise }),
    put:        jest.fn().mockReturnValue({ promise: putPromise }),
    query:      jest.fn().mockReturnValue({ promise: queryPromise }),
    batchWrite: jest.fn().mockReturnValue({ promise: batchWritePromise }),
    delete:     jest.fn().mockReturnValue({ promise: deletePromise }),
    // Exposed for per-test configuration
    _getPromise:    getPromise,
    _putPromise:    putPromise,
    _queryPromise:  queryPromise,
    _batchWritePromise: batchWritePromise,
    _deletePromise: deletePromise,
  };

  const DocumentClient = jest.fn().mockImplementation(() => clientInstance);

  return {
    __esModule: true,
    default: {
      DynamoDB: { DocumentClient },
      _client: clientInstance,          // accessible via (AWS as any)._client
    },
    DynamoDB: { DocumentClient },
  };
});

// Game engine mock — all methods exposed on the mock constructor as _instance
jest.mock('../game-engine', () => {
  const engineInstance = {
    initializeGame:           jest.fn(),
    getGameState:             jest.fn(),
    getPlayerState:           jest.fn(),
    canPlayerAct:             jest.fn().mockReturnValue(true),
    playCard:                 jest.fn(),
    moveUnit:                 jest.fn(),
    hideCard:                 jest.fn(),
    activateHiddenCard:       jest.fn(),
    selectBattlefield:        jest.fn(),
    submitMulligan:           jest.fn(),
    submitDiscardSelection:   jest.fn(),
    submitTargetSelection:    jest.fn(),
    submitInitiativeChoice:   jest.fn(),
    commenceBattle:           jest.fn(),
    activateChampionAbility:  jest.fn(),
    passPriority:             jest.fn(),
    respondToSpellReaction:   jest.fn(),
    respondToChainReaction:   jest.fn(),
    proceedToNextPhase:       jest.fn(),
    addDuelLogEntry:          jest.fn(),
    addChatMessage:           jest.fn(),
    concedeMatch:             jest.fn(),
    getMatchResult:           jest.fn().mockReturnValue(null),
  };

  const MockEngine = jest.fn().mockImplementation(() => engineInstance);
  MockEngine.fromSerializedState = jest.fn().mockReturnValue(engineInstance);
  MockEngine._instance = engineInstance;  // accessible via (RiftboundGameEngine as any)._instance

  return {
    __esModule: true,
    RiftboundGameEngine: MockEngine,
    GameStatus: {
      COIN_FLIP:            'coin_flip',
      BATTLEFIELD_SELECTION:'battlefield_selection',
      MULLIGAN:             'mulligan',
      IN_PROGRESS:          'in_progress',
      WINNER_DETERMINED:    'winner_determined',
    },
    CardType: {
      CREATURE:    'creature',
      SPELL:       'spell',
      ARTIFACT:    'artifact',
      ENCHANTMENT: 'enchantment',
    },
  };
});

jest.mock('../game-state-serializer', () => ({
  __esModule: true,
  serializeGameState:  jest.fn(),
  serializePlayerState: jest.fn().mockReturnValue({ playerId: 'player-1', handSize: 7 }),
  buildOpponentView:   jest.fn().mockReturnValue({ playerId: 'player-2', handSize: 5 }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import express from 'express';
import request from 'supertest';
import AWS from 'aws-sdk';
import { RiftboundGameEngine } from '../game-engine';
import { serializeGameState, serializePlayerState, buildOpponentView } from '../game-state-serializer';
import { registerMatchRoutes } from '../match-routes';

// ---------------------------------------------------------------------------
// Typed helpers
// ---------------------------------------------------------------------------

interface DbClient {
  get: jest.Mock;
  put: jest.Mock;
  query: jest.Mock;
  batchWrite: jest.Mock;
  delete: jest.Mock;
  _getPromise: jest.Mock;
  _putPromise: jest.Mock;
  _queryPromise: jest.Mock;
  _batchWritePromise: jest.Mock;
  _deletePromise: jest.Mock;
}

interface EngineInstance {
  initializeGame: jest.Mock;
  getGameState: jest.Mock;
  getPlayerState: jest.Mock;
  canPlayerAct: jest.Mock;
  playCard: jest.Mock;
  moveUnit: jest.Mock;
  hideCard: jest.Mock;
  activateHiddenCard: jest.Mock;
  selectBattlefield: jest.Mock;
  submitMulligan: jest.Mock;
  submitDiscardSelection: jest.Mock;
  submitTargetSelection: jest.Mock;
  submitInitiativeChoice: jest.Mock;
  commenceBattle: jest.Mock;
  activateChampionAbility: jest.Mock;
  passPriority: jest.Mock;
  respondToSpellReaction: jest.Mock;
  respondToChainReaction: jest.Mock;
  proceedToNextPhase: jest.Mock;
  addDuelLogEntry: jest.Mock;
  addChatMessage: jest.Mock;
  concedeMatch: jest.Mock;
  getMatchResult: jest.Mock;
}

const db  = (AWS as any)._client as DbClient;
const eng = (RiftboundGameEngine as any)._instance as EngineInstance;

const mockSerialize        = serializeGameState   as jest.Mock;
const mockSerializePlayer  = serializePlayerState as jest.Mock;
const mockBuildOpponent    = buildOpponentView    as jest.Mock;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const makePlayerState = (playerId = 'player-1') => ({
  playerId,
  resources: { energy: 5, universalPower: 0, power: {} },
  channeledRunes: [],
  hand: [{
    id: 'card-1', name: 'Test Card', type: 'creature',
    energyCost: 2, powerCost: null, manaCost: 0, metadata: null
  }],
  deck: [],
  graveyard: [],
  exile: [],
  board: { creatures: [], artifacts: [], enchantments: [] },
  runeDeck: [],
});

const makeGameState = (overrides: Record<string, any> = {}) => ({
  matchId: 'test-match',
  status: 'in_progress',
  players: [makePlayerState('player-1'), makePlayerState('player-2')],
  moveHistory: [],
  turnNumber: 1,
  currentPhase: 'main',
  currentPlayerIndex: 0,
  timestamp: 1_000_000,
  prompts: [],
  duelLog: [],
  chatLog: [],
  combatContext: null,
  outcomePersisted: false,
  ...overrides,
});

const makeSerializedState = (overrides: Record<string, any> = {}) => ({
  matchId: 'test-match',
  currentPhase: 'main',
  status: 'in_progress',
  reactionChain: { items: [] },
  duelLog: [],
  chatLog: [],
  turnNumber: 1,
  ...overrides,
});

// Tell DynamoDB to return a snapshot for loadGameStateSnapshot
const givenStateExists = (state = makeGameState()) => {
  db._getPromise.mockResolvedValue({ Item: { GameState: state } });
};

// Tell DynamoDB to return no snapshot (404 path)
const givenStateNotFound = () => {
  db._getPromise.mockResolvedValue({ Item: null });
};

// ---------------------------------------------------------------------------
// Test app — registered once, shared across all tests
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
registerMatchRoutes(app);

// ---------------------------------------------------------------------------
// beforeEach: reset mocks to safe defaults
// ---------------------------------------------------------------------------

beforeEach(() => {
  // resetAllMocks clears both call history AND mockImplementation/mockReturnValue.
  // This prevents "throws" mockImplementation from leaking across tests.
  jest.resetAllMocks();

  // DynamoDB — re-wire the client methods to return the promise stubs
  db.get.mockReturnValue({ promise: db._getPromise });
  db.put.mockReturnValue({ promise: db._putPromise });
  db.query.mockReturnValue({ promise: db._queryPromise });
  db.batchWrite.mockReturnValue({ promise: db._batchWritePromise });
  db.delete.mockReturnValue({ promise: db._deletePromise });
  db._getPromise.mockResolvedValue({ Item: null });
  db._putPromise.mockResolvedValue({});
  db._queryPromise.mockResolvedValue({ Items: [] });
  db._batchWritePromise.mockResolvedValue({ UnprocessedItems: {} });
  db._deletePromise.mockResolvedValue({ Attributes: null });

  // Engine — reset all methods to no-ops / sensible defaults
  eng.initializeGame.mockReturnValue(undefined);
  eng.playCard.mockReturnValue(undefined);
  eng.moveUnit.mockReturnValue(undefined);
  eng.hideCard.mockReturnValue(undefined);
  eng.activateHiddenCard.mockReturnValue(undefined);
  eng.selectBattlefield.mockReturnValue(undefined);
  eng.submitMulligan.mockReturnValue(undefined);
  eng.submitDiscardSelection.mockReturnValue(undefined);
  eng.submitTargetSelection.mockReturnValue(undefined);
  eng.submitInitiativeChoice.mockReturnValue(undefined);
  eng.commenceBattle.mockReturnValue(undefined);
  eng.activateChampionAbility.mockReturnValue(undefined);
  eng.passPriority.mockReturnValue(undefined);
  eng.respondToSpellReaction.mockReturnValue(undefined);
  eng.respondToChainReaction.mockReturnValue(undefined);
  eng.proceedToNextPhase.mockReturnValue(undefined);
  eng.getGameState.mockReturnValue(makeGameState());
  eng.getPlayerState.mockReturnValue(makePlayerState());
  eng.canPlayerAct.mockReturnValue(true);
  eng.getMatchResult.mockReturnValue(null);
  eng.addDuelLogEntry.mockReturnValue({
    id: 'entry-1', playerId: 'player-1', message: 'hello', tone: 'normal', timestamp: 1_000_000
  });
  eng.addChatMessage.mockReturnValue({
    id: 'chat-1', playerId: 'player-1', playerName: 'Alice', message: 'hi', timestamp: 1_000_000
  });
  eng.concedeMatch.mockReturnValue({
    matchId: 'test-match', winner: 'player-2', loser: 'player-1',
    reason: 'concede', duration: 0, turns: 1, moves: []
  });
  // Re-wire constructor (resetAllMocks clears the factory's mockImplementation)
  (RiftboundGameEngine as jest.Mock).mockReturnValue(eng);
  (RiftboundGameEngine as any).fromSerializedState.mockReturnValue(eng);

  // Serializer defaults
  mockSerialize.mockReturnValue(makeSerializedState());
  mockSerializePlayer.mockReturnValue({ playerId: 'player-1', handSize: 7 });
  mockBuildOpponent.mockReturnValue({ playerId: 'player-2', handSize: 5 });
});

// ===========================================================================
// POST /matches/init
// ===========================================================================

describe('POST /matches/init', () => {
  const validBody = {
    matchId: 'test-match',
    player1: 'player-1',
    player2: 'player-2',
    decks: { 'player-1': { mainDeck: [] }, 'player-2': { mainDeck: [] } },
  };

  it('creates a new match and returns 201', async () => {
    givenStateNotFound();

    const res = await request(app).post('/matches/init').send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.matchId).toBe('test-match');
    expect(res.body.status).toBe('initialized');
    expect(res.body.players).toEqual(['player-1', 'player-2']);
    expect(res.body.gameState).toBeDefined();
  });

  it('returns 400 when matchId is missing', async () => {
    const res = await request(app).post('/matches/init').send({
      player1: 'player-1', player2: 'player-2', decks: {}
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/missing required fields/i);
  });

  it('returns 400 when player1 is missing', async () => {
    const res = await request(app).post('/matches/init').send({
      matchId: 'test-match', player2: 'player-2', decks: {}
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when decks is missing', async () => {
    const res = await request(app).post('/matches/init').send({
      matchId: 'test-match', player1: 'player-1', player2: 'player-2'
    });
    expect(res.status).toBe(400);
  });

  it('returns 409 when match already exists', async () => {
    givenStateExists();

    const res = await request(app).post('/matches/init').send(validBody);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/i);
  });

  it('returns 400 when engine.initializeGame throws', async () => {
    givenStateNotFound();
    eng.initializeGame.mockImplementation(() => {
      throw new Error('Invalid deck: too few cards');
    });

    const res = await request(app).post('/matches/init').send(validBody);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid deck/i);
  });

  it('accepts playerProfiles and passes usernames to engine constructor', async () => {
    givenStateNotFound();
    const bodyWithProfiles = {
      ...validBody,
      playerProfiles: {
        'player-1': { username: 'Alice' },
        'player-2': { username: 'Bob' },
      },
    };

    const res = await request(app).post('/matches/init').send(bodyWithProfiles);

    expect(res.status).toBe(201);
    const MockEngine = RiftboundGameEngine as jest.Mock;
    const constructorArgs = MockEngine.mock.calls[0];
    expect(constructorArgs[1]).toEqual([
      { playerId: 'player-1', name: 'Alice' },
      { playerId: 'player-2', name: 'Bob' },
    ]);
  });

  it('returns 500 when DynamoDB get throws unexpectedly', async () => {
    db._getPromise.mockRejectedValue(new Error('DynamoDB error'));

    const res = await request(app).post('/matches/init').send(validBody);

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to initialize/i);
  });
});

// ===========================================================================
// GET /matches/:matchId
// ===========================================================================

describe('GET /matches/:matchId', () => {
  it('returns serialized game state for an existing match', async () => {
    givenStateExists();

    const res = await request(app).get('/matches/test-match');

    expect(res.status).toBe(200);
    expect(res.body.matchId).toBe('test-match');
  });

  it('returns 404 when match not found', async () => {
    givenStateNotFound();

    const res = await request(app).get('/matches/unknown-match');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not available/i);
  });

  it('returns 500 when DynamoDB throws', async () => {
    db._getPromise.mockRejectedValue(new Error('Network error'));

    const res = await request(app).get('/matches/test-match');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to fetch/i);
  });
});

// ===========================================================================
// GET /matches/:matchId/player/:playerId
// ===========================================================================

describe('GET /matches/:matchId/player/:playerId', () => {
  it('returns player-specific view for an existing match', async () => {
    givenStateExists();

    const res = await request(app).get('/matches/test-match/player/player-1');

    expect(res.status).toBe(200);
    expect(res.body.matchId).toBe('test-match');
    expect(res.body.currentPlayer).toBeDefined();
    expect(res.body.opponent).toBeDefined();
    expect(res.body.gameState).toBeDefined();
  });

  it('returns 404 when match not found', async () => {
    givenStateNotFound();

    const res = await request(app).get('/matches/unknown/player/player-1');

    expect(res.status).toBe(404);
  });

  it('returns 500 when engine.getPlayerState returns null', async () => {
    givenStateExists();
    eng.getPlayerState.mockReturnValue(null);

    const res = await request(app).get('/matches/test-match/player/player-1');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to fetch player view/i);
  });
});

// ===========================================================================
// POST /matches/:matchId/actions/play-card
// ===========================================================================

describe('POST /matches/:matchId/actions/play-card', () => {
  const body = { playerId: 'player-1', cardIndex: 0 };

  it('plays a card and returns updated state', async () => {
    givenStateExists();

    const res = await request(app)
      .post('/matches/test-match/actions/play-card')
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.gameState).toBeDefined();
    expect(res.body.runePayment).toBeDefined();
    expect(eng.playCard).toHaveBeenCalledWith('player-1', 0, undefined, undefined, { useAccelerate: false });
  });

  it('returns 403 when it is not the player\'s turn', async () => {
    givenStateExists();
    eng.canPlayerAct.mockReturnValue(false);

    const res = await request(app)
      .post('/matches/test-match/actions/play-card')
      .send(body);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not your turn/i);
  });

  it('returns 404 when match not found', async () => {
    givenStateNotFound();

    const res = await request(app)
      .post('/matches/test-match/actions/play-card')
      .send(body);

    expect(res.status).toBe(404);
  });

  it('returns 400 when engine.playCard throws', async () => {
    givenStateExists();
    eng.playCard.mockImplementation(() => { throw new Error('Not enough energy'); });

    const res = await request(app)
      .post('/matches/test-match/actions/play-card')
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not enough energy/i);
  });

  it('includes accelerate cost when useAccelerate is true', async () => {
    givenStateExists();
    // Card with accelerate metadata
    eng.getPlayerState.mockReturnValue({
      ...makePlayerState(),
      hand: [{
        id: 'accel-card', name: 'Fast Card', type: 'creature',
        energyCost: 2, powerCost: {}, manaCost: 0,
        metadata: { accelerateCost: { energy: 2, rune: 'fury' } }
      }],
    });

    const res = await request(app)
      .post('/matches/test-match/actions/play-card')
      .send({ playerId: 'player-1', cardIndex: 0, useAccelerate: true });

    expect(res.status).toBe(200);
    expect(eng.playCard).toHaveBeenCalledWith(
      'player-1', 0, undefined, undefined, { useAccelerate: true }
    );
  });

  it('passes targets and destinationId to engine', async () => {
    givenStateExists();

    await request(app)
      .post('/matches/test-match/actions/play-card')
      .send({ playerId: 'player-1', cardIndex: 1, targets: ['target-a'], destinationId: 'bf-1' });

    expect(eng.playCard).toHaveBeenCalledWith(
      'player-1', 1, ['target-a'], 'bf-1', { useAccelerate: false }
    );
  });
});

// ===========================================================================
// POST /matches/:matchId/actions/select-battlefield
// ===========================================================================

describe('POST /matches/:matchId/actions/select-battlefield', () => {
  it('selects battlefield successfully', async () => {
    givenStateExists();

    const res = await request(app)
      .post('/matches/test-match/actions/select-battlefield')
      .send({ playerId: 'player-1', battlefieldId: 'bf-1' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(eng.selectBattlefield).toHaveBeenCalledWith('player-1', 'bf-1');
  });

  it('returns 404 when match not found', async () => {
    givenStateNotFound();

    const res = await request(app)
      .post('/matches/test-match/actions/select-battlefield')
      .send({ playerId: 'player-1', battlefieldId: 'bf-1' });

    expect(res.status).toBe(404);
  });

  it('returns 400 when engine throws', async () => {
    givenStateExists();
    eng.selectBattlefield.mockImplementation(() => {
      throw new Error('Invalid battlefield');
    });

    const res = await request(app)
      .post('/matches/test-match/actions/select-battlefield')
      .send({ playerId: 'player-1', battlefieldId: 'bad-bf' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid battlefield/i);
  });
});

// ===========================================================================
// POST /matches/:matchId/actions/mulligan
// ===========================================================================

describe('POST /matches/:matchId/actions/mulligan', () => {
  it('submits mulligan and returns updated state', async () => {
    givenStateExists();

    const res = await request(app)
      .post('/matches/test-match/actions/mulligan')
      .send({ playerId: 'player-1', indices: [0, 2] });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(eng.submitMulligan).toHaveBeenCalledWith('player-1', [0, 2]);
  });

  it('handles missing indices by passing empty array', async () => {
    givenStateExists();

    await request(app)
      .post('/matches/test-match/actions/mulligan')
      .send({ playerId: 'player-1' });

    expect(eng.submitMulligan).toHaveBeenCalledWith('player-1', []);
  });

  it('returns 404 when match not found', async () => {
    givenStateNotFound();

    const res = await request(app)
      .post('/matches/test-match/actions/mulligan')
      .send({ playerId: 'player-1', indices: [] });

    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// POST /matches/:matchId/actions/discard
// ===========================================================================

describe('POST /matches/:matchId/actions/discard', () => {
  it('resolves discard selection successfully', async () => {
    givenStateExists();

    const res = await request(app)
      .post('/matches/test-match/actions/discard')
      .send({ playerId: 'player-1', promptId: 'prompt-1', cardInstanceIds: ['inst-1'] });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(eng.submitDiscardSelection).toHaveBeenCalledWith('player-1', 'prompt-1', ['inst-1']);
  });

  it('handles non-array cardInstanceIds by passing empty array', async () => {
    givenStateExists();

    await request(app)
      .post('/matches/test-match/actions/discard')
      .send({ playerId: 'player-1', promptId: 'prompt-1' });

    expect(eng.submitDiscardSelection).toHaveBeenCalledWith('player-1', 'prompt-1', []);
  });

  it('returns 404 when match not found', async () => {
    givenStateNotFound();

    const res = await request(app)
      .post('/matches/test-match/actions/discard')
      .send({ playerId: 'player-1', promptId: 'p-1', cardInstanceIds: [] });

    expect(res.status).toBe(404);
  });

  it('returns 400 when engine throws', async () => {
    givenStateExists();
    eng.submitDiscardSelection.mockImplementation(() => {
      throw new Error('Prompt already resolved');
    });

    const res = await request(app)
      .post('/matches/test-match/actions/discard')
      .send({ playerId: 'player-1', promptId: 'p-1', cardInstanceIds: [] });

    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// POST /matches/:matchId/actions/target
// ===========================================================================

describe('POST /matches/:matchId/actions/target', () => {
  it('resolves target selection successfully', async () => {
    givenStateExists();

    const res = await request(app)
      .post('/matches/test-match/actions/target')
      .send({ playerId: 'player-1', promptId: 'prompt-1', selectionIds: ['target-a'] });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(eng.submitTargetSelection).toHaveBeenCalledWith('player-1', 'prompt-1', ['target-a']);
  });

  it('handles non-array selectionIds by passing empty array', async () => {
    givenStateExists();

    await request(app)
      .post('/matches/test-match/actions/target')
      .send({ playerId: 'player-1', promptId: 'prompt-1' });

    expect(eng.submitTargetSelection).toHaveBeenCalledWith('player-1', 'prompt-1', []);
  });

  it('returns 404 when match not found', async () => {
    givenStateNotFound();

    const res = await request(app)
      .post('/matches/test-match/actions/target')
      .send({ playerId: 'player-1', promptId: 'p-1', selectionIds: [] });

    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// POST /matches/:matchId/actions/initiative
// ===========================================================================

describe('POST /matches/:matchId/actions/initiative', () => {
  it('submits initiative choice successfully', async () => {
    givenStateExists();

    const res = await request(app)
      .post('/matches/test-match/actions/initiative')
      .send({ playerId: 'player-1', choice: 2 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(eng.submitInitiativeChoice).toHaveBeenCalledWith('player-1', 2);
  });

  it('returns 404 when match not found', async () => {
    givenStateNotFound();

    const res = await request(app)
      .post('/matches/test-match/actions/initiative')
      .send({ playerId: 'player-1', choice: 0 });

    expect(res.status).toBe(404);
  });

  it('returns 400 when engine throws', async () => {
    givenStateExists();
    eng.submitInitiativeChoice.mockImplementation(() => {
      throw new Error('Already submitted');
    });

    const res = await request(app)
      .post('/matches/test-match/actions/initiative')
      .send({ playerId: 'player-1', choice: 0 });

    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// POST /matches/:matchId/actions/attack
// ===========================================================================

describe('POST /matches/:matchId/actions/attack', () => {
  const body = {
    playerId: 'player-1',
    creatureInstanceId: 'creature-inst-1',
    destinationId: 'bf-1',
  };

  it('moves a unit to attack and returns updated state', async () => {
    givenStateExists();

    const res = await request(app)
      .post('/matches/test-match/actions/attack')
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(eng.moveUnit).toHaveBeenCalledWith('player-1', 'creature-inst-1', 'bf-1');
  });

  it('returns 403 when it is not the player\'s turn', async () => {
    givenStateExists();
    eng.canPlayerAct.mockReturnValue(false);

    const res = await request(app)
      .post('/matches/test-match/actions/attack')
      .send(body);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not your turn/i);
  });

  it('returns 400 when destinationId is missing', async () => {
    givenStateExists();

    const res = await request(app)
      .post('/matches/test-match/actions/attack')
      .send({ playerId: 'player-1', creatureInstanceId: 'inst-1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/destination required/i);
  });

  it('returns 400 when destinationId is "base"', async () => {
    givenStateExists();

    const res = await request(app)
      .post('/matches/test-match/actions/attack')
      .send({ playerId: 'player-1', creatureInstanceId: 'inst-1', destinationId: 'base' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/move endpoint/i);
  });

  it('returns 404 when match not found', async () => {
    givenStateNotFound();

    const res = await request(app)
      .post('/matches/test-match/actions/attack')
      .send(body);

    expect(res.status).toBe(404);
  });

  it('returns 400 when engine.moveUnit throws', async () => {
    givenStateExists();
    eng.moveUnit.mockImplementation(() => { throw new Error('Cannot attack'); });

    const res = await request(app)
      .post('/matches/test-match/actions/attack')
      .send(body);

    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// POST /matches/:matchId/actions/move
// ===========================================================================

describe('POST /matches/:matchId/actions/move', () => {
  const body = {
    playerId: 'player-1',
    creatureInstanceId: 'creature-inst-1',
    destinationId: 'base',
  };

  it('moves a unit and returns updated state', async () => {
    givenStateExists();

    const res = await request(app)
      .post('/matches/test-match/actions/move')
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(eng.moveUnit).toHaveBeenCalledWith('player-1', 'creature-inst-1', 'base');
  });

  it('returns 403 when it is not the player\'s turn', async () => {
    givenStateExists();
    eng.canPlayerAct.mockReturnValue(false);

    const res = await request(app)
      .post('/matches/test-match/actions/move')
      .send(body);

    expect(res.status).toBe(403);
  });

  it('returns 404 when match not found', async () => {
    givenStateNotFound();

    const res = await request(app)
      .post('/matches/test-match/actions/move')
      .send(body);

    expect(res.status).toBe(404);
  });

  it('returns 400 when engine throws', async () => {
    givenStateExists();
    eng.moveUnit.mockImplementation(() => { throw new Error('Unit is exhausted'); });

    const res = await request(app)
      .post('/matches/test-match/actions/move')
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unit is exhausted/i);
  });
});

// ===========================================================================
// POST /matches/:matchId/actions/hide-card
// ===========================================================================

describe('POST /matches/:matchId/actions/hide-card', () => {
  const body = { playerId: 'player-1', cardIndex: 0, battlefieldId: 'bf-1' };

  it('hides a card and returns updated state', async () => {
    givenStateExists();

    const res = await request(app)
      .post('/matches/test-match/actions/hide-card')
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(eng.hideCard).toHaveBeenCalledWith('player-1', 0, 'bf-1');
  });

  it('returns 403 when it is not the player\'s turn', async () => {
    givenStateExists();
    eng.canPlayerAct.mockReturnValue(false);

    const res = await request(app)
      .post('/matches/test-match/actions/hide-card')
      .send(body);

    expect(res.status).toBe(403);
  });

  it('returns 404 when match not found', async () => {
    givenStateNotFound();

    const res = await request(app)
      .post('/matches/test-match/actions/hide-card')
      .send(body);

    expect(res.status).toBe(404);
  });

  it('returns 400 when engine throws', async () => {
    givenStateExists();
    eng.hideCard.mockImplementation(() => { throw new Error('No Hidden keyword'); });

    const res = await request(app)
      .post('/matches/test-match/actions/hide-card')
      .send(body);

    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// POST /matches/:matchId/actions/activate-hidden
// ===========================================================================

describe('POST /matches/:matchId/actions/activate-hidden', () => {
  const body = { playerId: 'player-1', hiddenInstanceId: 'hidden-inst-1', targets: ['t1'] };

  it('activates hidden card and returns updated state', async () => {
    givenStateExists();

    const res = await request(app)
      .post('/matches/test-match/actions/activate-hidden')
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(eng.activateHiddenCard).toHaveBeenCalledWith('player-1', 'hidden-inst-1', ['t1']);
  });

  it('returns 404 when match not found', async () => {
    givenStateNotFound();

    const res = await request(app)
      .post('/matches/test-match/actions/activate-hidden')
      .send(body);

    expect(res.status).toBe(404);
  });

  it('returns 400 when engine throws', async () => {
    givenStateExists();
    eng.activateHiddenCard.mockImplementation(() => {
      throw new Error('Hidden card not found');
    });

    const res = await request(app)
      .post('/matches/test-match/actions/activate-hidden')
      .send(body);

    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// POST /matches/:matchId/actions/commence-battle
// ===========================================================================

describe('POST /matches/:matchId/actions/commence-battle', () => {
  const body = { playerId: 'player-1', battlefieldId: 'bf-1' };

  it('commences battle and returns updated state', async () => {
    givenStateExists();

    const res = await request(app)
      .post('/matches/test-match/actions/commence-battle')
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(eng.commenceBattle).toHaveBeenCalledWith('player-1', 'bf-1');
  });

  it('returns 403 when it is not the player\'s turn', async () => {
    givenStateExists();
    eng.canPlayerAct.mockReturnValue(false);

    const res = await request(app)
      .post('/matches/test-match/actions/commence-battle')
      .send(body);

    expect(res.status).toBe(403);
  });

  it('returns 404 when match not found', async () => {
    givenStateNotFound();

    const res = await request(app)
      .post('/matches/test-match/actions/commence-battle')
      .send(body);

    expect(res.status).toBe(404);
  });

  it('returns 400 when engine throws', async () => {
    givenStateExists();
    eng.commenceBattle.mockImplementation(() => {
      throw new Error('No units on battlefield');
    });

    const res = await request(app)
      .post('/matches/test-match/actions/commence-battle')
      .send(body);

    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// POST /matches/:matchId/actions/activate-legend
// ===========================================================================

describe('POST /matches/:matchId/actions/activate-legend', () => {
  it('activates legend ability and returns 200', async () => {
    givenStateExists();

    const res = await request(app)
      .post('/matches/test-match/actions/activate-legend')
      .send({ playerId: 'player-1', target: 'legend' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(eng.activateChampionAbility).toHaveBeenCalledWith('player-1', 'legend', null);
  });

  it('normalizes target "leader" correctly', async () => {
    givenStateExists();

    await request(app)
      .post('/matches/test-match/actions/activate-legend')
      .send({ playerId: 'player-1', target: 'leader', destinationId: 'bf-2' });

    expect(eng.activateChampionAbility).toHaveBeenCalledWith('player-1', 'leader', 'bf-2');
  });

  it('normalizes unknown target to "legend"', async () => {
    givenStateExists();

    await request(app)
      .post('/matches/test-match/actions/activate-legend')
      .send({ playerId: 'player-1', target: 'something-else' });

    expect(eng.activateChampionAbility).toHaveBeenCalledWith('player-1', 'legend', null);
  });

  it('returns 400 when playerId is missing', async () => {
    const res = await request(app)
      .post('/matches/test-match/actions/activate-legend')
      .send({ target: 'legend' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/playerId is required/i);
  });

  it('returns 404 when match not found', async () => {
    givenStateNotFound();

    const res = await request(app)
      .post('/matches/test-match/actions/activate-legend')
      .send({ playerId: 'player-1', target: 'legend' });

    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// POST /matches/:matchId/actions/pass-priority
// ===========================================================================

describe('POST /matches/:matchId/actions/pass-priority', () => {
  it('passes priority and returns updated state', async () => {
    givenStateExists();

    const res = await request(app)
      .post('/matches/test-match/actions/pass-priority')
      .send({ playerId: 'player-1' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(eng.passPriority).toHaveBeenCalledWith('player-1');
  });

  it('returns 400 when playerId is missing', async () => {
    const res = await request(app)
      .post('/matches/test-match/actions/pass-priority')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/playerId is required/i);
  });

  it('returns 404 when match not found', async () => {
    givenStateNotFound();

    const res = await request(app)
      .post('/matches/test-match/actions/pass-priority')
      .send({ playerId: 'player-1' });

    expect(res.status).toBe(404);
  });

  it('returns 400 when engine throws', async () => {
    givenStateExists();
    eng.passPriority.mockImplementation(() => {
      throw new Error('No priority window');
    });

    const res = await request(app)
      .post('/matches/test-match/actions/pass-priority')
      .send({ playerId: 'player-1' });

    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// POST /matches/:matchId/actions/respond-to-spell-reaction
// ===========================================================================

describe('POST /matches/:matchId/actions/respond-to-spell-reaction', () => {
  it('responds (pass=true) and returns updated state', async () => {
    givenStateExists();

    const res = await request(app)
      .post('/matches/test-match/actions/respond-to-spell-reaction')
      .send({ playerId: 'player-1', pass: true });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(eng.respondToSpellReaction).toHaveBeenCalledWith('player-1', true);
  });

  it('responds (pass=false) and returns updated state', async () => {
    givenStateExists();

    await request(app)
      .post('/matches/test-match/actions/respond-to-spell-reaction')
      .send({ playerId: 'player-1', pass: false });

    expect(eng.respondToSpellReaction).toHaveBeenCalledWith('player-1', false);
  });

  it('returns 400 when playerId is missing', async () => {
    const res = await request(app)
      .post('/matches/test-match/actions/respond-to-spell-reaction')
      .send({ pass: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/playerId is required/i);
  });

  it('returns 400 when pass is not a boolean', async () => {
    const res = await request(app)
      .post('/matches/test-match/actions/respond-to-spell-reaction')
      .send({ playerId: 'player-1', pass: 'yes' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pass.*boolean.*required/i);
  });

  it('returns 404 when match not found', async () => {
    givenStateNotFound();

    const res = await request(app)
      .post('/matches/test-match/actions/respond-to-spell-reaction')
      .send({ playerId: 'player-1', pass: true });

    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// POST /matches/:matchId/actions/respond-to-chain-reaction
// ===========================================================================

describe('POST /matches/:matchId/actions/respond-to-chain-reaction', () => {
  it('responds to chain reaction and returns updated state', async () => {
    givenStateExists();

    const res = await request(app)
      .post('/matches/test-match/actions/respond-to-chain-reaction')
      .send({ playerId: 'player-1', pass: true });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(eng.respondToChainReaction).toHaveBeenCalledWith('player-1', true);
  });

  it('returns 400 when playerId is missing', async () => {
    const res = await request(app)
      .post('/matches/test-match/actions/respond-to-chain-reaction')
      .send({ pass: false });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/playerId is required/i);
  });

  it('returns 400 when pass is not a boolean', async () => {
    const res = await request(app)
      .post('/matches/test-match/actions/respond-to-chain-reaction')
      .send({ playerId: 'player-1', pass: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pass.*boolean.*required/i);
  });

  it('returns 404 when match not found', async () => {
    givenStateNotFound();

    const res = await request(app)
      .post('/matches/test-match/actions/respond-to-chain-reaction')
      .send({ playerId: 'player-1', pass: true });

    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// POST /matches/:matchId/actions/next-phase
// ===========================================================================

describe('POST /matches/:matchId/actions/next-phase', () => {
  it('advances the phase and returns updated state', async () => {
    givenStateExists();

    const res = await request(app)
      .post('/matches/test-match/actions/next-phase')
      .send({ playerId: 'player-1' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(eng.proceedToNextPhase).toHaveBeenCalled();
  });

  it('returns 403 when it is not the player\'s turn', async () => {
    givenStateExists();
    eng.canPlayerAct.mockReturnValue(false);

    const res = await request(app)
      .post('/matches/test-match/actions/next-phase')
      .send({ playerId: 'player-1' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not your turn/i);
  });

  it('returns 404 when match not found', async () => {
    givenStateNotFound();

    const res = await request(app)
      .post('/matches/test-match/actions/next-phase')
      .send({ playerId: 'player-1' });

    expect(res.status).toBe(404);
  });

  it('returns 400 when engine throws', async () => {
    givenStateExists();
    eng.proceedToNextPhase.mockImplementation(() => {
      throw new Error('Cannot advance phase');
    });

    const res = await request(app)
      .post('/matches/test-match/actions/next-phase')
      .send({ playerId: 'player-1' });

    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// POST /matches/:matchId/logs  (duel log — two paths)
// ===========================================================================

describe('POST /matches/:matchId/logs (duel log)', () => {
  const body = {
    playerId: 'player-1',
    actorName: 'Alice',
    message: 'Hello from the duel!',
    tone: 'normal',
    entryId: 'entry-42',
  };

  it('appends a duel log entry via /logs and returns it', async () => {
    givenStateExists();

    const res = await request(app)
      .post('/matches/test-match/logs')
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.entry).toBeDefined();
    expect(eng.addDuelLogEntry).toHaveBeenCalledWith(expect.objectContaining({
      playerId: 'player-1',
      message: 'Hello from the duel!',
    }));
  });

  it('appends a duel log entry via /actions/duel-log alias', async () => {
    givenStateExists();

    const res = await request(app)
      .post('/matches/test-match/actions/duel-log')
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('returns 404 when match not found', async () => {
    givenStateNotFound();

    const res = await request(app)
      .post('/matches/test-match/logs')
      .send(body);

    expect(res.status).toBe(404);
  });

  it('returns 400 when engine.addDuelLogEntry throws', async () => {
    givenStateExists();
    eng.addDuelLogEntry.mockImplementation(() => {
      throw new Error('Invalid log entry');
    });

    const res = await request(app)
      .post('/matches/test-match/logs')
      .send(body);

    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// POST /matches/:matchId/chat  (chat — two paths)
// ===========================================================================

describe('POST /matches/:matchId/chat', () => {
  const body = {
    playerId: 'player-1',
    playerName: 'Alice',
    message: 'Good luck!',
  };

  it('sends a chat message via /chat and returns it', async () => {
    givenStateExists();

    const res = await request(app)
      .post('/matches/test-match/chat')
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBeDefined();
    expect(eng.addChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      playerId: 'player-1',
      message: 'Good luck!',
    }));
  });

  it('sends a chat message via /actions/chat alias', async () => {
    givenStateExists();

    const res = await request(app)
      .post('/matches/test-match/actions/chat')
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('returns 400 when playerId is missing', async () => {
    const res = await request(app)
      .post('/matches/test-match/chat')
      .send({ playerName: 'Alice', message: 'Hi' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/player id is required/i);
  });

  it('returns 400 when playerId is empty string', async () => {
    const res = await request(app)
      .post('/matches/test-match/chat')
      .send({ playerId: '', message: 'Hi' });

    expect(res.status).toBe(400);
  });

  it('returns 404 when match not found', async () => {
    givenStateNotFound();

    const res = await request(app)
      .post('/matches/test-match/chat')
      .send(body);

    expect(res.status).toBe(404);
  });

  it('returns 400 when engine.addChatMessage throws', async () => {
    givenStateExists();
    eng.addChatMessage.mockImplementation(() => {
      throw new Error('Chat disabled');
    });

    const res = await request(app)
      .post('/matches/test-match/chat')
      .send(body);

    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// POST /matches/:matchId/result
// ===========================================================================

describe('POST /matches/:matchId/result', () => {
  it('reports match result and persists to DynamoDB', async () => {
    givenStateExists();

    const res = await request(app)
      .post('/matches/test-match/result')
      .send({ winner: 'player-1', reason: 'victory_points' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.matchResult).toBeDefined();
    expect(res.body.matchResult.winner).toBe('player-1');
    // DynamoDB put should have been called for match persistence
    expect(db._putPromise).toHaveBeenCalled();
  });

  it('uses engine.getMatchResult() when available', async () => {
    givenStateExists();
    eng.getMatchResult.mockReturnValue({
      matchId: 'test-match',
      winner: 'player-1',
      loser: 'player-2',
      reason: 'health_depleted',
      duration: 5000,
      turns: 3,
      moves: [],
    });

    const res = await request(app)
      .post('/matches/test-match/result')
      .send({ winner: 'player-1' });

    expect(res.status).toBe(200);
    expect(res.body.matchResult.reason).toBe('health_depleted');
  });

  it('falls back to constructing matchResult when engine returns null', async () => {
    givenStateExists();
    eng.getMatchResult.mockReturnValue(null);

    const res = await request(app)
      .post('/matches/test-match/result')
      .send({ winner: 'player-2', reason: 'timeout' });

    expect(res.status).toBe(200);
    expect(res.body.matchResult.winner).toBe('player-2');
    expect(res.body.matchResult.reason).toBe('timeout');
  });

  it('returns 400 when winner is missing', async () => {
    givenStateExists();

    const res = await request(app)
      .post('/matches/test-match/result')
      .send({ reason: 'timeout' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/winner must be specified/i);
  });

  it('returns 404 when match not found', async () => {
    givenStateNotFound();

    const res = await request(app)
      .post('/matches/test-match/result')
      .send({ winner: 'player-1' });

    expect(res.status).toBe(404);
  });

  it('skips duplicate persist when match already has completed status in DB', async () => {
    givenStateExists();
    // Query returns an existing completed match
    db._queryPromise.mockResolvedValue({ Items: [{ Status: 'completed' }] });

    const res = await request(app)
      .post('/matches/test-match/result')
      .send({ winner: 'player-1' });

    expect(res.status).toBe(200);
    // put should NOT have been called for match table (deduplication)
    const putCalls = db.put.mock.calls;
    const matchTablePuts = putCalls.filter((c: any[]) =>
      c[0]?.TableName?.includes('matches') && !c[0]?.TableName?.includes('states')
    );
    expect(matchTablePuts.length).toBe(0);
  });

  it('returns 500 when DynamoDB throws during persist', async () => {
    givenStateExists();
    db._putPromise.mockRejectedValue(new Error('Write failed'));

    const res = await request(app)
      .post('/matches/test-match/result')
      .send({ winner: 'player-1' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to report/i);
  });
});

// ===========================================================================
// POST /matches/:matchId/concede
// ===========================================================================

describe('POST /matches/:matchId/concede', () => {
  it('processes concession and returns result', async () => {
    givenStateExists();

    const res = await request(app)
      .post('/matches/test-match/concede')
      .send({ playerId: 'player-1' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.matchResult.winner).toBe('player-2');
    expect(eng.concedeMatch).toHaveBeenCalledWith('player-1');
  });

  it('returns 400 when playerId is missing', async () => {
    const res = await request(app)
      .post('/matches/test-match/concede')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/playerId is required/i);
  });

  it('returns 404 when match not found', async () => {
    givenStateNotFound();

    const res = await request(app)
      .post('/matches/test-match/concede')
      .send({ playerId: 'player-1' });

    expect(res.status).toBe(404);
  });

  it('returns 500 when engine.concedeMatch throws', async () => {
    givenStateExists();
    eng.concedeMatch.mockImplementation(() => {
      throw new Error('Match already over');
    });

    const res = await request(app)
      .post('/matches/test-match/concede')
      .send({ playerId: 'player-1' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/match already over/i);
  });
});

// ===========================================================================
// GET /matches/:matchId/history
// ===========================================================================

describe('GET /matches/:matchId/history', () => {
  it('returns move history for an existing match', async () => {
    const state = makeGameState({ moveHistory: [{ type: 'play-card' }, { type: 'next-phase' }] });
    givenStateExists(state);

    const res = await request(app).get('/matches/test-match/history');

    expect(res.status).toBe(200);
    expect(res.body.matchId).toBe('test-match');
    expect(res.body.moves).toHaveLength(2);
    expect(res.body.turnCount).toBe(1);
    expect(res.body.status).toBe('in_progress');
  });

  it('returns 404 when match not found', async () => {
    givenStateNotFound();

    const res = await request(app).get('/matches/unknown-match/history');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not available/i);
  });

  it('returns 500 when DynamoDB throws', async () => {
    db._getPromise.mockRejectedValue(new Error('DB error'));

    const res = await request(app).get('/matches/test-match/history');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to fetch match history/i);
  });
});

// ===========================================================================
// Edge cases & middleware
// ===========================================================================

describe('requestId middleware', () => {
  it('assigns a requestId to every incoming request', async () => {
    givenStateExists();
    // Any route will do — just verify the middleware runs (no error from missing requestId)
    const res = await request(app).get('/matches/test-match');
    expect(res.status).toBe(200);
  });
});

describe('saveGameState — auto-finalize on WINNER_DETERMINED', () => {
  it('triggers persistMatchFinalState when status is winner_determined', async () => {
    givenStateExists();
    const winnerState = makeGameState({ status: 'winner_determined' });
    eng.getGameState.mockReturnValue(winnerState);
    eng.getMatchResult.mockReturnValue({
      matchId: 'test-match', winner: 'player-1', loser: 'player-2',
      reason: 'health_depleted', duration: 3000, turns: 5, moves: [],
    });

    // Trigger any action that calls saveGameState
    const res = await request(app)
      .post('/matches/test-match/actions/next-phase')
      .send({ playerId: 'player-1' });

    // The route itself responds with 200
    expect(res.status).toBe(200);
    // persistMatchFinalState calls dynamodb.put for the match record
    expect(db._putPromise).toHaveBeenCalled();
  });
});
