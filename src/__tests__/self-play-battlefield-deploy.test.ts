/**
 * Regression tests for the bot-vs-bot self-play harness, targeting the
 * "games always end in burn_out" bug where neither bot ever acquired
 * battlefield presence.
 *
 * The root cause was twofold:
 *   1. `enumerateLegalActions` only emitted battlefield-destination play_card
 *      actions for battlefields the player already CONTROLLED. At game start
 *      no one controls anything, so no direct-to-battlefield deploys ever
 *      surfaced — even for cards whose rules text says "you may play me to
 *      an open battlefield".
 *   2. `heuristicBot` tiered `play_card` above `move_unit`, so a bot with a
 *      unit idling in base would keep playing MORE creatures into base
 *      instead of moving the existing one onto a battlefield.
 *
 * These tests pin the fix. The integration test at the bottom is the
 * highest-signal check: it runs a full bot-vs-bot game and asserts the
 * battlefield was actually captured (so the game ended via victory_points,
 * not via deck-out / burn_out).
 */
import {
  RiftboundGameEngine,
  GameStatus,
  GamePhase,
  CardType,
  Domain,
  Card
} from '../game-engine';
import {
  createInProgressEngine,
  buildDeckConfig,
  buildMainDeck,
  buildRuneDeck,
  makeCreature,
  resetCardCounter
} from './test-helpers';
import {
  enumerateLegalActions,
  heuristicBot,
  playOneGame,
  pickPlayableCards,
  pickBattlefieldRecords,
  forkRng,
  makeRng,
  HarnessConfig
} from '../self-play';

beforeEach(() => {
  resetCardCounter();
});

function currentPlayerId(engine: RiftboundGameEngine): string {
  return engine.getCurrentPlayerState().playerId;
}

/**
 * Force a specific card into the active player's hand at index 0 so we can
 * reason about enumerated actions deterministically. Mutates engine state
 * in-place — test-only.
 */
function injectCardAtHandIndexZero(
  engine: RiftboundGameEngine,
  playerId: string,
  card: Card
): void {
  const state = engine.getGameState();
  const player = state.players.find((p) => p.playerId === playerId);
  if (!player) throw new Error(`no player ${playerId}`);
  // Zero-cost so canPayCost auto-passes — we're testing action enumeration
  // and targeting, NOT rune allocation.
  const stamped: Card = { ...card, energyCost: 0, powerCost: undefined, manaCost: 0 };
  player.hand.unshift(stamped);
}

// ===========================================================================
// Enumerator: open-battlefield plays
// ===========================================================================
describe('enumerateLegalActions — open/enemy-occupied battlefield deploys', () => {
  it('emits play_card actions for each open battlefield when the card grants canPlayToOpenBattlefield', () => {
    const engine = createInProgressEngine();
    const pid = currentPlayerId(engine);

    const state = engine.getGameState();
    // createInProgressEngine gives us 2 uncontested battlefields (one picked
    // by each player in advancePastBattlefieldSelection). Sanity check.
    const openBattlefields = state.battlefields.filter((b) => b.controller == null);
    expect(openBattlefields.length).toBeGreaterThanOrEqual(2);

    const openBfCard = makeCreature({
      name: 'Open Battlefield Deployer',
      text: 'You may play me to an open battlefield.',
      energyCost: 1
    });
    injectCardAtHandIndexZero(engine, pid, openBfCard);

    const actions = enumerateLegalActions(engine, pid);
    const openDeploys = actions.filter(
      (a) =>
        a.kind === 'play_card' &&
        a.cardIndex === 0 &&
        a.destinationId != null &&
        a.destinationId !== 'base' &&
        openBattlefields.some((bf) => bf.battlefieldId === a.destinationId)
    );

    // One play_card per open battlefield.
    expect(openDeploys.length).toBe(openBattlefields.length);
    for (const bf of openBattlefields) {
      expect(
        openDeploys.some(
          (a) => a.kind === 'play_card' && a.destinationId === bf.battlefieldId
        )
      ).toBe(true);
    }
  });

  it('emits play_card actions for open battlefields when an ally on board grants it to allies', () => {
    const engine = createInProgressEngine();
    const pid = currentPlayerId(engine);
    const state = engine.getGameState();
    const me = state.players.find((p) => p.playerId === pid)!;

    // Put a creature in my board (base) whose card text GRANTS open-battlefield
    // play to all my friendly units.
    const grantor = makeCreature({
      name: 'Grantor',
      text: 'Friendly units may be played to open battlefields.',
      energyCost: 1
    });
    me.board.creatures.push({
      ...grantor,
      instanceId: 'grantor-instance',
      location: { zone: 'base' },
      isTapped: false,
      summoned: false
    } as any);

    const openBattlefields = state.battlefields.filter((b) => b.controller == null);
    expect(openBattlefields.length).toBeGreaterThan(0);

    // A completely plain creature (no deployment-permission text) should now
    // be playable to open battlefields thanks to the ally grant.
    const plain = makeCreature({
      name: 'Plain Creature',
      text: 'A plain creature.',
      energyCost: 1
    });
    injectCardAtHandIndexZero(engine, pid, plain);

    const actions = enumerateLegalActions(engine, pid);
    const openDeploys = actions.filter(
      (a) =>
        a.kind === 'play_card' &&
        a.cardIndex === 0 &&
        a.destinationId != null &&
        a.destinationId !== 'base' &&
        openBattlefields.some((bf) => bf.battlefieldId === a.destinationId)
    );
    expect(openDeploys.length).toBe(openBattlefields.length);
  });
});

