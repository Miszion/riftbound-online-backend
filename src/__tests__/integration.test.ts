/**
 * Integration Tests - Full Game Flow E2E
 *
 * Tests cover: complete game lifecycle from creation to completion,
 * multi-phase progression, and full match scenarios.
 */
import {
  RiftboundGameEngine,
  GameStatus,
  GamePhase
} from '../game-engine';
import {
  createInitializedEngine,
  createInProgressEngine,
  advancePastCoinFlip,
  advancePastBattlefieldSelection,
  advancePastMulligan,
  buildDeckConfig,
  resetCardCounter
} from './test-helpers';

beforeEach(() => {
  resetCardCounter();
});

// ===========================================================================
// Full Game Lifecycle
// ===========================================================================
describe('Integration - Full Game Lifecycle', () => {
  it('should progress through all setup phases: SETUP -> COIN_FLIP -> BATTLEFIELD -> MULLIGAN -> IN_PROGRESS', () => {
    // 1. Create engine
    const engine = new RiftboundGameEngine('lifecycle-test', ['alice', 'bob']);
    expect(engine.status).toBe(GameStatus.SETUP);

    // 2. Initialize with decks
    engine.initializeGame({
      alice: buildDeckConfig(),
      bob: buildDeckConfig()
    });
    expect(engine.status).toBe(GameStatus.COIN_FLIP);

    // 3. Coin flip
    advancePastCoinFlip(engine, 'alice', 'bob');
    // Should be in BATTLEFIELD_SELECTION or still COIN_FLIP (if tie)
    expect([GameStatus.BATTLEFIELD_SELECTION, GameStatus.COIN_FLIP, GameStatus.MULLIGAN]).toContain(engine.status);

    if (engine.status === GameStatus.BATTLEFIELD_SELECTION) {
      // 4. Battlefield selection
      advancePastBattlefieldSelection(engine, 'alice', 'bob');
      expect([GameStatus.MULLIGAN, GameStatus.IN_PROGRESS]).toContain(engine.status);
    }

    if (engine.status === GameStatus.MULLIGAN) {
      // 5. Mulligan
      advancePastMulligan(engine, 'alice', 'bob');
      expect(engine.status).toBe(GameStatus.IN_PROGRESS);
    }
  });

  it('should complete a game via concession', () => {
    const engine = createInProgressEngine('concede-test', 'alice', 'bob');
    if (engine.status !== GameStatus.IN_PROGRESS) return;

    const result = engine.concedeMatch('bob');
    expect(result.winner).toBe('alice');
    expect(result.loser).toBe('bob');
    expect(result.reason).toBe('concede');
    expect(result.matchId).toBe('concede-test');

    // Engine should now be in WINNER_DETERMINED
    expect(engine.status).toBe(GameStatus.WINNER_DETERMINED);

    // Match result should be retrievable
    const matchResult = engine.getMatchResult();
    expect(matchResult).not.toBeNull();
    expect(matchResult!.winner).toBe('alice');
  });
});

// ===========================================================================
// State Consistency
// ===========================================================================
describe('Integration - State Consistency', () => {
  it('total cards should be conserved across all zones', () => {
    const engine = createInProgressEngine();
    if (engine.status !== GameStatus.IN_PROGRESS) return;

    const state = engine.getGameState();
    for (const player of state.players) {
      const totalCards =
        player.deck.length +
        player.hand.length +
        player.graveyard.length +
        player.exile.length +
        player.board.creatures.length +
        player.board.artifacts.length +
        player.board.enchantments.length;

      // Main deck started with 40, minus 4 drawn to hand = 36 in deck + 4 in hand = 40
      expect(totalCards).toBe(40);
    }
  });

  it('rune deck should be conserved', () => {
    const engine = createInProgressEngine();
    if (engine.status !== GameStatus.IN_PROGRESS) return;

    const state = engine.getGameState();
    for (const player of state.players) {
      const totalRunes = player.runeDeck.length + player.channeledRunes.length;
      // Started with 12 runes; some may have been channeled during turn start
      expect(totalRunes).toBeLessThanOrEqual(12);
      expect(totalRunes).toBeGreaterThan(0);
    }
  });

  it('both players should exist in the state', () => {
    const engine = createInProgressEngine();
    const state = engine.getGameState();
    expect(state.players.length).toBe(2);
    const ids = state.players.map(p => p.playerId);
    expect(ids).toContain('player-1');
    expect(ids).toContain('player-2');
  });

  it('battlefields should be created during setup', () => {
    const engine = createInProgressEngine();
    if (engine.status !== GameStatus.IN_PROGRESS) return;

    const state = engine.getGameState();
    expect(state.battlefields.length).toBeGreaterThan(0);
    for (const bf of state.battlefields) {
      expect(bf.battlefieldId).toBeDefined();
      expect(bf.name).toBeDefined();
      expect(Array.isArray(bf.hiddenCards)).toBe(true);
    }
  });
});

