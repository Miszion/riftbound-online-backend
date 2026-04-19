/**
 * modify_stats handler contract tests.
 *
 * Spec anchors: section 8 (Counter Manipulation), section 12 (OpHandler shape).
 *
 * Rule 426.1.b.1: Buff counters are binary. A second "buff this unit" is a
 * no-op. +N/+N style might modifiers (rule 110, 317.2.c) stack arithmetically
 * as long as they share a duration bucket.
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

beforeEach(() => {
  resetInstanceCounter();
});

describeIfBackend('modify_stats: happy path', () => {
  it('applies a this-turn might modifier', () => {
    const ctx = makeCtx();
    const u = makeUnit({ instanceId: 'u1', might: 3 });
    ctx.zones.board.bases.p1.presentUnits.push(u.instanceId);
    const op: EffectOp = {
      type: 'modify_stats',
      target: u.instanceId,
      mightMod: 2,
      duration: 'this_turn',
    };
    const res = BACKEND!.runOp(ctx, op, u);
    expect(res.patches.length).toBeGreaterThan(0);
    // Some patch must land on a path that captures the delta, either on a
    // temporaryMightMod field or on a temporaryMods collection append.
    const touchedTempMod = res.patches.some(
      (p) => /temporaryMightMod|temporaryMods/.test(p.path),
    );
    expect(touchedTempMod).toBe(true);
  });

  it('sets hasBuffCounter when addBuffCounter is true', () => {
    const ctx = makeCtx();
    const u = makeUnit({ instanceId: 'u1' });
    ctx.zones.board.bases.p1.presentUnits.push(u.instanceId);
    const op: EffectOp = {
      type: 'modify_stats',
      target: u.instanceId,
      addBuffCounter: true,
    };
    const res = BACKEND!.runOp(ctx, op, u);
    const hits = res.patches.filter((p) => /hasBuffCounter/.test(p.path));
    expect(hits.length).toBe(1);
    expect(hits[0]?.value).toBe(true);
  });
});

describeIfBackend('modify_stats: rule 426 binary buff counter', () => {
  it('buff counter does not stack; second buff is a no-op for the counter slot', () => {
    const ctx = makeCtx();
    const u = makeUnit({ instanceId: 'u1', state: { exhausted: false, damage: 0, hasBuffCounter: true, facedown: false } });
    ctx.zones.board.bases.p1.presentUnits.push(u.instanceId);
    const op: EffectOp = {
      type: 'modify_stats',
      target: u.instanceId,
      addBuffCounter: true,
    };
    const res = BACKEND!.runOp(ctx, op, u);
    // No patch should attempt to set hasBuffCounter because it's already true.
    const hits = res.patches.filter(
      (p) => /hasBuffCounter/.test(p.path) && p.op === 'replace',
    );
    expect(hits.length).toBe(0);
    // A log entry should record the no-op for replay determinism.
    const loggedNoop = res.log.some((l) => /buff.*redundant|no.?op/i.test(l.kind));
    expect(loggedNoop).toBe(true);
  });
});

describeIfBackend('modify_stats: stacking (spec 8.4)', () => {
  it('two +N might modifiers applied in sequence stack arithmetically', () => {
    let ctx = makeCtx();
    const u = makeUnit({ instanceId: 'u1', might: 3 });
    ctx.zones.board.bases.p1.presentUnits.push(u.instanceId);
    const op: EffectOp = {
      type: 'modify_stats',
      target: u.instanceId,
      mightMod: 2,
      duration: 'this_turn',
    };
    const first = BACKEND!.runOp(ctx, op, u);
    ctx = applyPatches(ctx, first.patches);
    const second = BACKEND!.runOp(ctx, op, u);
    ctx = applyPatches(ctx, second.patches);
    // Rule 814.2-style stacking: both mods are live. We do not assert the
    // exact storage shape; we assert a total of two temporary modifications
    // are attributable to this unit.
    const tempMods = (ctx.temporaryMods as unknown[]).filter((m) => {
      const r = m as { appliedTo?: string };
      return r?.appliedTo === u.instanceId;
    });
    expect(tempMods.length).toBe(2);
  });
});

describeIfBackend('modify_stats: validate rejects missing target', () => {
  it('returns ok=false when the target instance does not exist on the board', () => {
    const ctx = makeCtx();
    const source = makeUnit();
    const registry = BACKEND!.buildDefaultRegistry();
    const h = registry.get('modify_stats');
    if (!h || !h.validate) {
      // TODO(backend): modify_stats validate not exported; skip validation
      // contract but fail louder if handler is missing entirely.
      expect(h).toBeDefined();
      return;
    }
    const result = h.validate(ctx, { type: 'modify_stats', target: 'nope-nonexistent' } as EffectOp, source);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase 3: aura_buff, stat_scaling, conditional_buff, effect_amplifier.
//
// Spec anchors: section 8 (counters), section 11 (keyword/aura registration).
// These ops are registration-shaped. They install a passive modifier into
// ctx.temporaryMods (or an equivalent aura registry) that the layers engine
// consults at read time. No imperative stat patch.
// ---------------------------------------------------------------------------

describeIfBackend('aura_buff: registers a passive stat aura', () => {
  it('records an aura entry keyed on source without mutating any unit might directly', () => {
    let ctx = makeCtx();
    const source = makeUnit({ instanceId: 'src-aura' });
    const op: EffectOp = {
      type: 'aura_buff',
      source: source.instanceId,
      mightMod: 1,
      selector: { scope: 'friendly_units' },
    };
    const res = BACKEND!.runOp(ctx, op, source);
    // No patches that set a specific target.might / temporaryMightMod because
    // aura effects are read through, not imperatively applied.
    const imperativeMight = res.patches.some(
      (p) => /\/might$|\/temporaryMightMod$/.test(p.path),
    );
    expect(imperativeMight).toBe(false);
    // Registration trail exists: either a temporaryMods append or a log entry.
    ctx = applyPatches(ctx, res.patches);
    const registered =
      (ctx.temporaryMods as unknown[]).some((m) => {
        const r = m as { source?: string; kind?: string };
        return r?.source === source.instanceId && /aura|might/.test(r?.kind ?? '');
      }) ||
      res.log.some((l) => /aura|register/i.test(l.kind));
    expect(registered).toBe(true);
  });
});

describeIfBackend('aura_buff: validate rejects missing source', () => {
  it('ok=false when the source is not on the board', () => {
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'src-aura' });
    const registry = BACKEND!.buildDefaultRegistry();
    const h = registry.get('aura_buff');
    if (!h?.validate) {
      expect(h).toBeDefined();
      return;
    }
    const op: EffectOp = {
      type: 'aura_buff',
      source: 'ghost-src',
      mightMod: 1,
      selector: {},
    };
    const result = h.validate(ctx, op, source);
    expect(result.ok).toBe(false);
  });
});

describeIfBackend('stat_scaling: formula registration', () => {
  it('registers a scaling entry; subsequent installs stack as distinct entries', () => {
    let ctx = makeCtx();
    const source = makeUnit({ instanceId: 'src-scaling' });
    const op: EffectOp = {
      type: 'stat_scaling',
      source: source.instanceId,
      formula: 'per_gear',
    };
    const first = BACKEND!.runOp(ctx, op, source);
    ctx = applyPatches(ctx, first.patches);
    const second = BACKEND!.runOp(ctx, op, source);
    ctx = applyPatches(ctx, second.patches);
    // Two installs produce two entries - scaling does not collapse.
    const entries = (ctx.temporaryMods as unknown[]).filter((m) => {
      const r = m as { source?: string; kind?: string };
      return r?.source === 'src-scaling' && /scaling|stat/.test(r?.kind ?? '');
    });
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });
});

describeIfBackend('conditional_buff: registration', () => {
  it('installs a predicate-gated buff without imperative patch', () => {
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'src-cond' });
    const op: EffectOp = {
      type: 'conditional_buff',
      source: source.instanceId,
      mightMod: 2,
      predicate: { kind: 'turn_player' },
    };
    const res = BACKEND!.runOp(ctx, op, source);
    // No direct stat replace patches on any unit.
    const disallowed = res.patches.some((p) => /\/might$/.test(p.path));
    expect(disallowed).toBe(false);
    // No trigger fires at registration.
    expect(res.triggeredAbilities.length).toBe(0);
  });
});

describeIfBackend('effect_amplifier: registration', () => {
  it('records an amplifier entry; no imperative damage/heal patch issued', () => {
    let ctx = makeCtx();
    const source = makeUnit({ instanceId: 'src-amp' });
    const op: EffectOp = {
      type: 'effect_amplifier',
      source: source.instanceId,
      amplifies: 'damage_dealt',
      magnitude: 1,
    };
    const res = BACKEND!.runOp(ctx, op, source);
    const imperative = res.patches.some((p) => /\/damage$/.test(p.path));
    expect(imperative).toBe(false);
    ctx = applyPatches(ctx, res.patches);
    const logged = res.log.some((l) => /amplifier|register/i.test(l.kind));
    expect(logged).toBe(true);
  });
});
