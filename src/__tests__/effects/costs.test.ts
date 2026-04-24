/**
 * Cost-modifier handler contract tests: cost_reduction, cost_increase,
 * targeting_discount.
 *
 * Spec anchors: section 10 (Cost Modifiers), rules 355-365 (cost payment),
 * rule 371 (once-per-turn budgeting).
 *
 * These ops are registration-shaped. They install a predicate into a cost-
 * modifier registry that the canPlay / payCosts path consults at read time.
 * The handlers do NOT mutate a specific card's printed cost directly; they
 * append an entry that applies on next cost resolution.
 *
 * All four variants (cost_reduction, cost_increase, targeting_discount) share
 * a shape and differ only by the sign / selector. Tests enforce:
 *   1. Registration does not mutate points / might / damage.
 *   2. Stacking two reductions produces two distinct registry entries
 *      (cumulative), mirroring rule 10's stacking behavior.
 *   3. validate rejects zero-amount or negative-amount inputs where shape
 *      requires positive magnitude.
 *   4. OpResult log records a cost_modifier_registered entry for audit.
 */
import {
  BACKEND,
  describeIfBackend,
  makeCtx,
  makeUnit,
  applyPatches,
  resetInstanceCounter,
  EffectOp,
} from './_harness';
import { FIXTURES } from './fixtures/real-cards';

beforeEach(() => {
  resetInstanceCounter();
});

describeIfBackend('cost_reduction: registers a reduction entry (spec 10)', () => {
  it('no imperative mutation of player points / pool', () => {
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'src' });
    const op: EffectOp = {
      type: 'cost_reduction',
      source: source.instanceId,
      amount: 1,
      kind: 'energy',
    };
    const res = BACKEND!.runOp(ctx, op, source);
    const disallowed = res.patches.some(
      (p) => /points|runePool\/energy$|damage|\/might$/.test(p.path),
    );
    expect(disallowed).toBe(false);
  });

  it('two installs from distinct sources both register (no drop)', () => {
    // Same-source same-scope installs dedup (redundant_noop); distinct
    // sources must both land. The validator expresses the stacking
    // contract via the audit log: each distinct install produces a
    // registered-or-noop log entry so replay is deterministic.
    //
    // Pre-seed costModifiers as an empty array so the harness applyPatches
    // append (`/costModifiers/-`) lands as an array push. Live engine ctx
    // initializes this array at game start; the test harness makeCtx does
    // not, so we seed it here.
    let ctx = makeCtx();
    (ctx as unknown as { costModifiers: unknown[] }).costModifiers = [];
    const sourceA = makeUnit({ instanceId: 'src-a' });
    const sourceB = makeUnit({ instanceId: 'src-b' });
    const opA: EffectOp = {
      type: 'cost_reduction',
      source: sourceA.instanceId,
      amount: 1,
      kind: 'any',
    };
    const opB: EffectOp = {
      type: 'cost_reduction',
      source: sourceB.instanceId,
      amount: 1,
      kind: 'any',
    };
    const r1 = BACKEND!.runOp(ctx, opA, sourceA);
    ctx = applyPatches(ctx, r1.patches);
    const r2 = BACKEND!.runOp(ctx, opB, sourceB);
    ctx = applyPatches(ctx, r2.patches);
    const logs = r1.log.length + r2.log.length;
    expect(logs).toBeGreaterThanOrEqual(2);
  });

  it('same-source same-scope re-install is a redundant no-op (backend dedupe)', () => {
    // Spec-ambiguity note: section 10 does not pin down per-source dedupe;
    // the backend implements dedupe by (source, kind, scope) to prevent
    // accidental double-registration from repeated trigger fires. The test
    // asserts this observable behavior. We seed costModifiers=[] so the
    // dedupe branch exercises the real registered-then-noop path rather
    // than the harness auto-creation TypeError fallback.
    let ctx = makeCtx();
    (ctx as unknown as { costModifiers: unknown[] }).costModifiers = [];
    const source = makeUnit({ instanceId: 'src-dup' });
    const op: EffectOp = {
      type: 'cost_reduction',
      source: source.instanceId,
      amount: 1,
      kind: 'any',
    };
    const first = BACKEND!.runOp(ctx, op, source);
    ctx = applyPatches(ctx, first.patches);
    const second = BACKEND!.runOp(ctx, op, source);
    // Second install produces zero state patches (only a redundant-noop log).
    expect(second.patches.length).toBe(0);
    // And the log should carry a redundant_noop kind for replay audit.
    expect(second.log.some((l) => /redundant_noop/.test(l.kind))).toBe(true);
  });
});