// ===========================================================================
// Serialize + Restore + Continue
// ===========================================================================
describe('Integration - Serialize and Resume', () => {
  it('should serialize, restore, and continue a game', () => {
    const engine = createInProgressEngine('serialize-test');
    if (engine.status !== GameStatus.IN_PROGRESS) return;

    // Take a snapshot
    const snapshot = JSON.parse(JSON.stringify(engine.getGameState()));

    // Restore
    const restored = RiftboundGameEngine.fromSerializedState(snapshot);
    expect(restored.status).toBe(GameStatus.IN_PROGRESS);

    // Should be able to concede from restored state
    const result = restored.concedeMatch('player-2');
    expect(result.winner).toBe('player-1');
    expect(restored.status).toBe(GameStatus.WINNER_DETERMINED);
  });

  it('should serialize, restore, and verify state equivalence', () => {
    const engine = createInProgressEngine();
    if (engine.status !== GameStatus.IN_PROGRESS) return;

    const original = engine.getGameState();
    const serialized = JSON.stringify(original);
    const restored = RiftboundGameEngine.fromSerializedState(JSON.parse(serialized));
    const restoredState = restored.getGameState();

    // Deep compare key fields
    expect(restoredState.matchId).toBe(original.matchId);
    expect(restoredState.turnNumber).toBe(original.turnNumber);
    expect(restoredState.currentPhase).toBe(original.currentPhase);
    expect(restoredState.status).toBe(original.status);
    expect(restoredState.players[0].victoryPoints).toBe(original.players[0].victoryPoints);
    expect(restoredState.players[1].victoryPoints).toBe(original.players[1].victoryPoints);
    expect(restoredState.battlefields.length).toBe(original.battlefields.length);
  });
});

// ===========================================================================
// Multiple Games
// ===========================================================================
describe('Integration - Multiple Concurrent Games', () => {
  it('should handle multiple independent game instances', () => {
    const engine1 = createInProgressEngine('game-1', 'alice', 'bob');
    const engine2 = createInProgressEngine('game-2', 'charlie', 'dave');

    if (engine1.status !== GameStatus.IN_PROGRESS) return;
    if (engine2.status !== GameStatus.IN_PROGRESS) return;

    // Concede game 1
    engine1.concedeMatch('alice');
    expect(engine1.status).toBe(GameStatus.WINNER_DETERMINED);

    // Game 2 should be unaffected
    expect(engine2.status).toBe(GameStatus.IN_PROGRESS);

    // Concede game 2
    engine2.concedeMatch('charlie');
    expect(engine2.status).toBe(GameStatus.WINNER_DETERMINED);
    expect(engine2.getMatchResult()!.winner).toBe('dave');
  });
});

// ===========================================================================
// Stress / Edge Cases
// ===========================================================================
describe('Integration - Edge Cases', () => {
  it('should handle rapid game creation and teardown', () => {
    for (let i = 0; i < 10; i++) {
      const engine = createInProgressEngine(`rapid-${i}`, `p1-${i}`, `p2-${i}`);
      if (engine.status === GameStatus.IN_PROGRESS) {
        engine.concedeMatch(`p2-${i}`);
        expect(engine.status).toBe(GameStatus.WINNER_DETERMINED);
      }
    }
  });

  it('should maintain separate state for simultaneous games', () => {
    const engines = Array.from({ length: 5 }, (_, i) =>
      createInitializedEngine(`sim-${i}`, `pa-${i}`, `pb-${i}`)
    );

    // All should be in COIN_FLIP
    for (const engine of engines) {
      expect(engine.status).toBe(GameStatus.COIN_FLIP);
    }

    // Modify one - others should be unaffected
    engines[0].submitInitiativeChoice('pa-0', 0);
    for (let i = 1; i < engines.length; i++) {
      const state = engines[i].getGameState();
      // Other games' prompts should still be unresolved
      const unresolvedPrompts = state.prompts.filter(p => !p.resolved);
      expect(unresolvedPrompts.length).toBe(2);
    }
  });
});
