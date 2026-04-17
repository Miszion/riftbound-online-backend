/**
 * Regression tests for the six-bug cleanup pass on wip/replay-engine-2026-04-17.
 *
 * Each describe() block targets one bug from the fix batch. Tests are kept
 * minimal, asserting the smallest observable rule behavior and avoiding
 * coupling to implementation details that the fix may reorganize.
 */
import {
  RiftboundGameEngine,
  GameStatus,
  CardType,
  Domain,
  Card,
  BattlefieldState,
  BoardCard,
  CombatContext,
  PriorityWindow,
  PlayerDeckConfig
} from '../game-engine';
import {
  createInProgressEngine,
  buildMainDeck,
  buildRuneDeck,
  makeCreature,
  makeSpell,
  resetCardCounter,
  advancePastCoinFlip,
  advancePastBattlefieldSelection,
  advancePastMulligan
} from './test-helpers';

beforeEach(() => {
  resetCardCounter();
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function currentPlayerId(engine: RiftboundGameEngine): string {
  return engine.getCurrentPlayerState().playerId;
}

function opponentPlayerId(engine: RiftboundGameEngine): string {
  const state = engine.getGameState();
  const current = currentPlayerId(engine);
  return state.players.find((p) => p.playerId !== current)!.playerId;
}

function firstBattlefieldId(engine: RiftboundGameEngine): string {
  return engine.getGameState().battlefields[0]?.battlefieldId ?? '';
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
  handIndex: number,
  targets?: string[]
): void {
  const oId = opponentPlayerId(engine);
  engine.playCard(playerId, handIndex, targets);
  engine.respondToChainReaction(oId, true);
}

// ===========================================================================
// Bug 1: discard_cards defaults to the caster when no opponent target is named
// ===========================================================================

describe('Bug 1: discard_cards self-discard', () => {
  it('discards exactly one card from the caster hand when text has no opponent target', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    const oId = opponentPlayerId(engine);
    const state = engine.getGameState();
    const caster = state.players.find((p) => p.playerId === pId)!;
    const opponent = state.players.find((p) => p.playerId === oId)!;

    // Pad the caster hand so the spell and the discard consume two distinct
    // cards we can distinguish from the play cost.
    const padA = makeCreature({ name: 'Pad Card A' });
    const padB = makeCreature({ name: 'Pad Card B' });
    caster.hand.push(padA, padB);

    const casterBefore = caster.hand.length;
    const opponentBefore = opponent.hand.length;

    // Bare "discard a card" with no opponent qualifier -> caster discards.
    injectSpellToHand(engine, pId, {
      text: 'Discard a card.',
      effectProfile: {
        classes: ['discard'],
        operations: [
          { type: 'discard_cards', automated: true, magnitudeHint: 1, targetHint: 'enemy' }
        ]
      } as any
    });

    playSpellAndResolve(engine, pId, 0);

    // Spell was injected AFTER `casterBefore` was captured, so playing the
    // spell returns the hand to `casterBefore`. A true self-discard then
    // removes exactly one more card from the caster.
    expect(caster.hand.length).toBe(casterBefore - 1);
    // Opponent hand must be untouched.
    expect(opponent.hand.length).toBe(opponentBefore);
  });
});

// ===========================================================================
// Bug 2: MIN_DECK_SIZE matches the rule book (40 cards, not 39)
// ===========================================================================

describe('Bug 2: MIN_DECK_SIZE = 40 per rulebook', () => {
  it('rejects a 39-card main deck (previously accepted)', () => {
    const engine = new RiftboundGameEngine('m-min-39', ['p1', 'p2']);
    const undersized = buildMainDeck(39);
    expect(() => {
      engine.initializeGame({
        p1: { mainDeck: undersized, runeDeck: buildRuneDeck() },
        p2: { mainDeck: buildMainDeck(40), runeDeck: buildRuneDeck() }
      });
    }).toThrow(/at least 40/);
  });

  it('accepts a 40-card main deck', () => {
    const engine = new RiftboundGameEngine('m-min-40', ['p1', 'p2']);
    expect(() => {
      engine.initializeGame({
        p1: { mainDeck: buildMainDeck(40), runeDeck: buildRuneDeck() },
        p2: { mainDeck: buildMainDeck(40), runeDeck: buildRuneDeck() }
      });
    }).not.toThrow();
  });
});
