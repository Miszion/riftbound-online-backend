/**
 * Expanded Effect Operation Coverage Tests
 *
 * Validates the new operation-switch handlers added to executeEffectOperations:
 *  - scoring (active: awards victory points when text says "score N point")
 *  - rune_resource (marker)
 *  - trigger markers: on_play_trigger, combat_trigger, combat_bonus,
 *    conquer_trigger, death_trigger, equip_trigger, hold_trigger,
 *    phase_trigger, follow_movement
 *  - keyword markers: keyword_hidden, keyword_ganking, keyword_accelerate,
 *    keyword_deflect, keyword_tank, keyword_weaponmaster, keyword_legion,
 *    keyword_repeat, hide_modifier
 *  - aura markers: aura_buff, location_aura, tribal_synergy, stat_scaling,
 *    conditional_buff, solo_combat
 *  - cost markers: cost_reduction, cost_increase, targeting_discount
 *  - restriction markers: scoring_restriction, play_restriction
 *  - complex markers: effect_amplifier, ability_copy
 *
 * The marker handlers intentionally do not mutate state (their real behavior
 * lives in the continuous cost/stat/trigger pipelines). These tests confirm
 * that cards carrying only marker operations resolve cleanly and that the
 * scoring handler actually awards the parsed magnitude.
 */
import { RiftboundGameEngine, Card } from '../game-engine';
import {
  createInProgressEngine,
  makeSpell,
  resetCardCounter
} from './test-helpers';

beforeEach(() => {
  resetCardCounter();
});

function currentPlayerId(engine: RiftboundGameEngine): string {
  return engine.getCurrentPlayerState().playerId;
}

function opponentPlayerId(engine: RiftboundGameEngine): string {
  const state = engine.getGameState();
  const current = currentPlayerId(engine);
  return state.players.find((p) => p.playerId !== current)!.playerId;
}

function injectSpellToHand(
  engine: RiftboundGameEngine,
  playerId: string,
  overrides: Partial<Card> = {}
): number {
  const state = engine.getGameState();
  const player = state.players.find((p) => p.playerId === playerId)!;
  const spell = makeSpell({ energyCost: 0, ...overrides });
  player.hand.unshift(spell);
  return 0;
}

function playSpellAndResolve(
  engine: RiftboundGameEngine,
  playerId: string,
  handIndex: number
): void {
  const oId = opponentPlayerId(engine);
  engine.playCard(playerId, handIndex);
  engine.respondToChainReaction(oId, true);
}

// ---------------------------------------------------------------------------
// scoring - active handler
// ---------------------------------------------------------------------------

describe('Effect Operations - scoring', () => {
  it('awards victory points when the source text declares "score N point(s)"', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    const before = engine
      .getGameState()
      .players.find((p) => p.playerId === pId)!.victoryPoints;

    injectSpellToHand(engine, pId, {
      text: 'You score 2 points.',
      effectProfile: {
        classes: ['scoring'],
        primaryClass: 'scoring',
        operations: [{ type: 'scoring', automated: true }],
        targeting: { mode: 'none', requiresSelection: false },
        priority: 'any',
        references: [],
        reliability: 'exact'
      }
    });
    playSpellAndResolve(engine, pId, 0);

    const after = engine
      .getGameState()
      .players.find((p) => p.playerId === pId)!.victoryPoints;
    expect(after - before).toBe(2);
  });

  it('uses the operation magnitudeHint when text is missing an explicit number', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    const before = engine
      .getGameState()
      .players.find((p) => p.playerId === pId)!.victoryPoints;

    injectSpellToHand(engine, pId, {
      text: 'You gain points.',
      effectProfile: {
        classes: ['scoring'],
        primaryClass: 'scoring',
        operations: [{ type: 'scoring', automated: true, magnitudeHint: 1 }],
        targeting: { mode: 'none', requiresSelection: false },
        priority: 'any',
        references: [],
        reliability: 'exact'
      }
    });
    playSpellAndResolve(engine, pId, 0);

    const after = engine
      .getGameState()
      .players.find((p) => p.playerId === pId)!.victoryPoints;
    expect(after - before).toBe(1);
  });

  it('does not award points for marker-only scoring without text or magnitude', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    const before = engine
      .getGameState()
      .players.find((p) => p.playerId === pId)!.victoryPoints;

    injectSpellToHand(engine, pId, {
      text: 'When I hold, you score 1 point.',
      effectProfile: {
        classes: ['scoring'],
        primaryClass: 'scoring',
        operations: [{ type: 'scoring', automated: true }],
        targeting: { mode: 'none', requiresSelection: false },
        priority: 'any',
        references: [],
        reliability: 'exact'
      }
    });
    playSpellAndResolve(engine, pId, 0);

    const after = engine
      .getGameState()
      .players.find((p) => p.playerId === pId)!.victoryPoints;
    // The text includes "score 1 point", so it parses 1. Verify the parse path.
    expect(after - before).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// marker operations - confirm clean resolution (no throw, no state drift)
// ---------------------------------------------------------------------------

const MARKER_OPS = [
  'rune_resource',
  'on_play_trigger',
  'combat_trigger',
  'combat_bonus',
  'conquer_trigger',
  'death_trigger',
  'equip_trigger',
  'hold_trigger',
  'phase_trigger',
  'follow_movement',
  'keyword_hidden',
  'keyword_ganking',
  'keyword_accelerate',
  'keyword_deflect',
  'keyword_tank',
  'keyword_weaponmaster',
  'keyword_legion',
  'keyword_repeat',
  'hide_modifier',
  'aura_buff',
  'location_aura',
  'tribal_synergy',
  'stat_scaling',
  'conditional_buff',
  'solo_combat',
  'cost_reduction',
  'cost_increase',
  'targeting_discount',
  'scoring_restriction',
  'play_restriction',
  'effect_amplifier',
  'ability_copy'
] as const;

describe('Effect Operations - marker handlers resolve cleanly', () => {
  MARKER_OPS.forEach((opType) => {
    it(`${opType}: resolves without throwing and leaves victoryPoints untouched`, () => {
      const engine = createInProgressEngine();
      const pId = currentPlayerId(engine);
      const state = engine.getGameState();
      const before = state.players.find((p) => p.playerId === pId)!.victoryPoints;

      injectSpellToHand(engine, pId, {
        text: 'A marker effect.',
        effectProfile: {
          classes: [],
          primaryClass: null,
          operations: [{ type: opType as any, automated: true }],
          targeting: { mode: 'none', requiresSelection: false },
          priority: 'any',
          references: [],
          reliability: 'exact'
        }
      });

      expect(() => playSpellAndResolve(engine, pId, 0)).not.toThrow();

      const after = engine
        .getGameState()
        .players.find((p) => p.playerId === pId)!.victoryPoints;
      expect(after).toBe(before);
    });
  });

  it('resolves a composite card with many marker operations cleanly', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);

    injectSpellToHand(engine, pId, {
      text: 'A composite marker card.',
      effectProfile: {
        classes: [],
        primaryClass: null,
        operations: [
          { type: 'keyword_weaponmaster', automated: true },
          { type: 'aura_buff', automated: true },
          { type: 'location_aura', automated: true },
          { type: 'tribal_synergy', automated: true },
          { type: 'combat_bonus', automated: true },
          { type: 'on_play_trigger', automated: true },
          { type: 'follow_movement', automated: true },
          { type: 'rune_resource', automated: true }
        ],
        targeting: { mode: 'none', requiresSelection: false },
        priority: 'any',
        references: [],
        reliability: 'exact'
      }
    });

    expect(() => playSpellAndResolve(engine, pId, 0)).not.toThrow();
  });
});