// ===========================================================================
// heuristicBot: move_unit preferred over play_card to base
// ===========================================================================
describe('heuristicBot — prefers move_unit over play_card to base', () => {
  it('moves a base creature to an open battlefield instead of dumping more creatures into base', () => {
    const engine = createInProgressEngine();
    const pid = currentPlayerId(engine);
    const state = engine.getGameState();
    const me = state.players.find((p) => p.playerId === pid)!;

    // Seed a creature sitting in base that can legally move — not summoned
    // (summoning sickness blocks moves), not tapped.
    me.board.creatures.push({
      ...makeCreature({ name: 'Idle Unit', energyCost: 1 }),
      instanceId: 'idle-unit-1',
      location: { zone: 'base' },
      isTapped: false,
      summoned: false
    } as any);

    // Put a zero-cost creature at the front of the hand so play_card-to-base
    // IS a legal alternative. The point of this test: the bot must pick
    // move_unit even though play_card-to-base is also legal.
    const freeCreature = makeCreature({
      name: 'Zero-Cost Grunt',
      energyCost: 0,
      powerCost: undefined,
      manaCost: 0
    });
    me.hand.unshift({ ...freeCreature });

    const rng = makeRng(12345);
    const action = heuristicBot(engine, pid, rng);
    expect(action).not.toBeNull();
    // Key assertion: the bot picks move_unit, not play_card-to-base.
    expect(action!.kind).toBe('move_unit');
    if (action!.kind === 'move_unit') {
      expect(action.destinationId).not.toBe('base');
      // Destination should be an existing battlefield.
      const bf = state.battlefields.find(
        (b) => b.battlefieldId === action.destinationId
      );
      expect(bf).toBeDefined();
    }
  });
});

// ===========================================================================
// Integration: full bot-vs-bot game should end via victory_points, not burn_out
// ===========================================================================
describe('bot-vs-bot integration — heuristic games end via victory_points', () => {
  // Higher jest timeout; full games can take a few seconds with the catalog.
  jest.setTimeout(120_000);

  /** Build a HarnessConfig that DOES NOT emit JSONL to disk. */
  function buildConfig(seed: number): HarnessConfig {
    return {
      games: 1,
      seed,
      seedProvided: true,
      turnLimit: 100,
      actionLimit: 4000,
      strategyA: 'heuristic',
      strategyB: 'heuristic',
      quiet: true,
      quick: true,
      emitJsonl: false,
      jsonlDir: '/tmp/riftbound-test-selfplay',
      report: '/tmp/riftbound-test-selfplay-report.json'
    };
  }

  it('runs 10 seeds and records more VP wins than burn_out finishes', () => {
    // Use the synthetic-deck fallback path (cfg.quick=true) so the test
    // doesn't depend on the JSON card catalog being present.
    const seeds = [42, 101, 202, 303, 404, 505, 606, 707, 808, 909];
    const terminators: string[] = [];
    const battlefieldCapturedCount: number[] = [];

    for (let i = 0; i < seeds.length; i++) {
      const cfg = buildConfig(seeds[i]);
      const result = playOneGame(
        i,
        cfg,
        seeds[i],
        null, // quick=true → synthetic decks
        null,
        () => { /* silent log */ }
      );
      terminators.push(result.record.terminator);

      // Inspect captured battlefields by replaying the emitted events.
      // The harness doesn't surface a structured "bfCaptured" metric directly,
      // so we use the terminator as proxy:
      //   - `victory_points`  → battlefields were captured + held
      //   - anything ending in `_vp_tiebreak` → at least one VP event registered
      // For the "battlefield was captured" claim we accept both.
      if (
        result.record.terminator === 'victory_points' ||
        result.record.terminator.endsWith('_vp_tiebreak')
      ) {
        battlefieldCapturedCount.push(1);
      } else {
        battlefieldCapturedCount.push(0);
      }
    }

    const vpWins = terminators.filter((t) => t === 'victory_points').length;
    const burnOuts = terminators.filter((t) => t === 'burn_out').length;
    const captured = battlefieldCapturedCount.reduce((a, b) => a + b, 0);

    // Pre-fix baseline was 0 VP wins / 10 burn_outs. After the fix at least
    // one battlefield must be captured across 10 seeds, and the distribution
    // should have strictly more VP wins than burn_out finishes.
    expect(captured).toBeGreaterThan(0);
    expect(vpWins).toBeGreaterThanOrEqual(1);
    expect(vpWins).toBeGreaterThan(burnOuts);
  });
});
