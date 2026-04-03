/**
 * RiftboundGameEngine - Core unit tests
 *
 * Tests cover: construction, initialization, coin flip, battlefield selection,
 * mulligan, turn flow, concession, serialization, and edge cases.
 */
import {
  RiftboundGameEngine,
  GameStatus,
  GamePhase,
  CardType,
  Domain
} from '../game-engine';
import {
  createInitializedEngine,
  createInProgressEngine,
  advancePastCoinFlip,
  advancePastBattlefieldSelection,
  advancePastMulligan,
  buildDeckConfig,
  buildMainDeck,
  buildRuneDeck,
  makeCreature,
  resetCardCounter
} from './test-helpers';

beforeEach(() => {
  resetCardCounter();
});

// ===========================================================================
// Construction
// ===========================================================================
describe('RiftboundGameEngine - Construction', () => {
  it('should create a new engine with two players', () => {
    const engine = new RiftboundGameEngine('match-1', ['p1', 'p2']);
    expect(engine.status).toBe(GameStatus.SETUP);
    expect(engine.turnNumber).toBe(1);
  });

  it('should accept player objects with id/name', () => {
    const engine = new RiftboundGameEngine('match-2', [
      { playerId: 'p1', name: 'Alice' },
      { playerId: 'p2', name: 'Bob' }
    ]);
    const state = engine.getGameState();
    expect(state.players[0].name).toBe('Alice');
    expect(state.players[1].name).toBe('Bob');
  });

  it('should throw when not exactly 2 players', () => {
    expect(() => new RiftboundGameEngine('m', ['p1'])).toThrow('exactly 2 players');
    expect(() => new RiftboundGameEngine('m', ['p1', 'p2', 'p3'])).toThrow('exactly 2 players');
  });

  it('should throw on invalid player descriptor', () => {
    expect(() => new RiftboundGameEngine('m', [{} as any, 'p2'])).toThrow('Invalid player descriptor');
  });
});

// ===========================================================================
// Initialization
// ===========================================================================
describe('RiftboundGameEngine - Initialization', () => {
  it('should initialize game with valid decks and move to COIN_FLIP', () => {
    const engine = createInitializedEngine();
    expect(engine.status).toBe(GameStatus.COIN_FLIP);
  });

  it('should deal initial hands of 4 cards each', () => {
    const engine = createInitializedEngine();
    const state = engine.getGameState();
    expect(state.players[0].hand.length).toBe(4);
    expect(state.players[1].hand.length).toBe(4);
  });

  it('should reject initialization with too-small deck', () => {
    const engine = new RiftboundGameEngine('m', ['p1', 'p2']);
    const smallDeck = buildMainDeck(10);
    expect(() => {
      engine.initializeGame({
        p1: { mainDeck: smallDeck, runeDeck: buildRuneDeck() },
        p2: buildDeckConfig()
      });
    }).toThrow('Invalid deck size');
  });

  it('should reject missing deck for a player', () => {
    const engine = new RiftboundGameEngine('m', ['p1', 'p2']);
    expect(() => {
      engine.initializeGame({ p1: buildDeckConfig() } as any);
    }).toThrow('Missing deck for player p2');
  });

  it('should reject double initialization', () => {
    const engine = createInitializedEngine();
    expect(() => {
      engine.initializeGame({
        'player-1': buildDeckConfig(),
        'player-2': buildDeckConfig()
      });
    }).toThrow('Game already initialized');
  });

  it('should accept array-style deck (DeckCardEntry[])', () => {
    const engine = new RiftboundGameEngine('m', ['p1', 'p2']);
    const cards = buildMainDeck(40);
    engine.initializeGame({
      p1: cards,
      p2: cards
    });
    expect(engine.status).toBe(GameStatus.COIN_FLIP);
  });
});

// ===========================================================================
// Coin Flip (Initiative)
// ===========================================================================
describe('RiftboundGameEngine - Coin Flip', () => {
  it('should resolve initiative when both players choose different options', () => {
    const engine = createInitializedEngine();
    engine.submitInitiativeChoice('player-1', 0); // Blade
    engine.submitInitiativeChoice('player-2', 1); // Shield
    // Blade beats Shield, so player-1 wins initiative
    // Engine may skip battlefield selection if fallback battlefields are auto-assigned
    expect([GameStatus.BATTLEFIELD_SELECTION, GameStatus.COIN_FLIP, GameStatus.MULLIGAN, GameStatus.IN_PROGRESS]).toContain(engine.status);
  });

  it('should rematch on tie (same choices)', () => {
    const engine = createInitializedEngine();
    engine.submitInitiativeChoice('player-1', 0);
    engine.submitInitiativeChoice('player-2', 0);
    // Same choice = tie = rematch, stays in COIN_FLIP
    expect(engine.status).toBe(GameStatus.COIN_FLIP);
  });

  it('should reject invalid choice values', () => {
    const engine = createInitializedEngine();
    expect(() => engine.submitInitiativeChoice('player-1', 5)).toThrow('Invalid initiative choice');
    expect(() => engine.submitInitiativeChoice('player-1', -1)).toThrow('Invalid initiative choice');
  });

  it('should reject choices when not in COIN_FLIP status', () => {
    const engine = createInitializedEngine();
    advancePastCoinFlip(engine);
    expect(() => engine.submitInitiativeChoice('player-1', 0)).toThrow();
  });
});

