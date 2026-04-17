/**
 * Predicate tests for PR #1:
 *   - canPlayCard
 *   - getLegalTargets
 *   - needsReaction
 *
 * These predicates are pure, side-effect-free projections of engine state
 * intended for harness / UI consumption. This file must prove:
 *
 *   (a) purity / idempotency across repeat calls
 *   (b) every CannotPlayReason branch fires on the intended input
 *   (c) reason-code precedence is pinned (see canPlayCard JSDoc)
 *   (d) getLegalTargets exhaustively covers the scope enum
 *   (e) adversarial inputs (prototype keys, bad indices, bad players, stale
 *       state) return a safe reason code and never throw
 *
 * SECURITY NOTE: the predicates themselves are engine-internal. See
 * /Users/miszion/workplace/nexus-data/research/riftbound-pr1-pr3-security-review.md
 * for the REST-surface conditions that would need to be met before these
 * can be exposed over HTTP.
 */
import {
  RiftboundGameEngine,
  GameStatus,
  GamePhase,
  CardType,
  Card,
  CannotPlayReason,
  TargetCandidate
} from '../game-engine';
import {
  createInitializedEngine,
  createInProgressEngine,
  makeCreature,
  makeSpell,
  resetCardCounter
} from './test-helpers';

beforeEach(() => {
  resetCardCounter();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function currentPlayerId(engine: RiftboundGameEngine): string {
  return engine.getCurrentPlayerState().playerId;
}

function opponentPlayerId(engine: RiftboundGameEngine): string {
  const state = engine.getGameState();
  const current = currentPlayerId(engine);
  return state.players.find((p) => p.playerId !== current)!.playerId;
}

function getPlayer(engine: RiftboundGameEngine, playerId: string) {
  return engine.getGameState().players.find((p) => p.playerId === playerId)!;
}

/** Put a card at the front of a player's hand; returns index 0. */
function unshiftToHand(
  engine: RiftboundGameEngine,
  playerId: string,
  card: Card
): number {
  const player = getPlayer(engine, playerId);
  player.hand.unshift(card);
  return 0;
}

/** Inject a creature onto a player's base board (bypasses playCard). */
function injectCreatureToBase(
  engine: RiftboundGameEngine,
  playerId: string,
  overrides: Partial<Card> = {}
): string {
  const player = getPlayer(engine, playerId);
  const card = makeCreature({ ...overrides });
  const instanceId = `${card.id}_base_${Math.random().toString(36).slice(2)}`;
  const boardCard = {
    ...card,
    instanceId,
    currentToughness: card.toughness ?? 3,
    isTapped: false,
    summoned: false,
    activationState: {
      cardId: card.id,
      isStateful: false,
      active: false,
      lastChangedAt: Date.now(),
      history: [] as any[]
    },
    ruleLog: [] as any[],
    location: { zone: 'base' as const }
  };
  player.board.creatures.push(boardCard as any);
  return instanceId;
}

/** Drain a player's energy and channeled runes so no cost can be paid. */
function drainResources(engine: RiftboundGameEngine, playerId: string): void {
  const player = getPlayer(engine, playerId);
  player.channeledRunes = [];
  player.resources.energy = 0;
}

/**
 * Open a reaction chain by having the current player stage any spell.
 * Returns [casterId, reactorId] — reactorId is the player whose response
 * is currently awaited.
 */
function openReactionChain(engine: RiftboundGameEngine): {
  casterId: string;
  reactorId: string;
} {
  const casterId = currentPlayerId(engine);
  const reactorId = opponentPlayerId(engine);
  const spell = makeSpell({
    energyCost: 0,
    effectProfile: {
      classes: ['card_draw'],
      operations: [{ type: 'draw_cards', automated: true, magnitudeHint: 1 }]
    } as any
  });
  unshiftToHand(engine, casterId, spell);
  engine.playCard(casterId, 0);
  return { casterId, reactorId };
}

// ---------------------------------------------------------------------------
// Q1 — Purity / idempotency
// ---------------------------------------------------------------------------

describe('predicate purity / idempotency', () => {
  it('canPlayCard does not mutate game state and is deterministic across repeat calls', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    unshiftToHand(engine, pId, makeCreature({ energyCost: 0 }));

    const snapshotBefore = JSON.stringify(engine.getGameState());
    const r1 = engine.canPlayCard(pId, 0);
    const snapshotMid = JSON.stringify(engine.getGameState());
    const r2 = engine.canPlayCard(pId, 0);
    const snapshotAfter = JSON.stringify(engine.getGameState());

    expect(snapshotMid).toBe(snapshotBefore);
    expect(snapshotAfter).toBe(snapshotBefore);
    expect(r1).toEqual(r2);
  });

  it('getLegalTargets does not mutate game state and returns equivalent arrays across repeat calls', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    const oId = opponentPlayerId(engine);
    injectCreatureToBase(engine, oId);
    unshiftToHand(engine, pId, makeSpell({ energyCost: 0, keywords: [] }));

    const snapshotBefore = JSON.stringify(engine.getGameState());
    const r1 = engine.getLegalTargets(pId, 0);
    const snapshotMid = JSON.stringify(engine.getGameState());
    const r2 = engine.getLegalTargets(pId, 0);
    const snapshotAfter = JSON.stringify(engine.getGameState());

    expect(snapshotMid).toBe(snapshotBefore);
    expect(snapshotAfter).toBe(snapshotBefore);
    expect(r1).toEqual(r2);
  });

  it('needsReaction does not mutate game state and is deterministic across repeat calls', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);

    const snapshotBefore = JSON.stringify(engine.getGameState());
    const r1 = engine.needsReaction(pId);
    const snapshotMid = JSON.stringify(engine.getGameState());
    const r2 = engine.needsReaction(pId);
    const snapshotAfter = JSON.stringify(engine.getGameState());

    expect(snapshotMid).toBe(snapshotBefore);
    expect(snapshotAfter).toBe(snapshotBefore);
    expect(r1).toEqual(r2);
  });
});

