/**
 * Battlefield Scoring (Fix #3) - Skeleton Tests
 *
 * Relevant code:
 *  - `applyBattlefieldControl` at src/game-engine.ts:~8140-8196 awards 1 VP per
 *    conquest via `awardVictoryPoints(player, amount, reason, sourceCard)`.
 *  - `checkBattlefieldHoldBonuses` at src/game-engine.ts:8198-8229 awards 1 VP
 *    per turn start IF the controller exclusively controls all units on that
 *    battlefield. Called from the BEGIN phase at src/game-engine.ts:1447.
 *  - `awardVictoryPoints` at src/game-engine.ts:3716-3756 calls `endGame`
 *    when `victoryPoints >= victoryScore` (VICTORY_SCORE = 8 at line 651).
 *
 * Coverage:
 *  - Conquest awards exactly 1 VP per conquer (matches current code)
 *  - Hold bonus awards 1 VP per turn start for the controller
 *  - Reaching >= 8 VP triggers endGame() and sets WINNER_DETERMINED
 *  - FLAGGED: "hold bonus currently requires exclusive unit control" ->
 *    the engine skips the bonus when the opposing player also has a unit on
 *    the battlefield. Rules audit says this is ambiguous - test pins current
 *    behavior AND marks it as "needs rule verification".
 *
 * TODO(backend eng): fill in assertions once scoring hooks are reachable from
 * public API or test helpers are extended.
 */
