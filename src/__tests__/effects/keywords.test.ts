/**
 * Keyword marker handler contract tests: keyword_hidden, keyword_ganking,
 * keyword_accelerate, keyword_deflect.
 *
 * Spec anchors: section 11 (Keyword Granting), rules 805-826.
 *
 * These ops are registration-shaped: they advertise a keyword on the source
 * card. At Phase 2 they do not mutate board state imperatively; they append
 * to source.grantedKeywords or publish to a keyword registry the effective-
 * keyword layer reads at query time.
 */
import {
  BACKEND,
  describeIfBackend,
  makeCtx,
  makeUnit,
  applyPatches,
  resetInstanceCounter,
  EffectOp,
  CardInstance,
} from './_harness';

beforeEach(() => {
  resetInstanceCounter();
});

describeIfBackend('keyword_hidden (rule 811)', () => {
  it('registers Hidden on the source without an imperative state change', () => {
    let ctx = makeCtx();
    const source = makeUnit({ instanceId: 'u1' });
    (ctx as unknown as { units: Record<string, CardInstance> }).units = { u1: source };
    const op: EffectOp = { type: 'keyword_hidden', source: source.instanceId };
    const res = BACKEND!.runOp(ctx, op, source);
    // No damage / position / counter mutations.
    const disallowed = res.patches.some(
      (p) => /damage|location|exhausted|hasBuffCounter/.test(p.path),
    );
    expect(disallowed).toBe(false);
    ctx = applyPatches(ctx, res.patches);
    const updated = (ctx as unknown as { units?: Record<string, CardInstance> }).units?.u1;
    const hasHidden =
      (updated?.grantedKeywords ?? []).some((k) => /hidden/i.test(k.keyword)) ||
      (updated?.keywords ?? []).some((k) => /hidden/i.test(k));
    // Either representation is acceptable.
    expect(hasHidden).toBe(true);
  });
});

describeIfBackend('keyword_ganking (rule 810)', () => {
  it('registers Ganking as a boolean keyword (redundant stacking)', () => {
    let ctx = makeCtx();
    const source = makeUnit({ instanceId: 'u1' });
    (ctx as unknown as { units: Record<string, CardInstance> }).units = { u1: source };
    const op: EffectOp = { type: 'keyword_ganking', source: source.instanceId };
    // Applying twice must be a no-op for the second call (spec 11.1:
    // redundant stack behavior).
    const first = BACKEND!.runOp(ctx, op, source);
    ctx = applyPatches(ctx, first.patches);
    const second = BACKEND!.runOp(ctx, op, source);
    ctx = applyPatches(ctx, second.patches);
    const updated = (ctx as unknown as { units?: Record<string, CardInstance> }).units?.u1;
    const gankingCount = (updated?.grantedKeywords ?? []).filter((k) => /ganking/i.test(k.keyword))
      .length;
    // Either no granted-keyword entry (intrinsic) or exactly 1 (idempotent).
    expect(gankingCount).toBeLessThanOrEqual(1);
  });
});

describeIfBackend('keyword_accelerate (rule 805)', () => {
  it('grants an ETB slot override: unit enters ready instead of exhausted', () => {
    // Accelerate is an optional-cost keyword; at registration the handler
    // must mark the card eligible for the ready-entry override. We verify
    // the handler returns patches that touch either the card's
    // grantedKeywords or a dispatcher-level entryStateOverride registry.
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'u1' });
    const op: EffectOp = { type: 'keyword_accelerate', source: source.instanceId };
    const res = BACKEND!.runOp(ctx, op, source);
    const touched = res.patches.some(
      (p) => /accelerate|grantedKeywords|entryState/.test(p.path),
    );
    expect(touched).toBe(true);
  });
});