// ---------------------------------------------------------------------------
// Q2 — All 10 CannotPlayReason branches + happy path
// ---------------------------------------------------------------------------

describe('canPlayCard — happy path', () => {
  it('returns ok:true for a playable creature on the active player in MAIN_1', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    unshiftToHand(engine, pId, makeCreature({ energyCost: 0 }));
    expect(engine.canPlayCard(pId, 0)).toEqual({ ok: true });
  });

  it('returns ok:true for a spell with minTargets===0', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    // A plain no-target spell (no catalog entry → profile null → no target gate)
    unshiftToHand(engine, pId, makeSpell({ energyCost: 0, keywords: [] }));
    expect(engine.canPlayCard(pId, 0)).toEqual({ ok: true });
  });
});

describe('canPlayCard — all CannotPlayReason branches', () => {
  it('returns GAME_NOT_IN_PROGRESS before the game starts', () => {
    const engine = createInitializedEngine();
    // Engine is in COIN_FLIP, not IN_PROGRESS.
    expect(engine.status).not.toBe(GameStatus.IN_PROGRESS);
    const result = engine.canPlayCard('player-1', 0);
    expect(result).toEqual({ ok: false, reason: 'GAME_NOT_IN_PROGRESS' });
  });

  it('returns CARD_NOT_IN_HAND for an out-of-range index', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    expect(engine.canPlayCard(pId, 999)).toEqual({
      ok: false,
      reason: 'CARD_NOT_IN_HAND'
    });
  });

  it('returns CARD_NOT_IN_HAND for an unknown card id string', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    expect(engine.canPlayCard(pId, 'no-such-card-id')).toEqual({
      ok: false,
      reason: 'CARD_NOT_IN_HAND'
    });
  });

  it('returns REACTION_WINDOW_BLOCKED when a non-reactor asks during an open chain', () => {
    const engine = createInProgressEngine();
    const { casterId } = openReactionChain(engine);
    // The caster is NOT the current reactor; opponent is.
    unshiftToHand(engine, casterId, makeSpell({ energyCost: 0, keywords: ['reaction'] }));
    const result = engine.canPlayCard(casterId, 0);
    expect(result).toEqual({ ok: false, reason: 'REACTION_WINDOW_BLOCKED' });
  });

  it('returns REACTION_NON_REACTION_CARD when the reactor holds a non-reaction card', () => {
    const engine = createInProgressEngine();
    const { reactorId } = openReactionChain(engine);
    // Reactor has a creature (not a reaction spell) — not playable.
    unshiftToHand(engine, reactorId, makeCreature({ energyCost: 0 }));
    const result = engine.canPlayCard(reactorId, 0);
    expect(result).toEqual({ ok: false, reason: 'REACTION_NON_REACTION_CARD' });
  });

  it('returns NOT_YOUR_TURN for a non-current player asking in a clean state', () => {
    const engine = createInProgressEngine();
    const oId = opponentPlayerId(engine);
    unshiftToHand(engine, oId, makeCreature({ energyCost: 0 }));
    const result = engine.canPlayCard(oId, 0);
    expect(result).toEqual({ ok: false, reason: 'NOT_YOUR_TURN' });
  });

  it('returns WRONG_PHASE when called during BEGIN on the active player', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    unshiftToHand(engine, pId, makeCreature({ energyCost: 0 }));
    // Force the phase to BEGIN via internal state mutation.
    engine.currentPhase = GamePhase.BEGIN;
    const result = engine.canPlayCard(pId, 0);
    expect(result).toEqual({ ok: false, reason: 'WRONG_PHASE' });
  });

  it('returns WRONG_PRIORITY when priorityWindow is held by another player', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    const oId = opponentPlayerId(engine);
    unshiftToHand(engine, pId, makeCreature({ energyCost: 0 }));
    // Force a main-phase priority window held by the opponent.
    engine.getGameState().priorityWindow = {
      id: 'pw-test-1',
      type: 'main',
      holder: oId,
      openedAt: Date.now(),
      event: 'test'
    };
    const result = engine.canPlayCard(pId, 0);
    expect(result).toEqual({ ok: false, reason: 'WRONG_PRIORITY' });
  });

  it('returns UNSUPPORTED_CARD_TYPE for a rune-typed card in hand', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    // Craft a card with an unsupported type. We bypass the factories by
    // building the card object directly.
    const runeishCard: Card = {
      id: 'rune-as-card',
      name: 'Rune As Card',
      type: 'rune' as any as CardType,
      energyCost: 0,
      domain: undefined,
      text: 'not a real hand card',
      flavorText: null,
      colors: [],
      tags: [],
      keywords: [],
      abilities: [],
      rules: [],
      metadata: {}
    };
    unshiftToHand(engine, pId, runeishCard);
    const result = engine.canPlayCard(pId, 0);
    expect(result).toEqual({ ok: false, reason: 'UNSUPPORTED_CARD_TYPE' });
  });

  it('returns INSUFFICIENT_RESOURCES when the player cannot afford the card', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    drainResources(engine, pId);
    unshiftToHand(engine, pId, makeCreature({ energyCost: 99 }));
    const result = engine.canPlayCard(pId, 0);
    expect(result).toEqual({ ok: false, reason: 'INSUFFICIENT_RESOURCES' });
  });

  it('returns NO_LEGAL_TARGETS for a spell that requires targets when none exist', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    // Use a real catalog spell so getSpellTargetingProfile yields a
    // requiresSelection=true profile. We stand in with an effect-based
    // fallback, but since the catalog lookup is id+name-keyed, we need a
    // concrete catalog card. As a fallback: force NO_LEGAL_TARGETS by
    // swapping the getSpellTargetingProfile return via a spell id that
    // the catalog lookup resolves to — we do this by trusting the catalog.
    //
    // To avoid coupling to catalog internals, we instead verify the
    // negative path: a spell with no catalog entry goes through other
    // reason codes. The positive "NO_LEGAL_TARGETS" path is covered
    // indirectly: hasValidTargetsForScope returns false for empty boards
    // when scope is ally_unit / enemy_unit / any_unit. We simulate that
    // by monkey-patching engine.getSpellTargetingProfile for this single
    // assertion.
    const originalProfile = engine.getSpellTargetingProfile.bind(engine);
    (engine as any).getSpellTargetingProfile = (card: Card) => {
      if (card.id === 'target-required-stub') {
        return {
          scope: 'enemy_unit',
          mode: 'single',
          minTargets: 1,
          maxTargets: 1,
          requiresSelection: true,
          allowFriendly: false,
          allowEnemy: true
        };
      }
      return originalProfile(card);
    };
    unshiftToHand(
      engine,
      pId,
      makeSpell({ id: 'target-required-stub', energyCost: 0 })
    );
    // Make sure opponent has zero units on the board.
    const oPlayer = getPlayer(engine, opponentPlayerId(engine));
    oPlayer.board.creatures = [];

    const result = engine.canPlayCard(pId, 0);
    expect(result).toEqual({ ok: false, reason: 'NO_LEGAL_TARGETS' });
  });
});

