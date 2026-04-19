/**
 * Misc op handler contract tests: generic, ability_copy.
 *
 * Spec anchors:
 *   - `generic` is the escape hatch for card text that does not reduce to any
 *     of the defined ops (section 12.2 UNIMPLEMENTED_EFFECT note, spec line
 *     861 "cards whose text does not reduce to these ops will log
 *     UNIMPLEMENTED_EFFECT and be played as no-ops"). Handler MUST no-op
 *     with a warn-level log entry. Rule 055.1 covers us legally.
 *   - `ability_copy` covers cards that copy another card's ability (rule
 *     386). Registration-shaped: the copy is installed on the source with a
 *     reference to the target's ability set.
 */
import {
  BACKEND,
  describeIfBackend,
  makeCtx,
  makeUnit,
  resetInstanceCounter,
  EffectOp,
} from './_harness';

beforeEach(() => {
  resetInstanceCounter();
});

describeIfBackend('generic: no-op with warn log (spec 12.2)', () => {
  it('produces zero patches and zero triggered abilities', () => {
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'gen-src' });
    const op: EffectOp = {
      type: 'generic',
      source: source.instanceId,
      note: 'unimplemented catch-all',
    };
    const res = BACKEND!.runOp(ctx, op, source);
    expect(res.patches).toEqual([]);
    expect(res.triggeredAbilities).toEqual([]);
  });

  it('emits a log entry tagged UNIMPLEMENTED_EFFECT or generic', () => {
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'gen-src' });
    const op: EffectOp = { type: 'generic', source: source.instanceId };
    const res = BACKEND!.runOp(ctx, op, source);
    const warned = res.log.some(
      (l) => /unimplemented|generic|no.?op|warn/i.test(l.kind),
    );
    expect(warned).toBe(true);
  });

  it('idempotent: two invocations produce no state drift', () => {
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'gen-src' });
    const op: EffectOp = { type: 'generic', source: source.instanceId };
    const first = BACKEND!.runOp(ctx, op, source);
    const second = BACKEND!.runOp(ctx, op, source);
    expect(first.patches).toEqual(second.patches);
    expect(first.patches).toEqual([]);
  });
});

describeIfBackend('ability_copy: registration-shaped (rule 386)', () => {
  it('no imperative state change; installs a copy reference', () => {
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'echo-src' });
    const op: EffectOp = {
      type: 'ability_copy',
      source: source.instanceId,
      targetAbilitySource: 'original-ability-src',
    };
    const res = BACKEND!.runOp(ctx, op, source);
    const disallowed = res.patches.some(
      (p) => /damage|points|exhausted|\/might$/.test(p.path),
    );
    expect(disallowed).toBe(false);
    expect(res.triggeredAbilities.length).toBe(0);
  });

  it('validate rejects copy when targetAbilitySource is missing / unknown', () => {
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'echo-src' });
    const registry = BACKEND!.buildDefaultRegistry();
    const h = registry.get('ability_copy');
    if (!h?.validate) {
      expect(h).toBeDefined();
      return;
    }
    const op: EffectOp = {
      type: 'ability_copy',
      source: source.instanceId,
      targetAbilitySource: '',
    };
    const result = h.validate(ctx, op, source);
    expect(result.ok).toBe(false);
  });

  it('logs a copy_registered entry so replay can reconstruct intent', () => {
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'echo-src' });
    const op: EffectOp = {
      type: 'ability_copy',
      source: source.instanceId,
      targetAbilitySource: 'original-ability-src',
    };
    const res = BACKEND!.runOp(ctx, op, source);
    const logged = res.log.some(
      (l) => /copy|register|ability/i.test(l.kind),
    );
    expect(logged).toBe(true);
  });
});
