/**
 * Phase 10 - directed coverage for the 8 long-tail ops flagged in
 * docs/phase-7-coverage-audit.md section 3.
 *
 * Long-tail ops are handlers that are registered in buildDefaultRegistry
 * and have unit coverage elsewhere, but each emit on only 1-4 cards in
 * the enriched catalog. Phase 5c random bot-run did not fire any of them;
 * Phase 6/8 landed scattered real-card checks but nothing that routes the
 * op through the public dispatcher + matches the enriched op shape.
 *
 * This file pins each op with:
 *   1. A directed unit test proving the handler produces the expected
 *      patch / log shape given a hand-constructed context.
 *   2. An integration test that pulls the op from the real FIXTURES card
 *      (or the real enriched catalog JSON for manipulate_priority, which
 *      has no catalog emitters - see docs/phase-10-long-tail-findings.md),
 *      dispatches via BACKEND!.runOp, and observes the same registration
 *      signal reaches ctx.
 *
 * The 8 ops covered here:
 *   manipulate_priority, stat_scaling, ability_copy, targeting_discount,
 *   follow_movement, conditional_buff, hide_modifier, scoring_restriction.
 */
import {
  BACKEND,
  describeIfBackend,
  makeCtx,
  makeUnit,
  applyPatches,
  resetInstanceCounter,
  EffectOp,
  EngineCtx,
} from './_harness';
import { FIXTURES } from './fixtures/real-cards';

beforeEach(() => {
  resetInstanceCounter();
});

// ---------------------------------------------------------------------------
// Helper: locate a handler from the default registry. Used by directed unit
// tests that want to exercise validate() without going through runOp.
// ---------------------------------------------------------------------------
function getHandler(opType: string) {
  return BACKEND!.buildDefaultRegistry().get(opType);
}

function hasTempMod(
  ctx: EngineCtx,
  predicate: (m: Record<string, unknown>) => boolean,
): boolean {
  return (ctx.temporaryMods as unknown[]).some((m) =>
    predicate(m as Record<string, unknown>),
  );
}

// ---------------------------------------------------------------------------
// 1. manipulate_priority
// ---------------------------------------------------------------------------

