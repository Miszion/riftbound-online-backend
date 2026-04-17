/**
 * Battlefield Uniqueness (Fix #1) - Skeleton Tests
 *
 * Rule 103.4: the two active battlefields at start of game must be DIFFERENT.
 * Current implementation (`startBattlefieldSelectionPhase` / `assignBattlefieldSelection`
 * at src/game-engine.ts:1100-1154) applies both selections with no cross-player
 * uniqueness check. After the fix, if both players pick the same battlefield
 * card, the second player MUST be re-prompted with a filtered option set that
 * excludes the first player's pick.
 *
 * Coverage:
 *  - both pick same battlefield -> second player re-prompted, no duplicate on gameState
 *  - both pick different -> game proceeds to MULLIGAN normally
 *  - pools overlap heavily (same 3-card pool for both players) -> second pick
 *    must be filtered and at least one legal option must remain
 *  - edge: second player's pool contains ONLY the card first player chose ->
 *    engine must reject or reshuffle (document expected behavior with fix)
 *
 * TODO(backend eng): fill in assertions once the enforcement path lands.
 */
import {
  RiftboundGameEngine,
  GameStatus,
  CardType,
  Card
} from '../game-engine';
import {
  buildDeckConfig,
  buildMainDeck,
  buildRuneDeck,
  makeCreature,
  resetCardCounter,
  advancePastCoinFlip
} from './test-helpers';