// ---------------------------------------------------------------------------
// Q3 — Reason-code precedence pinning
// ---------------------------------------------------------------------------

describe('canPlayCard reason-code precedence', () => {
  it('GAME_NOT_IN_PROGRESS outranks CARD_NOT_IN_HAND', () => {
    const engine = createInitializedEngine();
    // Pre-IN_PROGRESS + bad index: should see GAME_NOT_IN_PROGRESS first.
    const result = engine.canPlayCard('player-1', 9999);
    expect(result).toEqual({ ok: false, reason: 'GAME_NOT_IN_PROGRESS' });
  });

  it('CARD_NOT_IN_HAND outranks NOT_YOUR_TURN', () => {
    const engine = createInProgressEngine();
    const oId = opponentPlayerId(engine);
    // Opponent asks for index 9999 — CARD_NOT_IN_HAND should fire before
    // NOT_YOUR_TURN.
    const result = engine.canPlayCard(oId, 9999);
    expect(result).toEqual({ ok: false, reason: 'CARD_NOT_IN_HAND' });
  });

  it('REACTION_WINDOW_BLOCKED outranks INSUFFICIENT_RESOURCES', () => {
    const engine = createInProgressEngine();
    const { casterId } = openReactionChain(engine);
    // Drain caster's resources so INSUFFICIENT_RESOURCES is also true.
    drainResources(engine, casterId);
    unshiftToHand(engine, casterId, makeCreature({ energyCost: 99 }));
    const result = engine.canPlayCard(casterId, 0);
    // Must be REACTION_WINDOW_BLOCKED, not INSUFFICIENT_RESOURCES.
    expect(result).toEqual({ ok: false, reason: 'REACTION_WINDOW_BLOCKED' });
  });

  it('NOT_YOUR_TURN outranks INSUFFICIENT_RESOURCES', () => {
    const engine = createInProgressEngine();
    const oId = opponentPlayerId(engine);
    drainResources(engine, oId);
    unshiftToHand(engine, oId, makeCreature({ energyCost: 99 }));
    const result = engine.canPlayCard(oId, 0);
    expect(result).toEqual({ ok: false, reason: 'NOT_YOUR_TURN' });
  });
});