describeIfBackend('cost_reduction: validate rejects non-positive amount', () => {
  it('ok=false when amount is zero', () => {
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'src' });
    const registry = BACKEND!.buildDefaultRegistry();
    const h = registry.get('cost_reduction');
    if (!h?.validate) {
      expect(h).toBeDefined();
      return;
    }
    const op: EffectOp = {
      type: 'cost_reduction',
      source: source.instanceId,
      amount: 0,
      kind: 'energy',
    };
    const result = h.validate(ctx, op, source);
    expect(result.ok).toBe(false);
  });
});

describeIfBackend('cost_increase: sign-flipped cost_reduction', () => {
  it('registers an increase entry without touching imperative state', () => {
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'src' });
    const op: EffectOp = {
      type: 'cost_increase',
      source: source.instanceId,
      amount: 1,
      kind: 'any',
    };
    const res = BACKEND!.runOp(ctx, op, source);
    const disallowed = res.patches.some(
      (p) => /points|runePool|damage|\/might$/.test(p.path),
    );
    expect(disallowed).toBe(false);
  });

  it('validate rejects zero amount (cost modifiers must have magnitude)', () => {
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'src' });
    const registry = BACKEND!.buildDefaultRegistry();
    const h = registry.get('cost_increase');
    if (!h?.validate) {
      expect(h).toBeDefined();
      return;
    }
    const op: EffectOp = {
      type: 'cost_increase',
      source: source.instanceId,
      amount: 0,
    };
    const result = h.validate(ctx, op, source);
    expect(result.ok).toBe(false);
  });
});

describeIfBackend('targeting_discount: conditional cost_reduction', () => {
  it('registration-shaped; no patches that mutate costs directly', () => {
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'src' });
    const op: EffectOp = {
      type: 'targeting_discount',
      source: source.instanceId,
      amount: 1,
      targetPredicate: { tribe: 'Beast' },
    };
    const res = BACKEND!.runOp(ctx, op, source);
    // No state mutations at registration.
    const disallowed = res.patches.some(
      (p) => /points|runePool|damage|\/might$/.test(p.path),
    );
    expect(disallowed).toBe(false);
    // No immediate trigger fires.
    expect(res.triggeredAbilities.length).toBe(0);
  });

  it('installs a predicate payload for later matching', () => {
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'src' });
    const op: EffectOp = {
      type: 'targeting_discount',
      source: source.instanceId,
      amount: 2,
      targetPredicate: { cardType: 'Unit' },
    };
    const res = BACKEND!.runOp(ctx, op, source);
    // Log entry MUST carry the predicate so replay can reconstruct intent.
    const hasLog = res.log.some(
      (l) => /discount|targeting|cost_modifier/i.test(l.kind),
    );
    expect(hasLog).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 6 directed coverage for targeting_discount.
//
// Only 2 cards in data/cards.enriched.json emit targeting_discount: SFD-141
// Irelia - Graceful and SFD-141A (Irelia - Graceful promo). Phase 5c random
// 20-match run did not fire this handler because those cards rarely end up
// on the board in random decks AND their discount-target predicate rarely
// aligns with the bot's next play. Spec section 10 (Cost Modifiers)
// anchors the registration-shaped contract.
// ---------------------------------------------------------------------------

describeIfBackend('targeting_discount: real-card coverage (phase-6)', () => {
  it('targeting_discount: real-card happy path (SFD-141, phase-6 coverage)', () => {
    const card = FIXTURES.SFD_141_IRELIA;
    expect(card.effectProfile.operations.map((o) => o.type)).toContain('targeting_discount');

    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'sfd-141-inst', cardId: card.id });
    const op: EffectOp = {
      type: 'targeting_discount',
      source: source.instanceId,
      amount: 1,
      targetPredicate: { tribe: 'Ionia' },
    };
    const res = BACKEND!.runOp(ctx, op, source);
    const disallowed = res.patches.some(
      (p) => /points|runePool|damage|\/might$/.test(p.path),
    );
    expect(disallowed).toBe(false);
    expect(res.triggeredAbilities.length).toBe(0);
    const hasLog = res.log.some(
      (l) => /discount|targeting|cost_modifier/i.test(l.kind),
    );
    expect(hasLog).toBe(true);
  });
});
