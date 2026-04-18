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
  buildDeckConfig,
  makeCreature,
  makeSpell,
  makeBattlefield,
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

// ===========================================================================
// Bug 3: Domain identity enforcement (Rule 133 / 110)
// ===========================================================================

describe('Bug 3: Domain identity enforcement at deck load', () => {
  it('rejects a deck whose main-deck cards do not share a domain with the Champion Legend', () => {
    const engine = new RiftboundGameEngine('m-domain-bad', ['p1', 'p2']);
    // Legend is Fury-only; deck is entirely Mind-only creatures.
    const furyLegend = makeCreature({
      id: 'legend-fury',
      name: 'Fury Legend',
      type: CardType.CREATURE,
      domain: Domain.FURY,
      colors: ['Fury']
    });
    const mindDeck = Array.from({ length: 40 }, (_, i) =>
      makeCreature({
        id: `mind-${i}`,
        name: `Mind Creature ${i}`,
        domain: Domain.MIND,
        colors: ['Mind']
      })
    );

    expect(() => {
      engine.initializeGame({
        p1: {
          mainDeck: mindDeck,
          runeDeck: buildRuneDeck(),
          championLegend: furyLegend
        } as PlayerDeckConfig,
        p2: { mainDeck: buildMainDeck(40), runeDeck: buildRuneDeck() }
      });
    }).toThrow(/ILLEGAL_DECK_DOMAIN/);
  });

  it('accepts a deck whose main-deck cards all share at least one domain with the legend', () => {
    const engine = new RiftboundGameEngine('m-domain-good', ['p1', 'p2']);
    const furyLegend = makeCreature({
      id: 'legend-fury',
      name: 'Fury Legend',
      type: CardType.CREATURE,
      domain: Domain.FURY,
      colors: ['Fury']
    });
    // 40 Fury-domain creatures -> legal under Rule 133.
    const furyDeck = Array.from({ length: 40 }, (_, i) =>
      makeCreature({
        id: `fury-${i}`,
        name: `Fury Creature ${i}`,
        domain: Domain.FURY,
        colors: ['Fury']
      })
    );

    expect(() => {
      engine.initializeGame({
        p1: {
          mainDeck: furyDeck,
          runeDeck: buildRuneDeck(),
          championLegend: furyLegend
        } as PlayerDeckConfig,
        p2: { mainDeck: buildMainDeck(40), runeDeck: buildRuneDeck() }
      });
    }).not.toThrow();
  });

  it('treats domainless (rainbow) cards as legal in any deck', () => {
    const engine = new RiftboundGameEngine('m-domain-rainbow', ['p1', 'p2']);
    const orderLegend = makeCreature({
      id: 'legend-order',
      name: 'Order Legend',
      type: CardType.CREATURE,
      domain: Domain.ORDER,
      colors: ['Order']
    });
    // Mix of Order and domainless cards.
    const mixedDeck = Array.from({ length: 40 }, (_, i) => {
      if (i < 35) {
        return makeCreature({
          id: `order-${i}`,
          name: `Order Creature ${i}`,
          domain: Domain.ORDER,
          colors: ['Order']
        });
      }
      return makeCreature({
        id: `rainbow-${i}`,
        name: `Rainbow Creature ${i}`,
        domain: undefined,
        colors: []
      });
    });

    expect(() => {
      engine.initializeGame({
        p1: {
          mainDeck: mixedDeck,
          runeDeck: buildRuneDeck(),
          championLegend: orderLegend
        } as PlayerDeckConfig,
        p2: { mainDeck: buildMainDeck(40), runeDeck: buildRuneDeck() }
      });
    }).not.toThrow();
  });
});

// ===========================================================================
// Bug 4: Battlefield uniqueness at draft (Rule 103.4)
// ===========================================================================

describe('Bug 4: Battlefield uniqueness at draft', () => {
  /**
   * Build a two-player engine where the second player's pool contains the
   * same battlefield card as the first player's pool. The helper drives the
   * engine past coin flip so we land squarely in BATTLEFIELD_SELECTION.
   */
  function setupDuplicatePoolEngine(sharedId: string) {
    const sharedFirst = makeBattlefield({ id: sharedId, slug: sharedId, name: 'Shared Arena' });
    const sharedSecond = makeBattlefield({ id: sharedId, slug: sharedId, name: 'Shared Arena' });
    const p1Alt = makeBattlefield({ id: 'p1-alt', slug: 'p1-alt', name: 'P1 Alternate' });
    const p2Alt = makeBattlefield({ id: 'p2-alt', slug: 'p2-alt', name: 'P2 Alternate' });

    const engine = new RiftboundGameEngine('bug4-match', ['player-1', 'player-2']);
    engine.initializeGame({
      'player-1': buildDeckConfig({ battlefields: [sharedFirst, p1Alt] }),
      'player-2': buildDeckConfig({ battlefields: [sharedSecond, p2Alt] })
    });
    advancePastCoinFlip(engine, 'player-1', 'player-2');
    return { engine, sharedId };
  }

  it('rejects the second player picking the same battlefield as the first', () => {
    const { engine, sharedId } = setupDuplicatePoolEngine('shared-bf');

    // Player 1 picks first.
    engine.selectBattlefield('player-1', sharedId);
    // Player 2 attempts the same battlefield -> must be rejected.
    engine.selectBattlefield('player-2', sharedId);

    // Engine must NOT have both players seated on the same battlefield. The
    // duplicate selection is cleared so player-2 can re-pick from a filtered
    // option set.
    const state = engine.getGameState();
    const p2 = state.players.find((p) => p.playerId === 'player-2')!;
    expect(p2.selectedBattlefield).toBeUndefined();

    // Engine must still be in BATTLEFIELD_SELECTION, not advanced to MULLIGAN.
    expect(engine.status).toBe(GameStatus.BATTLEFIELD_SELECTION);

    // A fresh, unresolved battlefield prompt must exist for player-2 with the
    // shared battlefield filtered out of the options.
    const reprompt = state.prompts.find(
      (p) => p.type === 'battlefield' && p.playerId === 'player-2' && !p.resolved
    );
    expect(reprompt).toBeDefined();
    const optionIds = ((reprompt!.data as any).options as any[]).map(
      (o) => o.cardId ?? o.slug ?? o.id
    );
    expect(optionIds).not.toContain(sharedId);
  });

  it('advances to MULLIGAN when player-2 re-picks a non-conflicting battlefield', () => {
    const { engine, sharedId } = setupDuplicatePoolEngine('shared-bf');

    engine.selectBattlefield('player-1', sharedId);
    engine.selectBattlefield('player-2', sharedId); // rejected, re-prompted
    engine.selectBattlefield('player-2', 'p2-alt'); // legal, different card

    const ids = engine
      .getGameState()
      .battlefields.map((b) => b.card?.id ?? b.battlefieldId);
    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain(sharedId);
    expect(ids).toContain('p2-alt');
    expect(engine.status).toBe(GameStatus.MULLIGAN);
  });
});
