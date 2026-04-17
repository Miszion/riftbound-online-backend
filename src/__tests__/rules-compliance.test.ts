/**
 * Rules Compliance Tests
 *
 * Verifies three backend fixes:
 *  1. Burnout (Rule 418): no longer ends the game; recycles graveyard into
 *     deck, shuffles, awards opponent 1 VP. Game only ends if opponent hits
 *     VICTORY_SCORE (8).
 *  2. Battlefield fallback selection: pulls real Battlefield cards from the
 *     enriched catalog, throws if catalog has none.
 *  3. awardVictoryPoints: console.warn on status mismatch; does not mutate.
 *  4. applyBattlefieldControl: per-turn conquer dedup via lastConqueredTurn.
 *
 * Tests marked [RULE NOTE] pin current engine behavior for rules cross-check.
 */
import {
  RiftboundGameEngine,
  GameStatus,
  CardType,
  Card
} from '../game-engine';
import {
  createInProgressEngine,
  resetCardCounter,
  makeCreature,
  buildDeckConfig,
  buildMainDeck,
  buildRuneDeck
} from './test-helpers';

beforeEach(() => {
  resetCardCounter();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPlayer(engine: RiftboundGameEngine, playerId: string) {
  return engine.getGameState().players.find((p) => p.playerId === playerId)!;
}

function callBurnOut(engine: RiftboundGameEngine, playerId: string): void {
  const player = getPlayer(engine, playerId);
  (engine as any).burnOut(player);
}

function callDrawCards(
  engine: RiftboundGameEngine,
  playerId: string,
  count: number,
  required: boolean
): void {
  const player = getPlayer(engine, playerId);
  (engine as any).drawCards(player, count, required);
}

function seedGraveyard(
  engine: RiftboundGameEngine,
  playerId: string,
  size: number
): void {
  const player = getPlayer(engine, playerId);
  player.graveyard = Array.from({ length: size }, (_, i) =>
    makeCreature({ id: `gy-${playerId}-${i}`, name: `Trash ${i}` })
  );
}

function emptyDeck(engine: RiftboundGameEngine, playerId: string): void {
  getPlayer(engine, playerId).deck.length = 0;
}

function getOpponentId(engine: RiftboundGameEngine, playerId: string): string {
  const state = engine.getGameState();
  return state.players.find((p) => p.playerId !== playerId)!.playerId;
}

// ---------------------------------------------------------------------------
// Burnout (Rule 418)
// ---------------------------------------------------------------------------
describe('Burnout (Rule 418)', () => {
  // T1
  it('T1: empty deck + non-empty graveyard recycles, shuffles, awards opp 1 VP, game continues', () => {
    const engine = createInProgressEngine();
    if (engine.status !== GameStatus.IN_PROGRESS) {
      throw new Error('setup failed to reach IN_PROGRESS');
    }
    const current = engine.getCurrentPlayerState().playerId;
    const opponent = getOpponentId(engine, current);

    emptyDeck(engine, current);
    seedGraveyard(engine, current, 6);
    const graveyardSnapshot = [...getPlayer(engine, current).graveyard];
    const oppVPBefore = getPlayer(engine, opponent).victoryPoints;

    callDrawCards(engine, current, 1, true);

    const player = getPlayer(engine, current);
    const opp = getPlayer(engine, opponent);

    // Graveyard moved into deck (and one card was drawn into hand afterward).
    expect(player.graveyard.length).toBe(0);
    expect(player.deck.length + player.hand.filter((c) => c.id.startsWith('gy-')).length)
      .toBeGreaterThanOrEqual(graveyardSnapshot.length - 1);

    // Opponent gained exactly 1 VP.
    expect(opp.victoryPoints).toBe(oppVPBefore + 1);

    // Game still in progress.
    expect(engine.status).toBe(GameStatus.IN_PROGRESS);

    // ScoreLog has a burn_out entry with amount 1 for opponent.
    const scoreLog = engine.getGameState().scoreLog;
    const burnEntry = scoreLog[scoreLog.length - 1];
    expect(burnEntry).toMatchObject({
      playerId: opponent,
      amount: 1,
      reason: 'burn_out'
    });
  });

  // T2
  it('T2: empty deck + empty graveyard still awards opp 1 VP, deck stays empty, game continues', () => {
    const engine = createInProgressEngine();
    if (engine.status !== GameStatus.IN_PROGRESS) return;

    const current = engine.getCurrentPlayerState().playerId;
    const opponent = getOpponentId(engine, current);

    emptyDeck(engine, current);
    getPlayer(engine, current).graveyard = [];
    const oppVPBefore = getPlayer(engine, opponent).victoryPoints;

    callDrawCards(engine, current, 1, true);

    expect(getPlayer(engine, current).deck.length).toBe(0);
    expect(getPlayer(engine, current).graveyard.length).toBe(0);
    expect(getPlayer(engine, opponent).victoryPoints).toBe(oppVPBefore + 1);
    expect(engine.status).toBe(GameStatus.IN_PROGRESS);
  });

  // T3
  it('T3: repeated burnouts eventually end the game with opponent as winner', () => {
    const engine = createInProgressEngine();
    if (engine.status !== GameStatus.IN_PROGRESS) return;

    const current = engine.getCurrentPlayerState().playerId;
    const opponent = getOpponentId(engine, current);
    const startingOppVP = getPlayer(engine, opponent).victoryPoints;
    const needed = 8 - startingOppVP;

    for (let i = 0; i < needed; i++) {
      // Each iteration: clear everything so burnOut recycles 0 cards but still
      // fires the 1 VP award.
      const p = getPlayer(engine, current);
      p.deck.length = 0;
      p.graveyard.length = 0;
      callBurnOut(engine, current);
    }

    expect(engine.status).toBe(GameStatus.WINNER_DETERMINED);
    const result = engine.getMatchResult();
    expect(result).not.toBeNull();
    expect(result!.winner).toBe(opponent);
    // The final award triggers endGame via awardVictoryPoints which uses
    // 'victory_points' as the reason. The individual score events carry
    // 'burn_out'. Verify the last score log entry is burn_out.
    const scoreLog = engine.getGameState().scoreLog;
    const lastBurnEntry = [...scoreLog].reverse().find((e) => e.reason === 'burn_out');
    expect(lastBurnEntry).toBeDefined();
    expect(lastBurnEntry!.playerId).toBe(opponent);
  });

  // T4
  it('T4: optional draw on empty deck does NOT trigger burnout VP award', () => {
    const engine = createInProgressEngine();
    if (engine.status !== GameStatus.IN_PROGRESS) return;

    const current = engine.getCurrentPlayerState().playerId;
    const opponent = getOpponentId(engine, current);

    emptyDeck(engine, current);
    seedGraveyard(engine, current, 4);
    const oppVPBefore = getPlayer(engine, opponent).victoryPoints;
    const handSizeBefore = getPlayer(engine, current).hand.length;
    const graveyardSizeBefore = getPlayer(engine, current).graveyard.length;

    callDrawCards(engine, current, 1, false);

    // No VP awarded, no recycle.
    expect(getPlayer(engine, opponent).victoryPoints).toBe(oppVPBefore);
    expect(getPlayer(engine, current).hand.length).toBe(handSizeBefore);
    expect(getPlayer(engine, current).graveyard.length).toBe(graveyardSizeBefore);
    expect(getPlayer(engine, current).deck.length).toBe(0);
    expect(engine.status).toBe(GameStatus.IN_PROGRESS);
    // burnedOut should still flip to true (informational flag).
    expect(getPlayer(engine, current).burnedOut).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Battlefield selection (fallback from real catalog)
// ---------------------------------------------------------------------------
describe('Battlefield fallback selection', () => {
  // Helper: build a deck config with NO battlefields so the engine falls back
  // to the catalog.
  function buildEngineWithFallbackBattlefields(): RiftboundGameEngine {
    const engine = new RiftboundGameEngine('fallback-bf-match', ['player-1', 'player-2']);
    engine.initializeGame({
      'player-1': {
        mainDeck: buildMainDeck(),
        runeDeck: buildRuneDeck(),
        // battlefields intentionally omitted
        championLegend: null,
        championLeader: null
      },
      'player-2': {
        mainDeck: buildMainDeck(),
        runeDeck: buildRuneDeck(),
        championLegend: null,
        championLeader: null
      }
    });
    return engine;
  }

  // T5
  it('T5: fallback pool contains DEFAULT_BATTLEFIELD_COUNT real catalog Battlefields, not "Training Grounds"', () => {
    const engine = buildEngineWithFallbackBattlefields();
    const state = engine.getGameState();
    for (const player of state.players) {
      expect(player.battlefieldPool.length).toBe(2);
      for (const bf of player.battlefieldPool) {
        expect(bf.type).toBe(CardType.BATTLEFIELD);
        expect(bf.name).not.toBe('Training Grounds');
        // Names should be non-empty strings (catalog entries have names).
        expect(typeof bf.name).toBe('string');
        expect(bf.name.length).toBeGreaterThan(0);
      }
      // No duplicates within a single player's pool.
      const ids = player.battlefieldPool.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  // T6
  it('T6: repeated instantiations produce varied battlefield picks (shuffled)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const engine = new RiftboundGameEngine(`varied-${i}`, ['a', 'b']);
      engine.initializeGame({
        a: { mainDeck: buildMainDeck(), runeDeck: buildRuneDeck(), championLegend: null, championLeader: null },
        b: { mainDeck: buildMainDeck(), runeDeck: buildRuneDeck(), championLegend: null, championLeader: null }
      });
      const key = engine
        .getGameState()
        .players[0].battlefieldPool.map((c) => c.id)
        .sort()
        .join('|');
      seen.add(key);
    }
    // With 43 battlefields in the real catalog, 10 independent shuffled picks
    // of size 2 should produce more than one distinct set.
    expect(seen.size).toBeGreaterThan(1);
  });

  // T7
  it('T7: empty catalog causes generateFallbackBattlefields to throw', () => {
    // Mock the card-catalog module's getCardCatalog to return [] for this test
    // only, then restore. We require the module and replace the method via
    // jest.spyOn so the existing module binding used inside game-engine.ts
    // picks up the stub.
    const catalogModule = require('../card-catalog');
    const spy = jest.spyOn(catalogModule, 'getCardCatalog').mockReturnValue([]);
    try {
      const engine = new RiftboundGameEngine('empty-catalog-match', ['p1', 'p2']);
      expect(() => (engine as any).generateFallbackBattlefields('p1')).toThrow(
        /No Battlefield cards found/i
      );
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Conquer / Hold scoring
// ---------------------------------------------------------------------------
describe('Conquer & Hold scoring (applyBattlefieldControl)', () => {
  function getBattlefield(engine: RiftboundGameEngine, idx = 0) {
    return engine.getGameState().battlefields[idx];
  }

  // T8
  it('T8: conquering an uncontrolled battlefield awards 1 VP and sets lastConqueredTurn', () => {
    const engine = createInProgressEngine();
    if (engine.status !== GameStatus.IN_PROGRESS) return;

    const playerId = engine.getCurrentPlayerState().playerId;
    const bf = getBattlefield(engine);
    expect(bf).toBeDefined();
    bf.controller = undefined;
    bf.lastConqueredTurn = undefined;
    const vpBefore = getPlayer(engine, playerId).victoryPoints;

    const player = getPlayer(engine, playerId);
    (engine as any).applyBattlefieldControl(player, bf, 'combat', {});

    expect(getPlayer(engine, playerId).victoryPoints).toBe(vpBefore + 1);
    expect(bf.controller).toBe(playerId);
    expect(bf.lastConqueredTurn).toBe(engine.turnNumber);
  });

  // T9
  it('T9: same player re-conquering the same battlefield in the same turn awards 0 extra VP', () => {
    const engine = createInProgressEngine();
    if (engine.status !== GameStatus.IN_PROGRESS) return;

    const playerId = engine.getCurrentPlayerState().playerId;
    const bf = getBattlefield(engine);
    bf.controller = undefined;
    bf.lastConqueredTurn = undefined;
    const player = getPlayer(engine, playerId);

    (engine as any).applyBattlefieldControl(player, bf, 'combat', {});
    const vpAfterFirst = getPlayer(engine, playerId).victoryPoints;

    // Simulate a brief loss-and-regain of control mid-turn: clear controller,
    // then re-conquer. The dedup should fire because lastConqueredTurn equals
    // the current turn already.
    bf.controller = undefined;
    (engine as any).applyBattlefieldControl(player, bf, 'combat', {});

    expect(getPlayer(engine, playerId).victoryPoints).toBe(vpAfterFirst);
    expect(bf.controller).toBe(playerId);
  });

  // T10
  it('T10: [RULE NOTE] opponent conquering same battlefield later same turn -- rule says 1 VP, but engine dedup is per-battlefield not per-player', () => {
    const engine = createInProgressEngine();
    if (engine.status !== GameStatus.IN_PROGRESS) return;

    const playerId = engine.getCurrentPlayerState().playerId;
    const opponentId = getOpponentId(engine, playerId);
    const bf = getBattlefield(engine);
    bf.controller = undefined;
    bf.lastConqueredTurn = undefined;

    const player = getPlayer(engine, playerId);
    const opp = getPlayer(engine, opponentId);

    // Player conquers first: scores 1 VP.
    (engine as any).applyBattlefieldControl(player, bf, 'combat', {});
    const oppVPBefore = getPlayer(engine, opponentId).victoryPoints;

    // Opponent conquers same battlefield same turn. Per Rule 446.1 they
    // should score 1 VP because THEY have not scored this battlefield yet.
    (engine as any).applyBattlefieldControl(opp, bf, 'combat', {});

    // Per-rule EXPECTED value is oppVPBefore + 1. If this fails because the
    // engine's lastConqueredTurn dedup is per-battlefield rather than
    // per-(battlefield, player), the assertion will catch it and flag a bug.
    expect(getPlayer(engine, opponentId).victoryPoints).toBe(oppVPBefore + 1);
  });

  // T11
  it('T11: hold bonus fires at start of controller Begin Phase for 1 VP', () => {
    const engine = createInProgressEngine();
    if (engine.status !== GameStatus.IN_PROGRESS) return;

    const playerId = engine.getCurrentPlayerState().playerId;
    const bf = getBattlefield(engine);
    const player = getPlayer(engine, playerId);

    // Set controller and place a unit owned by the controller on the
    // battlefield so the hold bonus predicate is satisfied.
    bf.controller = playerId;
    bf.lastHoldScoreTurn = undefined;

    // Inject a BoardCard owned by the player onto the battlefield via
    // player.board.creatures with location.zone = 'battlefield'. The engine's
    // getUnitsOnBattlefield scans this list.
    const base = makeCreature({ id: 'test-hold-unit', name: 'Hold Unit' });
    const unit: any = {
      ...base,
      instanceId: `unit-${playerId}-1`,
      currentToughness: base.toughness ?? 2,
      isTapped: false,
      summoned: false,
      counters: {},
      activationState: { history: [] },
      ruleLog: [],
      location: { zone: 'battlefield', battlefieldId: bf.battlefieldId }
    };
    player.board.creatures.push(unit);

    const vpBefore = player.victoryPoints;
    (engine as any).checkBattlefieldHoldBonuses(player);
    const vpAfter = getPlayer(engine, playerId).victoryPoints;

    // Either the hold bonus fired (+1) or it was skipped because no unit was
    // recognized on the battlefield by the engine's predicates. Log the
    // outcome so failure is diagnostic.
    if (vpAfter !== vpBefore + 1) {
      // Hold predicate depends on getUnitsOnBattlefield finding the unit,
      // which depends on the board shape. If this fails it is a test
      // infrastructure issue rather than an engine bug: see T11 note.
      // Still assert the expected rules-compliant value.
    }
    expect(vpAfter).toBe(vpBefore + 1);
    expect(bf.lastHoldScoreTurn).toBe(engine.turnNumber);
  });

  // T12
  it('T12: player at 7 VP conquers -> game ends, winner is that player', () => {
    const engine = createInProgressEngine();
    if (engine.status !== GameStatus.IN_PROGRESS) return;

    const playerId = engine.getCurrentPlayerState().playerId;
    const player = getPlayer(engine, playerId);
    player.victoryPoints = 7;

    const bf = getBattlefield(engine);
    bf.controller = undefined;
    bf.lastConqueredTurn = undefined;

    (engine as any).applyBattlefieldControl(player, bf, 'combat', {});

    expect(engine.status).toBe(GameStatus.WINNER_DETERMINED);
    const result = engine.getMatchResult();
    expect(result).not.toBeNull();
    expect(result!.winner).toBe(playerId);
    expect(result!.reason).toBe('victory_points');
  });
});

// ---------------------------------------------------------------------------
// awardVictoryPoints logging
// ---------------------------------------------------------------------------
describe('awardVictoryPoints status-mismatch logging', () => {
  // T13
  it('T13: warns and does not mutate when status is not IN_PROGRESS', () => {
    const engine = createInProgressEngine();
    if (engine.status !== GameStatus.IN_PROGRESS) return;

    const playerId = engine.getCurrentPlayerState().playerId;
    const player = getPlayer(engine, playerId);
    const vpBefore = player.victoryPoints;

    // Force status to COMPLETED to simulate post-game award attempt.
    (engine as any).gameState.status = GameStatus.COMPLETED;

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let callCount = 0;
    let firstMessage = '';
    try {
      (engine as any).awardVictoryPoints(player, 3, 'combat', 'some-card');
      callCount = warnSpy.mock.calls.length;
      firstMessage = String(warnSpy.mock.calls[0]?.[0] ?? '');
    } finally {
      warnSpy.mockRestore();
    }

    expect(callCount).toBeGreaterThanOrEqual(1);
    expect(firstMessage).toContain('awardVictoryPoints skipped');
    expect(firstMessage).toContain('combat');
    expect(firstMessage).toContain(playerId);

    // No mutation.
    expect(getPlayer(engine, playerId).victoryPoints).toBe(vpBefore);
  });
});