import {
  RiftboundGameEngine,
  GameStatus
} from '../game-engine';
import {
  createInProgressEngine,
  resetCardCounter
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

function firstBattlefieldId(engine: RiftboundGameEngine): string {
  return engine.getGameState().battlefields[0]?.battlefieldId ?? '';
}

/**
 * Force the given player to control the given battlefield at the start of
 * their next begin phase. Used by hold-bonus tests.
 *
 * TODO(backend eng): wire this to the actual engine primitive used to set
 * controller (e.g. directly mutating battlefield.controller in test state,
 * or simulating an unblocked attack that conquers it).
 */
function giveBattlefieldControl(
  engine: RiftboundGameEngine,
  playerId: string,
  battlefieldId: string
): void {
  const bf = engine
    .getGameState()
    .battlefields.find((b) => b.battlefieldId === battlefieldId);
  if (bf) {
    (bf as any).controller = playerId;
  }
}

// ---------------------------------------------------------------------------
// Conquest awards 1 VP
// ---------------------------------------------------------------------------
describe('Battlefield Scoring - conquest', () => {
  it('awards exactly 1 VP when a player conquers an uncontested battlefield', () => {
    const engine = createInProgressEngine();
    if (engine.status !== GameStatus.IN_PROGRESS) return;

    const playerId = engine.getCurrentPlayerState().playerId;
    const vpBefore = getPlayer(engine, playerId).victoryPoints;
    const bfId = firstBattlefieldId(engine);

    // Action: move a unit onto an empty battlefield so combat resolves as unblocked.
    // TODO(backend eng): inject a creature into player's base + runes to play it,
    //   then engine.moveUnit(playerId, creatureInstanceId, bfId).

    // Expected:
    //   expect(getPlayer(engine, playerId).victoryPoints).toBe(vpBefore + 1);
    //
    //   const log = engine.getGameState().scoreLog;
    //   expect(log[log.length - 1]).toMatchObject({ playerId, amount: 1, reason: 'combat' });
  });

  it('awards 1 VP per distinct conquer even when the same player conquers two battlefields in a turn', () => {
    // TODO(backend eng): set up two empty battlefields, conquer both in one turn,
    //   assert player gained exactly 2 VP and two 'combat' score log entries fired.
  });

  it('does NOT award points if the conquering player already controlled the battlefield', () => {
    // TODO(backend eng): re-entering your own battlefield should not double-score.
    //   `applyBattlefieldControl` short-circuits via `alreadyControlled`.
  });
});

// ---------------------------------------------------------------------------
// Hold bonus
// ---------------------------------------------------------------------------
describe('Battlefield Scoring - hold bonus at turn start', () => {
  it('awards 1 VP at the start of the controller\'s turn for each exclusively-held battlefield', () => {
    const engine = createInProgressEngine();
    if (engine.status !== GameStatus.IN_PROGRESS) return;

    const playerId = engine.getCurrentPlayerState().playerId;
    const bfId = firstBattlefieldId(engine);

    // Setup: controller already holds bfId with at least one of their units on it.
    // TODO(backend eng):
    //   - place one of the controller's creatures onto bfId
    //   - set bf.controller = playerId
    //   - advance turns until playerId's BEGIN phase fires
    //   - assert victoryPoints increased by exactly 1 at that moment

    // Expected:
    //   expect(...).toBe(vpBefore + 1);
    //   expect(bf.lastHoldScoreTurn).toBe(engine.turnNumber);
  });

  it('does NOT double-award in a single begin phase', () => {
    // Rationale: `lastHoldScoreTurn` guard at src/game-engine.ts:8203-8205.
    // TODO(backend eng): call checkBattlefieldHoldBonuses twice -> only 1 VP.
  });

  it('skips the bonus when the battlefield has no units (controller has no body on it)', () => {
    // Matches current guard at src/game-engine.ts:8206-8209.
    // TODO(backend eng): controller set but units.length === 0 -> no VP.
  });

  it('[NEEDS RULE VERIFICATION] skips the hold bonus when the opposing player also has a unit on the battlefield', () => {
    // Current engine (src/game-engine.ts:8210-8216) requires EXCLUSIVE control:
    // every unit on the battlefield must belong to the hold-bonus player.
    //
    // Rules-audit question: rule book says "the player who controls" - it's
    // unclear whether a contested battlefield still counts as "held" for
    // scoring purposes during the opponent's begin-phase hold check.
    //
    // This test pins the CURRENT behavior and should be revisited with
    // product / rules owner.
    //
    // TODO(backend eng):
    //   - place controller unit on bfId
    //   - place opponent unit on the same bfId
    //   - trigger begin-phase hold check
    //   - expect no VP awarded (pins current code)
    //
    // TODO(product): confirm this matches rule 437-450 intent or file a bug.
  });

  it('awards the bonus again on a later turn if control is maintained', () => {
    // TODO(backend eng): run two begin phases for the same controller; expect 2 total VP.
  });
});

// ---------------------------------------------------------------------------
// Victory at >= 8 points
// ---------------------------------------------------------------------------
describe('Battlefield Scoring - victory at >= 8 VP', () => {
  it('triggers endGame() and sets WINNER_DETERMINED when a player reaches 8 VP via conquest', () => {
    const engine = createInProgressEngine();
    if (engine.status !== GameStatus.IN_PROGRESS) return;

    const playerId = engine.getCurrentPlayerState().playerId;
    // Setup: prime the player at 7 VP and arrange one more conquer.
    // TODO(backend eng): mutate getPlayer(engine, playerId).victoryPoints = 7,
    //   then conquer a battlefield.

    // Expected:
    //   expect(engine.status).toBe(GameStatus.WINNER_DETERMINED);
    //   const result = engine.getMatchResult()!;
    //   expect(result.winner).toBe(playerId);
    //   expect(result.reason).toBe('victory_points');
  });

  it('triggers endGame() when hold bonus pushes the score over the threshold', () => {
    // TODO(backend eng): player at 7, controls battlefield exclusively,
    //   new begin phase -> 8 VP -> game ends.
  });

  it('caps victoryPoints at victoryScore (cannot overshoot 8)', () => {
    // Matches line 3727: Math.min(player.victoryPoints + amount, player.victoryScore).
    // TODO(backend eng): prime player at 7 VP, award 5 (e.g. synthetic objective),
    //   expect final VP === 8, not 12.
  });

  it('does not award points after the game has ended', () => {
    // Matches line 3722 guard: `gameState.status !== GameStatus.IN_PROGRESS`.
    // TODO(backend eng): after WINNER_DETERMINED, further awardVictoryPoints
    //   calls are no-ops; scoreLog length unchanged.
  });
});

// ---------------------------------------------------------------------------
// Score log integrity (cross-cutting)
// ---------------------------------------------------------------------------
describe('Battlefield Scoring - score log integrity', () => {
  it('writes a score log entry with the correct reason tag for conquest vs hold', () => {
    // TODO(backend eng): after a conquest, last entry.reason === 'combat'.
    //   After a hold check, last entry.reason === 'hold'.
  });

  it('score log sum equals final victoryPoints for each player', () => {
    // TODO(backend eng): after several scoring events,
    //   sum of scoreLog entries per playerId === that player's victoryPoints.
  });
});