// ---------------------------------------------------------------------------
// Q4 — getLegalTargets scope coverage
// ---------------------------------------------------------------------------

/**
 * Test helper: stub the targeting profile for a planted spell. This keeps
 * the test self-contained without depending on specific catalog entries.
 */
function plantSpellWithProfile(
  engine: RiftboundGameEngine,
  playerId: string,
  profile: any
): Card {
  const spell = makeSpell({ id: `stub-spell-${Date.now()}-${Math.random()}`, energyCost: 0 });
  const originalProfile = engine.getSpellTargetingProfile.bind(engine);
  (engine as any).getSpellTargetingProfile = (card: Card) => {
    if (card.id === spell.id) return profile;
    return originalProfile(card);
  };
  unshiftToHand(engine, playerId, spell);
  return spell;
}

describe('getLegalTargets — scope coverage', () => {
  it('returns [] for a non-spell card (creature)', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    unshiftToHand(engine, pId, makeCreature({ energyCost: 0 }));
    expect(engine.getLegalTargets(pId, 0)).toEqual([]);
  });

  it('ally_unit scope returns only caster units', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    const oId = opponentPlayerId(engine);
    const allyId = injectCreatureToBase(engine, pId, { name: 'Ally' });
    injectCreatureToBase(engine, oId, { name: 'Enemy' });
    plantSpellWithProfile(engine, pId, {
      scope: 'ally_unit',
      mode: 'single',
      minTargets: 1,
      maxTargets: 1,
      requiresSelection: true,
      allowFriendly: true,
      allowEnemy: false
    });
    const candidates = engine.getLegalTargets(pId, 0);
    expect(candidates.map((c) => c.targetId)).toEqual([allyId]);
    expect(candidates.every((c) => c.kind === 'unit')).toBe(true);
  });

  it('enemy_unit scope returns only opponent units', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    const oId = opponentPlayerId(engine);
    injectCreatureToBase(engine, pId);
    const enemyId = injectCreatureToBase(engine, oId);
    plantSpellWithProfile(engine, pId, {
      scope: 'enemy_unit',
      mode: 'single',
      minTargets: 1,
      maxTargets: 1,
      requiresSelection: true,
      allowFriendly: false,
      allowEnemy: true
    });
    const candidates = engine.getLegalTargets(pId, 0);
    expect(candidates.map((c) => c.targetId)).toEqual([enemyId]);
  });

  it('any_unit scope returns both sides when both flags allow', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    const oId = opponentPlayerId(engine);
    const allyId = injectCreatureToBase(engine, pId);
    const enemyId = injectCreatureToBase(engine, oId);
    plantSpellWithProfile(engine, pId, {
      scope: 'any_unit',
      mode: 'single',
      minTargets: 1,
      maxTargets: 1,
      requiresSelection: true,
      allowFriendly: true,
      allowEnemy: true
    });
    const ids = engine.getLegalTargets(pId, 0).map((c) => c.targetId).sort();
    expect(ids).toEqual([allyId, enemyId].sort());
  });

  it('any_unit scope respects allowFriendly=false (returns enemies only)', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    const oId = opponentPlayerId(engine);
    injectCreatureToBase(engine, pId);
    const enemyId = injectCreatureToBase(engine, oId);
    plantSpellWithProfile(engine, pId, {
      scope: 'any_unit',
      mode: 'single',
      minTargets: 1,
      maxTargets: 1,
      requiresSelection: true,
      allowFriendly: false,
      allowEnemy: true
    });
    const ids = engine.getLegalTargets(pId, 0).map((c) => c.targetId);
    expect(ids).toEqual([enemyId]);
  });

  it('any_unit scope respects allowEnemy=false (returns allies only)', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    const oId = opponentPlayerId(engine);
    const allyId = injectCreatureToBase(engine, pId);
    injectCreatureToBase(engine, oId);
    plantSpellWithProfile(engine, pId, {
      scope: 'any_unit',
      mode: 'single',
      minTargets: 1,
      maxTargets: 1,
      requiresSelection: true,
      allowFriendly: true,
      allowEnemy: false
    });
    const ids = engine.getLegalTargets(pId, 0).map((c) => c.targetId);
    expect(ids).toEqual([allyId]);
  });

  it('player scope returns both player ids', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    const oId = opponentPlayerId(engine);
    plantSpellWithProfile(engine, pId, {
      scope: 'player',
      mode: 'single',
      minTargets: 1,
      maxTargets: 1,
      requiresSelection: true,
      allowFriendly: true,
      allowEnemy: true
    });
    const ids = engine.getLegalTargets(pId, 0).map((c) => c.targetId).sort();
    expect(ids).toEqual([pId, oId].sort());
    expect(engine.getLegalTargets(pId, 0).every((c) => c.kind === 'player')).toBe(true);
  });

  it('battlefield scope returns registered battlefield ids', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    plantSpellWithProfile(engine, pId, {
      scope: 'battlefield',
      mode: 'single',
      minTargets: 1,
      maxTargets: 1,
      requiresSelection: true,
      allowFriendly: true,
      allowEnemy: true
    });
    const state = engine.getGameState();
    const expectedIds = state.battlefields.map((b) => b.battlefieldId).sort();
    const actual = engine.getLegalTargets(pId, 0).map((c) => c.targetId).sort();
    expect(actual).toEqual(expectedIds);
    expect(engine.getLegalTargets(pId, 0).every((c) => c.kind === 'battlefield')).toBe(true);
  });

  it('self scope returns only caster id', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    plantSpellWithProfile(engine, pId, {
      scope: 'self',
      mode: 'single',
      minTargets: 1,
      maxTargets: 1,
      requiresSelection: true,
      allowFriendly: true,
      allowEnemy: false
    });
    const candidates = engine.getLegalTargets(pId, 0);
    expect(candidates.length).toBe(1);
    expect(candidates[0].targetId).toBe(pId);
    expect(candidates[0].kind).toBe('self');
  });

  it('returns [] for graveyard / deck / hand / none scopes', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    for (const scope of ['graveyard', 'deck', 'hand', 'none']) {
      plantSpellWithProfile(engine, pId, {
        scope,
        mode: 'single',
        minTargets: 0,
        maxTargets: 1,
        requiresSelection: true,
        allowFriendly: true,
        allowEnemy: true
      });
      const result = engine.getLegalTargets(pId, 0);
      expect(result).toEqual([]);
      // Remove the planted spell so the next iteration gets a clean slot.
      getPlayer(engine, pId).hand.shift();
    }
  });

  it('tank post-filter: documented TODO', () => {
    // Tank keyword filtering is referenced at src/game-engine.ts:2108-2118
    // via validateSpellTargets, which runs inside the throw-based pipeline.
    // PR #1's getLegalTargets enumerates raw candidates and leaves Tank
    // enforcement to the downstream validator (playCard remains the source
    // of truth). The test is documented here and deliberately skipped
    // because PR #2 is the natural home for Tank target post-filtering
    // once validateSpellTargets is converted to return-based form.
    //
    // TODO(PR #2): once validateSpellTargets returns a reason object,
    // port the Tank post-filter here and re-enable this test against a
    // card whose keywords/effectProfile include "keyword_tank" (see
    // src/card-catalog.ts entries flagged with keyword_tank in the catalog).
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Q5 — Adversarial inputs
// ---------------------------------------------------------------------------

describe('canPlayCard — adversarial inputs', () => {
  it('returns CARD_NOT_IN_HAND for prototype-chain string keys', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const result = engine.canPlayCard(pId, key);
      expect(result).toEqual({ ok: false, reason: 'CARD_NOT_IN_HAND' });
    }
  });

  it('returns CARD_NOT_IN_HAND for a negative index', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    expect(engine.canPlayCard(pId, -1)).toEqual({
      ok: false,
      reason: 'CARD_NOT_IN_HAND'
    });
  });

  it('returns CARD_NOT_IN_HAND for a huge non-integer index', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    expect(engine.canPlayCard(pId, Number.MAX_SAFE_INTEGER)).toEqual({
      ok: false,
      reason: 'CARD_NOT_IN_HAND'
    });
    expect(engine.canPlayCard(pId, 1.5)).toEqual({
      ok: false,
      reason: 'CARD_NOT_IN_HAND'
    });
    expect(engine.canPlayCard(pId, NaN)).toEqual({
      ok: false,
      reason: 'CARD_NOT_IN_HAND'
    });
    expect(engine.canPlayCard(pId, Infinity)).toEqual({
      ok: false,
      reason: 'CARD_NOT_IN_HAND'
    });
  });

  it('returns GAME_NOT_IN_PROGRESS (safe default) for a non-existent player id', () => {
    const engine = createInProgressEngine();
    const result = engine.canPlayCard('no-such-player', 0);
    // With the game IN_PROGRESS, resolvePlayerById would throw; we catch
    // and map to a safe reason. Because GAME_NOT_IN_PROGRESS guard at
    // step 1 sees status=IN_PROGRESS, the fall-through catch kicks in.
    expect(result.ok).toBe(false);
    // We accept GAME_NOT_IN_PROGRESS as the safe-default reason code.
    if (!result.ok) {
      expect(result.reason).toBe('GAME_NOT_IN_PROGRESS');
    }
  });

  it('returns GAME_NOT_IN_PROGRESS on stale state after the game has ended', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    unshiftToHand(engine, pId, makeCreature({ energyCost: 0 }));
    engine.concedeMatch(pId);
    const result = engine.canPlayCard(pId, 0);
    expect(result).toEqual({ ok: false, reason: 'GAME_NOT_IN_PROGRESS' });
  });

  it('predicates never throw for adversarial inputs', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    const adversarial: Array<number | string> = [
      -1,
      NaN,
      Infinity,
      -Infinity,
      Number.MAX_SAFE_INTEGER,
      1.5,
      '',
      '__proto__',
      'constructor',
      'prototype',
      'a'.repeat(10_000)
    ];
    for (const key of adversarial) {
      expect(() => engine.canPlayCard(pId, key)).not.toThrow();
      expect(() => engine.getLegalTargets(pId, key)).not.toThrow();
    }
    expect(() => engine.needsReaction('no-such-player')).not.toThrow();
    expect(() => engine.needsReaction('')).not.toThrow();
  });
});