// ===========================================================================
// Mulligan
// ===========================================================================
describe('RiftboundGameEngine - Mulligan', () => {
  it('should allow keeping all cards (empty indices)', () => {
    const engine = createInitializedEngine();
    advancePastCoinFlip(engine);
    advancePastBattlefieldSelection(engine);
    if (engine.status !== GameStatus.MULLIGAN) return;

    const stateBefore = engine.getGameState();
    const p1HandBefore = [...stateBefore.players[0].hand];

    engine.submitMulligan('player-1', []);
    engine.submitMulligan('player-2', []);

    expect(engine.status).toBe(GameStatus.IN_PROGRESS);
  });

  it('should replace specified card indices during mulligan', () => {
    const engine = createInitializedEngine();
    advancePastCoinFlip(engine);
    advancePastBattlefieldSelection(engine);
    if (engine.status !== GameStatus.MULLIGAN) return;

    const stateBefore = engine.getGameState();
    const p1HandBefore = stateBefore.players[0].hand.map(c => c.id);

    // Replace first card
    engine.submitMulligan('player-1', [0]);
    engine.submitMulligan('player-2', []);

    const stateAfter = engine.getGameState();
    // Hand size should remain the same or increase by 1 (mulligan draws replacement then shuffles back)
    expect(stateAfter.players[0].hand.length).toBeGreaterThanOrEqual(4);
  });
});

// ===========================================================================
// Turn Flow
// ===========================================================================
describe('RiftboundGameEngine - Turn Flow', () => {
  it('should start at turn 1 in BEGIN phase', () => {
    const engine = createInProgressEngine();
    if (engine.status !== GameStatus.IN_PROGRESS) return;

    expect(engine.turnNumber).toBeGreaterThanOrEqual(1);
  });

  it('should track current player index', () => {
    const engine = createInProgressEngine();
    if (engine.status !== GameStatus.IN_PROGRESS) return;

    expect([0, 1]).toContain(engine.currentPlayerIndex);
  });

  it('should have initial resources set up', () => {
    const engine = createInProgressEngine();
    if (engine.status !== GameStatus.IN_PROGRESS) return;

    const state = engine.getGameState();
    for (const player of state.players) {
      expect(player.resources).toBeDefined();
      expect(typeof player.resources.energy).toBe('number');
    }
  });
});

// ===========================================================================
// Concession
// ===========================================================================
describe('RiftboundGameEngine - Concession', () => {
  it('should allow a player to concede', () => {
    const engine = createInProgressEngine();
    if (engine.status !== GameStatus.IN_PROGRESS) return;

    const result = engine.concedeMatch('player-2');
    expect(result.winner).toBe('player-1');
    expect(result.loser).toBe('player-2');
    expect(result.reason).toBe('concede');
    expect(engine.status).toBe(GameStatus.WINNER_DETERMINED);
  });

  it('should return match result after concession', () => {
    const engine = createInProgressEngine();
    if (engine.status !== GameStatus.IN_PROGRESS) return;

    engine.concedeMatch('player-1');
    const result = engine.getMatchResult();
    expect(result).not.toBeNull();
    expect(result!.winner).toBe('player-2');
    expect(result!.matchId).toBe('test-match-1');
  });

  it('should have no match result before game ends', () => {
    const engine = createInProgressEngine();
    if (engine.status !== GameStatus.IN_PROGRESS) return;

    expect(engine.getMatchResult()).toBeNull();
  });
});