beforeEach(() => {
  resetCardCounter();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a battlefield "card" (enchantment tagged as Battlefield) with a
 * stable id so both players can share the same card in their pool.
 */
function makeBattlefield(id: string, name = `Battlefield ${id}`): Card {
  return makeCreature({
    id,
    slug: id,
    name,
    type: CardType.ENCHANTMENT,
    tags: ['Battlefield'],
    text: `Test battlefield ${id}.`
  });
}

/**
 * Create a two-player engine where each player's battlefieldPool is supplied
 * explicitly. Both players share references to the same battlefield cards when
 * you want a collision; pass disjoint arrays when you want a clean draft.
 */
function createEngineWithBattlefieldPools(
  p1Pool: Card[],
  p2Pool: Card[]
): RiftboundGameEngine {
  const engine = new RiftboundGameEngine('bf-unique-match', ['player-1', 'player-2']);
  engine.initializeGame({
    'player-1': {
      mainDeck: buildMainDeck(),
      runeDeck: buildRuneDeck(),
      battlefields: p1Pool,
      championLegend: null,
      championLeader: null
    },
    'player-2': {
      mainDeck: buildMainDeck(),
      runeDeck: buildRuneDeck(),
      battlefields: p2Pool,
      championLegend: null,
      championLeader: null
    }
  });
  advancePastCoinFlip(engine, 'player-1', 'player-2');
  return engine;
}

function battlefieldPromptFor(
  engine: RiftboundGameEngine,
  playerId: string
) {
  return engine
    .getGameState()
    .prompts.find(
      (p) => p.type === 'battlefield' && p.playerId === playerId && !p.resolved
    );
}

// ---------------------------------------------------------------------------
// Both players pick the same battlefield
// ---------------------------------------------------------------------------
describe('Battlefield Uniqueness - collision re-prompt', () => {
  it('re-prompts the second player when they choose the same battlefield as the first', () => {
    // Setup: both players share a pool containing "shared-bf" plus one alternate each.
    const shared = makeBattlefield('shared-bf', 'Shared Arena');
    const p1Alt = makeBattlefield('p1-alt', 'P1 Alternate');
    const p2Alt = makeBattlefield('p2-alt', 'P2 Alternate');
    const engine = createEngineWithBattlefieldPools(
      [shared, p1Alt],
      [shared, p2Alt]
    );

    // Action: both players pick the shared battlefield.
    engine.selectBattlefield('player-1', 'shared-bf');
    engine.selectBattlefield('player-2', 'shared-bf');

    // Expected:
    //  - engine remains in BATTLEFIELD_SELECTION
    //  - player-2 has a fresh (unresolved) battlefield prompt
    //  - the new prompt's options DO NOT include "shared-bf"
    //  - gameState.battlefields is either empty or contains only player-1's pick
    //
    // TODO(backend eng):
    //   expect(engine.status).toBe(GameStatus.BATTLEFIELD_SELECTION);
    //   const reprompt = battlefieldPromptFor(engine, 'player-2');
    //   expect(reprompt).toBeDefined();
    //   const optionIds = (reprompt!.data as any).options.map((o: any) => o.cardId ?? o.id);
    //   expect(optionIds).not.toContain('shared-bf');
    //   expect(engine.getGameState().battlefields.map(b => b.card?.id)).not.toContain('shared-bf_duplicate');
  });

  it('marks the collision in the duel log / reason so the UI can surface it', () => {
    // TODO(backend eng): assert a duel log entry (or prompt metadata field) explains
    // WHY player-2 was re-prompted. Helps the client show "that battlefield was taken".
  });

  it('allows player-2 to complete selection after re-prompt with a different battlefield', () => {
    const shared = makeBattlefield('shared-bf');
    const p2Alt = makeBattlefield('p2-alt');
    const engine = createEngineWithBattlefieldPools([shared], [shared, p2Alt]);

    engine.selectBattlefield('player-1', 'shared-bf');
    // Collision -> expect re-prompt
    engine.selectBattlefield('player-2', 'shared-bf'); // should be rejected / reprompt
    engine.selectBattlefield('player-2', 'p2-alt'); // should succeed

    // TODO(backend eng):
    //   expect(engine.status).toBe(GameStatus.MULLIGAN);
    //   const bfs = engine.getGameState().battlefields.map(b => b.card?.id);
    //   expect(bfs).toEqual(expect.arrayContaining(['shared-bf', 'p2-alt']));
    //   expect(new Set(bfs).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Happy path - different picks
// ---------------------------------------------------------------------------
describe('Battlefield Uniqueness - no collision', () => {
  it('proceeds to MULLIGAN when both players pick different battlefields', () => {
    const p1Pool = [makeBattlefield('p1-a'), makeBattlefield('p1-b')];
    const p2Pool = [makeBattlefield('p2-a'), makeBattlefield('p2-b')];
    const engine = createEngineWithBattlefieldPools(p1Pool, p2Pool);

    engine.selectBattlefield('player-1', 'p1-a');
    engine.selectBattlefield('player-2', 'p2-a');

    // TODO(backend eng):
    //   expect(engine.status).toBe(GameStatus.MULLIGAN);
    //   const ids = engine.getGameState().battlefields.map(b => b.card?.id);
    //   expect(ids).toEqual(['p1-a', 'p2-a']);
  });

  it('does not re-prompt when picks differ even if pools overlap partially', () => {
    const overlap = makeBattlefield('overlap');
    const p1Unique = makeBattlefield('p1-unique');
    const p2Unique = makeBattlefield('p2-unique');
    const engine = createEngineWithBattlefieldPools(
      [overlap, p1Unique],
      [overlap, p2Unique]
    );

    engine.selectBattlefield('player-1', 'p1-unique');
    engine.selectBattlefield('player-2', 'overlap');

    // TODO(backend eng): expect no re-prompt fired, status advanced to MULLIGAN.
  });
});

// ---------------------------------------------------------------------------
// Heavy pool overlap
// ---------------------------------------------------------------------------
describe('Battlefield Uniqueness - heavy pool overlap', () => {
  it('leaves at least one legal option for player-2 after filtering the taken pick', () => {
    // Both players share an identical 3-card pool.
    const pool = [
      makeBattlefield('bf-1'),
      makeBattlefield('bf-2'),
      makeBattlefield('bf-3')
    ];
    const engine = createEngineWithBattlefieldPools([...pool], [...pool]);

    engine.selectBattlefield('player-1', 'bf-2');
    // player-2 tries the same -> must be re-prompted with bf-1 and bf-3 only.
    engine.selectBattlefield('player-2', 'bf-2');

    // TODO(backend eng):
    //   const reprompt = battlefieldPromptFor(engine, 'player-2');
    //   const optionIds = (reprompt!.data as any).options.map((o: any) => o.cardId ?? o.id);
    //   expect(optionIds).toEqual(expect.arrayContaining(['bf-1', 'bf-3']));
    //   expect(optionIds).not.toContain('bf-2');
  });

  it('edge: if player-2 pool only contains the taken battlefield, engine must fall back safely', () => {
    const shared = makeBattlefield('only-shared');
    // player-1 has options; player-2's entire pool is just the shared card.
    const engine = createEngineWithBattlefieldPools(
      [shared, makeBattlefield('p1-extra')],
      [shared]
    );

    engine.selectBattlefield('player-1', 'only-shared');

    // TODO(backend eng): decide contract with backend eng -
    //   - should the engine auto-assign a fallback battlefield for p2? OR
    //   - should p1 be forced to re-pick instead?
    //   - should an explicit error/prompt surface so the match layer can regenerate p2's pool?
    // Test should pin ONE of these behaviors once decided. Currently flagged as "needs design decision".
  });
});