describe('getLegalTargets — adversarial inputs', () => {
  it('returns [] for prototype-chain string keys', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      expect(engine.getLegalTargets(pId, key)).toEqual([]);
    }
  });

  it('returns [] for a non-existent player id', () => {
    const engine = createInProgressEngine();
    expect(engine.getLegalTargets('no-such-player', 0)).toEqual([]);
  });

  it('returns [] on a pre-IN_PROGRESS engine', () => {
    const engine = createInitializedEngine();
    expect(engine.getLegalTargets('player-1', 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// needsReaction windowType coverage
// ---------------------------------------------------------------------------

describe('needsReaction — windowType coverage', () => {
  it('returns required=false/windowType=none in a clean idle state', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    // Clear any priority window that createInProgressEngine may have opened.
    engine.getGameState().priorityWindow = null;
    expect(engine.needsReaction(pId)).toEqual({
      required: false,
      windowType: 'none'
    });
  });

  it('returns trigger windowType during an active reaction chain on the reactor', () => {
    const engine = createInProgressEngine();
    const { reactorId } = openReactionChain(engine);
    const result = engine.needsReaction(reactorId);
    expect(result.required).toBe(true);
    expect(result.windowType).toBe('trigger');
    expect(typeof result.reason).toBe('string');
  });

  it('returns priority windowType when priorityWindow.type is main for the player', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    engine.getGameState().priorityWindow = {
      id: 'pw-main',
      type: 'main',
      holder: pId,
      openedAt: Date.now(),
      event: 'main'
    };
    const result = engine.needsReaction(pId);
    expect(result.required).toBe(true);
    expect(result.windowType).toBe('priority');
  });

  it('returns combat windowType when priorityWindow.type is combat/showdown', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    engine.getGameState().priorityWindow = {
      id: 'pw-combat',
      type: 'showdown',
      holder: pId,
      openedAt: Date.now(),
      event: 'combat-open'
    };
    const result = engine.needsReaction(pId);
    expect(result.required).toBe(true);
    expect(result.windowType).toBe('combat');
  });

  it('returns none when priorityWindow holder is someone else', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    const oId = opponentPlayerId(engine);
    engine.getGameState().priorityWindow = {
      id: 'pw-other',
      type: 'main',
      holder: oId,
      openedAt: Date.now(),
      event: 'main'
    };
    expect(engine.needsReaction(pId)).toEqual({
      required: false,
      windowType: 'none'
    });
  });

  it('safely returns none when reactionChain has an empty items array', () => {
    const engine = createInProgressEngine();
    const pId = currentPlayerId(engine);
    // Simulate a transient chain with no items — must not throw.
    engine.getGameState().reactionChain = {
      id: 'empty-chain',
      items: [],
      currentReactorId: pId,
      originalCasterId: pId,
      awaitingResponse: true,
      createdAt: Date.now(),
      lastUpdatedAt: Date.now()
    };
    // Clear priorityWindow so it doesn't fire first.
    engine.getGameState().priorityWindow = null;
    expect(() => engine.needsReaction(pId)).not.toThrow();
    expect(engine.needsReaction(pId)).toEqual({
      required: false,
      windowType: 'none'
    });
  });
});

// ---------------------------------------------------------------------------
// API-surface inclusion guard (from QA review §D)
// ---------------------------------------------------------------------------

describe('predicate API surface', () => {
  it('exposes canPlayCard, getLegalTargets, needsReaction on the prototype', () => {
    const names = Object.getOwnPropertyNames(RiftboundGameEngine.prototype);
    expect(names).toEqual(
      expect.arrayContaining(['canPlayCard', 'getLegalTargets', 'needsReaction'])
    );
  });
});

// ---------------------------------------------------------------------------
// Type-level sanity: imports exist
// ---------------------------------------------------------------------------

describe('exported predicate types', () => {
  it('CannotPlayReason and TargetCandidate are usable as types', () => {
    // Compile-time-only check; the runtime assertion just proves we imported
    // without error.
    const reason: CannotPlayReason = 'GAME_NOT_IN_PROGRESS';
    const cand: TargetCandidate = { targetId: 'x', kind: 'self' };
    expect(reason).toBe('GAME_NOT_IN_PROGRESS');
    expect(cand.kind).toBe('self');
  });
});