describeIfBackend('phase-10 long-tail: manipulate_priority', () => {
  it('directed: grant_priority updates priorityHolder only (patch-path)', () => {
    let ctx = makeCtx({
      priorityHolder: 'p1',
      focusHolder: 'p1',
      turnState: {
        turnNumber: 1,
        phase: 'main',
        mode: 'neutral_open',
        combat: null,
        showdown: null,
        onceThisTurnUsed: {},
        triggeredThisTurn: {},
      },
    });
    const source = makeUnit({ instanceId: 'pri-src' });
    const op: EffectOp = {
      type: 'manipulate_priority',
      variant: 'grant_priority',
      targetPlayer: 'p2',
    };
    const res = BACKEND!.runOp(ctx, op, source);
    ctx = applyPatches(ctx, res.patches);
    expect(ctx.priorityHolder).toBe('p2');
    // focusHolder is untouched by grant_priority.
    expect(ctx.focusHolder).toBe('p1');
    const logged = res.log.some((l) =>
      /manipulate_priority_grant_priority/.test(l.kind),
    );
    expect(logged).toBe(true);
  });

  it('integration: synthetic-fixture route (no enriched catalog emitter; see phase-10 findings doc)', () => {
    // data/cards.enriched.json currently has 0 cards emitting
    // manipulate_priority in effectProfile.operations[]. The audit
    // reported 4 based on an earlier snapshot but the current enricher
    // has moved marker variants upstream. The single card we can still
    // route through the dispatcher is the Phase-3 synthetic fixture
    // OGN_179_ACCEPTABLE_LOSSES, whose operations[] retains the op for
    // regression purposes. We dispatch the op and assert the soft-fail
    // warn-log path because the marker variant is not a state mutation.
    const fx = FIXTURES.OGN_179_ACCEPTABLE_LOSSES;
    const opType = fx.effectProfile.operations[0]?.type;
    expect(opType).toBe('manipulate_priority');

    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'ogn-179-inst', cardId: fx.id });
    const op: EffectOp = {
      type: 'manipulate_priority',
      // No variant supplied - inferVariant() will fall back to
      // action_tagged (marker variant -> warn log path).
    } as EffectOp;
    const res = BACKEND!.runOp(ctx, op, source);
    expect(res.patches).toEqual([]);
    expect(res.triggeredAbilities).toEqual([]);
    const warned = res.log.some((l) => /priority.?tag|warn/i.test(l.kind));
    expect(warned).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. stat_scaling
// ---------------------------------------------------------------------------

describeIfBackend('phase-10 long-tail: stat_scaling', () => {
  it('directed: registers a temporaryMods entry with kind=stat_scaling', () => {
    let ctx = makeCtx();
    const source = makeUnit({ instanceId: 'scaling-src' });
    const op: EffectOp = {
      type: 'stat_scaling',
      source: source.instanceId,
      formula: 'per_gear',
    };
    const res = BACKEND!.runOp(ctx, op, source);
    ctx = applyPatches(ctx, res.patches);

    const entry = (ctx.temporaryMods as unknown[]).find((m) => {
      const r = m as { source?: string; kind?: string };
      return r?.source === 'scaling-src' && r?.kind === 'stat_scaling';
    });
    expect(entry).toBeDefined();
    expect(res.log.some((l) => /stat_scaling_registered/.test(l.kind))).toBe(
      true,
    );
  });

  it('integration: OGN-109 Dr. Mundo real op shape dispatches without mutating might', () => {
    const fx = FIXTURES.OGN_109_DR_MUNDO;
    const realOp = fx.effectProfile.operations.find(
      (o) => o.type === 'stat_scaling',
    );
    expect(realOp).toBeDefined();

    let ctx = makeCtx();
    const source = makeUnit({ instanceId: 'ogn-109-inst', cardId: fx.id });
    // The real enricher shape lacks formula. Our handler falls back to
    // per_friendly_unit. The invariant we pin: no imperative might patch,
    // a registration entry landed, and the log captured intent.
    const op: EffectOp = {
      ...(realOp as unknown as EffectOp),
      source: source.instanceId,
    };
    const res = BACKEND!.runOp(ctx, op, source);
    const imperative = res.patches.some((p) =>
      /\/might$|\/temporaryMightMod$/.test(p.path),
    );
    expect(imperative).toBe(false);
    ctx = applyPatches(ctx, res.patches);
    const registered = hasTempMod(
      ctx,
      (m) => m.source === 'ogn-109-inst' && m.kind === 'stat_scaling',
    );
    expect(registered).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. ability_copy
// ---------------------------------------------------------------------------

describeIfBackend('phase-10 long-tail: ability_copy', () => {
  it('directed: appends a copiedAbilities entry on the target unit', () => {
    let ctx = makeCtx() as EngineCtx & {
      units?: Record<string, unknown>;
    };
    // Seed a target unit so the patch path has a pre-existing node.
    (ctx as unknown as { units: Record<string, unknown> }).units = {
      'target-unit': { copiedAbilities: [] },
    };
    const source = makeUnit({ instanceId: 'copier' });
    const op: EffectOp = {
      type: 'ability_copy',
      source: source.instanceId,
      target: 'target-unit',
    } as EffectOp;
    const res = BACKEND!.runOp(ctx, op, source);
    const copyPatch = res.patches.find((p) =>
      /\/units\/target-unit\/copiedAbilities\/-$/.test(p.path),
    );
    expect(copyPatch).toBeDefined();
    expect((copyPatch!.value as { source?: string })?.source).toBe('copier');
    expect(res.log.some((l) => /ability_copy_applied/.test(l.kind))).toBe(true);
  });

  it('integration: OGN-111 Heimerdinger dispatches ability_copy and logs applied', () => {
    const fx = FIXTURES.OGN_111_HEIMERDINGER;
    const realOp = fx.effectProfile.operations.find(
      (o) => o.type === 'ability_copy',
    );
    expect(realOp).toBeDefined();

    const ctx = makeCtx() as EngineCtx & { units?: Record<string, unknown> };
    (ctx as unknown as { units: Record<string, unknown> }).units = {
      'heimer-inst': { copiedAbilities: [] },
    };
    const source = makeUnit({ instanceId: 'heimer-inst', cardId: fx.id });
    const op: EffectOp = {
      ...(realOp as unknown as EffectOp),
      // Heimer copies onto self (targetHint='self'). Handler falls back to
      // source when target is absent, which matches the real behavior.
    };
    const res = BACKEND!.runOp(ctx, op, source);
    const appliedLog = res.log.some((l) => /ability_copy_applied/.test(l.kind));
    expect(appliedLog).toBe(true);
    const pointsToSelf = res.patches.some((p) =>
      /\/units\/heimer-inst\/copiedAbilities\/-$/.test(p.path),
    );
    expect(pointsToSelf).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. targeting_discount
// ---------------------------------------------------------------------------

describeIfBackend('phase-10 long-tail: targeting_discount', () => {
  it('directed: registers a temporaryMods entry with registeredBy=targeting_discount', () => {
    let ctx = makeCtx();
    const source = makeUnit({ instanceId: 'td-src' });
    const op: EffectOp = {
      type: 'targeting_discount',
      source: source.instanceId,
      amount: 2,
      targetPredicate: { tribe: 'Ionia' },
    };
    const res = BACKEND!.runOp(ctx, op, source);
    ctx = applyPatches(ctx, res.patches);
    const registered = hasTempMod(
      ctx,
      (m) =>
        m.source === 'td-src' &&
        (m as { registeredBy?: string }).registeredBy === 'targeting_discount',
    );
    expect(registered).toBe(true);
    expect(
      res.log.some((l) => /targeting_discount_registered/.test(l.kind)),
    ).toBe(true);
  });

  it('directed: validate rejects zero amount', () => {
    const ctx = makeCtx();
    const source = makeUnit();
    const h = getHandler('targeting_discount');
    expect(h?.validate).toBeDefined();
    const bad: EffectOp = {
      type: 'targeting_discount',
      source: source.instanceId,
      amount: 0,
    } as EffectOp;
    const result = h!.validate!(ctx, bad, source);
    expect(result.ok).toBe(false);
  });

  it('integration: SFD-141 Irelia real op shape dispatches as cost-modifier registration', () => {
    const fx = FIXTURES.SFD_141_IRELIA;
    const realOp = fx.effectProfile.operations.find(
      (o) => o.type === 'targeting_discount',
    );
    expect(realOp).toBeDefined();

    let ctx = makeCtx();
    const source = makeUnit({ instanceId: 'irelia-inst', cardId: fx.id });
    // Real op lacks `amount`; we inject a positive magnitude so validate
    // accepts. This matches how a future enricher fix-up pass would
    // default magnitude (see docs/riftbound-effect-spec.md section 10).
    const op: EffectOp = {
      ...(realOp as unknown as EffectOp),
      source: source.instanceId,
      amount: 1,
    };
    const res = BACKEND!.runOp(ctx, op, source);
    // No immediate cost / damage mutations.
    const disallowed = res.patches.some((p) =>
      /points|runePool|damage|\/might$/.test(p.path),
    );
    expect(disallowed).toBe(false);
    ctx = applyPatches(ctx, res.patches);
    const registered = hasTempMod(
      ctx,
      (m) =>
        (m as { registeredBy?: string }).registeredBy === 'targeting_discount' &&
        m.source === 'irelia-inst',
    );
    expect(registered).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. follow_movement
// ---------------------------------------------------------------------------

describeIfBackend('phase-10 long-tail: follow_movement', () => {
  it('directed: appends a followMovementSubs entry via patch', () => {
    let ctx = makeCtx() as EngineCtx & {
      followMovementSubs?: Array<unknown>;
    };
    (ctx as unknown as { followMovementSubs: unknown[] }).followMovementSubs =
      [];
    const source = makeUnit({ instanceId: 'follower-1', controller: 'p1' });
    const op: EffectOp = {
      type: 'follow_movement',
      source: source.instanceId,
    } as EffectOp;
    const res = BACKEND!.runOp(ctx, op, source);
    const subPatch = res.patches.find((p) => p.path === '/followMovementSubs/-');
    expect(subPatch).toBeDefined();
    const sub = subPatch!.value as {
      source: string;
      action: string;
      trigger: { originMatch: string; controllerMatch: string };
    };
    expect(sub.source).toBe('follower-1');
    expect(sub.action).toBe('may_follow');
    expect(sub.trigger.originMatch).toBe('self_location');
    expect(sub.trigger.controllerMatch).toBe('friendly');
    expect(
      res.log.some((l) => /follow_movement_registered/.test(l.kind)),
    ).toBe(true);
  });

  it('integration: OGN-177 Stealthy Pursuer real op installs the subscription', () => {
    const fx = FIXTURES.OGN_177_STEALTHY_PURSUER;
    const realOp = fx.effectProfile.operations.find(
      (o) => o.type === 'follow_movement',
    );
    expect(realOp).toBeDefined();

    let ctx = makeCtx() as EngineCtx & {
      followMovementSubs?: Array<unknown>;
    };
    (ctx as unknown as { followMovementSubs: unknown[] }).followMovementSubs =
      [];
    const source = makeUnit({ instanceId: 'ogn-177-inst', cardId: fx.id });
    const op: EffectOp = {
      ...(realOp as unknown as EffectOp),
      source: source.instanceId,
    };
    const res = BACKEND!.runOp(ctx, op, source);
    ctx = applyPatches(ctx, res.patches);
    const subs = (
      ctx as unknown as {
        followMovementSubs: Array<{ source: string }>;
      }
    ).followMovementSubs;
    expect(subs.some((s) => s.source === 'ogn-177-inst')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. conditional_buff
// ---------------------------------------------------------------------------

describeIfBackend('phase-10 long-tail: conditional_buff', () => {
  it('directed: registers a temporaryMods entry with kind=conditional_buff and carries predicate', () => {
    let ctx = makeCtx();
    const source = makeUnit({ instanceId: 'cb-src' });
    const op: EffectOp = {
      type: 'conditional_buff',
      source: source.instanceId,
      mightMod: 2,
      predicate: { kind: 'has_buff_counter' },
    };
    const res = BACKEND!.runOp(ctx, op, source);
    // No imperative might patches issued at registration.
    const disallowed = res.patches.some((p) => /\/might$/.test(p.path));
    expect(disallowed).toBe(false);
    ctx = applyPatches(ctx, res.patches);
    const entry = (ctx.temporaryMods as unknown[]).find((m) => {
      const r = m as {
        source?: string;
        kind?: string;
        predicate?: { kind?: string };
      };
      return r?.source === 'cb-src' && r?.kind === 'conditional_buff';
    }) as
      | { predicate?: { kind?: string }; mightMod?: number }
      | undefined;
    expect(entry).toBeDefined();
    expect(entry!.mightMod).toBe(2);
    expect(entry!.predicate?.kind).toBe('has_buff_counter');
  });

  it('integration: SFD-159 Trusty Ramhound real op shape registers predicate-gated buff', () => {
    const fx = FIXTURES.SFD_159_TRUSTY_RAMHOUND;
    const realOp = fx.effectProfile.operations.find(
      (o) => o.type === 'conditional_buff',
    );
    expect(realOp).toBeDefined();

    let ctx = makeCtx();
    const source = makeUnit({ instanceId: 'sfd-159-inst', cardId: fx.id });
    const op: EffectOp = {
      ...(realOp as unknown as EffectOp),
      source: source.instanceId,
    };
    const res = BACKEND!.runOp(ctx, op, source);
    ctx = applyPatches(ctx, res.patches);
    const registered = hasTempMod(
      ctx,
      (m) => m.source === 'sfd-159-inst' && m.kind === 'conditional_buff',
    );
    expect(registered).toBe(true);
    expect(res.triggeredAbilities.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. hide_modifier
// ---------------------------------------------------------------------------

describeIfBackend('phase-10 long-tail: hide_modifier', () => {
  it('directed: flips hideModifierActive=true on the source via patch', () => {
    const ctx = makeCtx() as EngineCtx & {
      units?: Record<string, { hideModifierActive?: boolean }>;
    };
    (ctx as unknown as { units: Record<string, unknown> }).units = {
      'hm-src': {},
    };
    const source = makeUnit({ instanceId: 'hm-src' });
    const op: EffectOp = {
      type: 'hide_modifier',
      source: source.instanceId,
    } as EffectOp;
    const res = BACKEND!.runOp(ctx, op, source);
    const patch = res.patches.find((p) =>
      /\/units\/hm-src\/hideModifierActive$/.test(p.path),
    );
    expect(patch).toBeDefined();
    expect(patch!.value).toBe(true);
    expect(
      res.log.some((l) => /hide_modifier_registered/.test(l.kind)),
    ).toBe(true);
  });

  it('directed: second install is a redundant no-op (idempotent)', () => {
    let ctx = makeCtx() as EngineCtx & {
      units?: Record<string, { hideModifierActive?: boolean }>;
    };
    (ctx as unknown as { units: Record<string, unknown> }).units = {
      'hm-src': {},
    };
    const source = makeUnit({ instanceId: 'hm-src' });
    const op: EffectOp = {
      type: 'hide_modifier',
      source: source.instanceId,
    } as EffectOp;
    const first = BACKEND!.runOp(ctx, op, source);
    ctx = applyPatches(ctx, first.patches);
    const second = BACKEND!.runOp(ctx, op, source);
    expect(second.patches).toEqual([]);
    expect(
      second.log.some((l) => /hide_modifier_redundant_noop/.test(l.kind)),
    ).toBe(true);
  });

  it('integration: OGN-278 Bandle Tree real op shape registers on the source', () => {
    const fx = FIXTURES.OGN_278_BANDLE_TREE;
    const realOp = fx.effectProfile.operations.find(
      (o) => o.type === 'hide_modifier',
    );
    expect(realOp).toBeDefined();

    let ctx = makeCtx() as EngineCtx & {
      units?: Record<string, unknown>;
    };
    (ctx as unknown as { units: Record<string, unknown> }).units = {
      'bandle-tree-inst': {},
    };
    const source = makeUnit({
      instanceId: 'bandle-tree-inst',
      cardId: fx.id,
    });
    const op: EffectOp = {
      ...(realOp as unknown as EffectOp),
      source: source.instanceId,
    };
    const res = BACKEND!.runOp(ctx, op, source);
    ctx = applyPatches(ctx, res.patches);
    const flag = (
      ctx as unknown as {
        units: Record<string, { hideModifierActive?: boolean }>;
      }
    ).units['bandle-tree-inst']?.hideModifierActive;
    expect(flag).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. scoring_restriction
// ---------------------------------------------------------------------------

describeIfBackend('phase-10 long-tail: scoring_restriction', () => {
  it('directed: appends a scoringRestrictions entry keyed on source', () => {
    let ctx = makeCtx();
    const source = makeUnit({ instanceId: 'sr-src' });
    const op: EffectOp = {
      type: 'scoring_restriction',
      source: source.instanceId,
      predicateKind: 'per_battlefield_turn_gate',
      predicatePayload: { window: 'this_turn' },
    } as EffectOp;
    const res = BACKEND!.runOp(ctx, op, source);
    ctx = applyPatches(ctx, res.patches);
    const entries = (ctx.scoringRestrictions as unknown[]) ?? [];
    const entry = entries.find((e) => {
      const r = e as { source?: string; predicateKind?: string };
      return (
        r?.source === 'sr-src' &&
        r?.predicateKind === 'per_battlefield_turn_gate'
      );
    });
    expect(entry).toBeDefined();
    expect(
      res.log.some((l) => /scoring_restriction_registered/.test(l.kind)),
    ).toBe(true);
  });

  it('integration: SFD-209 Forgotten Monument real op shape installs a predicate', () => {
    const fx = FIXTURES.SFD_209_FORGOTTEN_MONUMENT_REAL;
    const realOp = fx.effectProfile.operations.find(
      (o) => o.type === 'scoring_restriction',
    );
    expect(realOp).toBeDefined();

    let ctx = makeCtx();
    const source = makeUnit({ instanceId: 'sfd-209-inst', cardId: fx.id });
    const op: EffectOp = {
      ...(realOp as unknown as EffectOp),
      source: source.instanceId,
    };
    const res = BACKEND!.runOp(ctx, op, source);
    ctx = applyPatches(ctx, res.patches);
    const entries = (ctx.scoringRestrictions as unknown[]) ?? [];
    expect(
      entries.some((e) => (e as { source?: string }).source === 'sfd-209-inst'),
    ).toBe(true);
  });
});