describeIfBackend('keyword_deflect (rule 809)', () => {
  it('value sums when multiple Deflect grants apply to the same card (spec 11.1)', () => {
    let ctx = makeCtx();
    const source = makeUnit({ instanceId: 'u1' });
    (ctx as unknown as { units: Record<string, CardInstance> }).units = { u1: source };
    const op1: EffectOp = { type: 'keyword_deflect', source: source.instanceId, value: 1 };
    const op2: EffectOp = { type: 'keyword_deflect', source: source.instanceId, value: 2 };
    const r1 = BACKEND!.runOp(ctx, op1, source);
    ctx = applyPatches(ctx, r1.patches);
    const r2 = BACKEND!.runOp(ctx, op2, source);
    ctx = applyPatches(ctx, r2.patches);
    const updated = (ctx as unknown as { units?: Record<string, CardInstance> }).units?.u1;
    const deflects = (updated?.grantedKeywords ?? []).filter((k) => /deflect/i.test(k.keyword));
    // Either representation is acceptable as long as the effective value is
    // 3. We compute it across all recorded Deflect grants.
    const total = deflects.reduce((acc, k) => acc + (k.value ?? 0), 0);
    expect(total).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Phase 3: keyword_weaponmaster, keyword_tank, keyword_repeat, keyword_legion,
// tribal_synergy.
//
// Spec anchors: section 11 (Keyword Granting), rules 817 (Legion), 820
// (Repeat), 821 (Weaponmaster), 823 (Tank).
//
// Keyword-marker ops are registration-shaped (same pattern as Phase 2
// keyword_hidden / keyword_ganking / keyword_accelerate / keyword_deflect).
// They advertise a keyword onto the source; stacking behavior follows
// spec 11.1 redundant-vs-accumulating matrix.
// ---------------------------------------------------------------------------

const BOOLEAN_KEYWORD_OPS = [
  { op: 'keyword_weaponmaster' as const, match: /weaponmaster/i },
  { op: 'keyword_tank' as const, match: /tank/i },
  { op: 'keyword_repeat' as const, match: /repeat/i },
  { op: 'keyword_legion' as const, match: /legion/i },
];

describeIfBackend('boolean keyword markers: registration-shaped', () => {
  it.each(BOOLEAN_KEYWORD_OPS)('%s installs the keyword on source', ({ op, match }) => {
    let ctx = makeCtx();
    const source = makeUnit({ instanceId: 'u1' });
    (ctx as unknown as { units: Record<string, CardInstance> }).units = { u1: source };
    const registrationOp = { type: op, source: source.instanceId } as EffectOp;
    const res = BACKEND!.runOp(ctx, registrationOp, source);
    // No imperative mutation of damage / location / exhausted.
    const disallowed = res.patches.some(
      (p) => /damage|\/location|exhausted|hasBuffCounter/.test(p.path),
    );
    expect(disallowed).toBe(false);
    ctx = applyPatches(ctx, res.patches);
    const updated = (ctx as unknown as { units?: Record<string, CardInstance> }).units?.u1;
    const hasIt =
      (updated?.grantedKeywords ?? []).some((k) => match.test(k.keyword)) ||
      (updated?.keywords ?? []).some((k) => match.test(k));
    // Accept either representation; some backends treat these as intrinsic
    // (no grantedKeywords entry) - in that case we still require a log trail.
    if (!hasIt) {
      const logged = res.log.some((l) => /register|keyword/i.test(l.kind));
      expect(logged).toBe(true);
    } else {
      expect(hasIt).toBe(true);
    }
  });
});

describeIfBackend('boolean keyword markers: idempotent stacking (spec 11.1)', () => {
  it.each(BOOLEAN_KEYWORD_OPS)('%s second install is a no-op for the keyword slot', ({ op, match }) => {
    let ctx = makeCtx();
    const source = makeUnit({ instanceId: 'u1' });
    (ctx as unknown as { units: Record<string, CardInstance> }).units = { u1: source };
    const registrationOp = { type: op, source: source.instanceId } as EffectOp;
    const first = BACKEND!.runOp(ctx, registrationOp, source);
    ctx = applyPatches(ctx, first.patches);
    const second = BACKEND!.runOp(ctx, registrationOp, source);
    ctx = applyPatches(ctx, second.patches);
    const updated = (ctx as unknown as { units?: Record<string, CardInstance> }).units?.u1;
    const count = (updated?.grantedKeywords ?? []).filter((k) => match.test(k.keyword)).length;
    // Boolean keywords do not accumulate (spec 11.1).
    expect(count).toBeLessThanOrEqual(1);
  });
});

describeIfBackend('tribal_synergy: registration-shaped', () => {
  it('installs a tribal synergy entry keyed on tribe name', () => {
    let ctx = makeCtx();
    const source = makeUnit({ instanceId: 'u1', tags: ['Beast'] });
    (ctx as unknown as { units: Record<string, CardInstance> }).units = { u1: source };
    const op: EffectOp = {
      type: 'tribal_synergy',
      source: source.instanceId,
      tribe: 'Beast',
      effect: 'might',
      magnitude: 1,
    };
    const res = BACKEND!.runOp(ctx, op, source);
    // No imperative might mutation.
    const disallowed = res.patches.some((p) => /\/might$/.test(p.path));
    expect(disallowed).toBe(false);
    ctx = applyPatches(ctx, res.patches);
    // Either temporaryMods or log trail.
    const logged = res.log.some((l) => /tribal|synergy|register/i.test(l.kind));
    const modded = (ctx.temporaryMods as unknown[]).some((m) => {
      const r = m as { kind?: string; source?: string };
      return r?.source === 'u1' && /tribal|synergy/.test(r?.kind ?? '');
    });
    expect(logged || modded).toBe(true);
  });

  it('validate rejects empty tribe', () => {
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'u1' });
    const registry = BACKEND!.buildDefaultRegistry();
    const h = registry.get('tribal_synergy');
    if (!h?.validate) {
      expect(h).toBeDefined();
      return;
    }
    const op: EffectOp = {
      type: 'tribal_synergy',
      source: source.instanceId,
      tribe: '',
      effect: 'might',
      magnitude: 1,
    };
    const result = h.validate(ctx, op, source);
    expect(result.ok).toBe(false);
  });
});