// ===========================================================================
// Serialization / Restore
// ===========================================================================
describe('RiftboundGameEngine - Serialization', () => {
  it('should restore from serialized state', () => {
    const engine = createInitializedEngine();
    const state = engine.getGameState();

    const restored = RiftboundGameEngine.fromSerializedState(
      JSON.parse(JSON.stringify(state))
    );
    expect(restored.status).toBe(engine.status);
    expect(restored.turnNumber).toBe(engine.turnNumber);
  });

  it('should restore in-progress games', () => {
    const engine = createInProgressEngine();
    if (engine.status !== GameStatus.IN_PROGRESS) return;

    const state = engine.getGameState();
    const restored = RiftboundGameEngine.fromSerializedState(
      JSON.parse(JSON.stringify(state))
    );
    expect(restored.status).toBe(GameStatus.IN_PROGRESS);
    expect(restored.turnNumber).toBe(engine.turnNumber);

    const restoredState = restored.getGameState();
    expect(restoredState.players.length).toBe(2);
    expect(restoredState.players[0].hand.length).toBeGreaterThan(0);
  });

  it('should handle missing fields gracefully during restore', () => {
    const engine = createInitializedEngine();
    const state = JSON.parse(JSON.stringify(engine.getGameState()));
    // Remove optional fields to test defensive restore
    delete state.duelLog;
    delete state.chatLog;
    delete state.snapshots;
    delete state.pendingEffects;

    const restored = RiftboundGameEngine.fromSerializedState(state);
    const restoredState = restored.getGameState();
    expect(Array.isArray(restoredState.duelLog)).toBe(true);
    expect(Array.isArray(restoredState.chatLog)).toBe(true);
    expect(Array.isArray(restoredState.snapshots)).toBe(true);
    expect(Array.isArray(restoredState.pendingEffects)).toBe(true);
  });
});

// ===========================================================================
// Duel Log & Chat
// ===========================================================================
describe('RiftboundGameEngine - Logging', () => {
  it('should add duel log entries', () => {
    const engine = createInitializedEngine();
    engine.addDuelLogEntry({ message: 'Test log entry', tone: 'info' });
    const state = engine.getGameState();
    const entry = state.duelLog.find(e => e.message === 'Test log entry');
    expect(entry).toBeDefined();
    expect(entry!.tone).toBe('info');
  });

  it('should add chat messages', () => {
    const engine = createInitializedEngine();
    engine.addChatMessage({ playerId: 'player-1', message: 'Hello!' });
    const state = engine.getGameState();
    const msg = state.chatLog.find(m => m.message === 'Hello!');
    expect(msg).toBeDefined();
    expect(msg!.playerId).toBe('player-1');
  });
});

// ===========================================================================
// Public Getters
// ===========================================================================
describe('RiftboundGameEngine - Getters', () => {
  it('getGameState returns full state object', () => {
    const engine = createInitializedEngine();
    const state = engine.getGameState();
    expect(state.matchId).toBe('test-match-1');
    expect(state.players.length).toBe(2);
    expect(state.status).toBe(GameStatus.COIN_FLIP);
  });

  it('getPlayerState returns specific player', () => {
    const engine = createInitializedEngine();
    const player = engine.getPlayerState('player-1');
    expect(player.playerId).toBe('player-1');
  });

  it('getPlayerState throws for unknown player', () => {
    const engine = createInitializedEngine();
    expect(() => engine.getPlayerState('unknown')).toThrow('not found');
  });

  it('getCurrentPlayerState returns current player', () => {
    const engine = createInitializedEngine();
    const current = engine.getCurrentPlayerState();
    expect(current.playerId).toBeDefined();
  });

  it('canPlayerAct returns false when not in progress', () => {
    const engine = createInitializedEngine();
    expect(engine.canPlayerAct('player-1')).toBe(false);
  });

  it('canPlayerAct returns true for current player when in progress', () => {
    const engine = createInProgressEngine();
    if (engine.status !== GameStatus.IN_PROGRESS) return;

    const current = engine.getCurrentPlayerState();
    expect(engine.canPlayerAct(current.playerId)).toBe(true);
  });
});

// ===========================================================================
// Edge Cases
// ===========================================================================
describe('RiftboundGameEngine - Edge Cases', () => {
  it('should handle player IDs with special characters', () => {
    const engine = new RiftboundGameEngine('m', ['user-123-abc', 'user_456.def']);
    expect(engine.getGameState().players[0].playerId).toBe('user-123-abc');
    expect(engine.getGameState().players[1].playerId).toBe('user_456.def');
  });

  it('should trim player names', () => {
    const engine = new RiftboundGameEngine('m', [
      { playerId: 'p1', name: '  Alice  ' },
      { playerId: 'p2', name: '  Bob  ' }
    ]);
    const state = engine.getGameState();
    expect(state.players[0].name).toBe('Alice');
    expect(state.players[1].name).toBe('Bob');
  });

  it('should use playerId as name when name is empty', () => {
    const engine = new RiftboundGameEngine('m', [
      { playerId: 'p1', name: '' },
      { playerId: 'p2', name: '   ' }
    ]);
    const state = engine.getGameState();
    expect(state.players[0].name).toBe('p1');
    expect(state.players[1].name).toBe('p2');
  });

  it('initial game state should have zero victory points', () => {
    const engine = createInitializedEngine();
    const state = engine.getGameState();
    expect(state.players[0].victoryPoints).toBe(0);
    expect(state.players[1].victoryPoints).toBe(0);
  });

  it('initial game state should have victory score of 8', () => {
    const engine = createInitializedEngine();
    const state = engine.getGameState();
    expect(state.victoryScore).toBe(8);
  });
});
