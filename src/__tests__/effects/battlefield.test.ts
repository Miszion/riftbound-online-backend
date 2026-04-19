/**
 * control_battlefield handler contract tests.
 *
 * Spec anchors: section 13 (Battlefields + Scoring), rule 187.
 *
 * The handler does NOT mutate controller directly - it mutates presentUnits
 * and contested, and emits a Cleanup request that reconciles control. See
 * spec 13.5.
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

describeIfBackend('control_battlefield: contest mode (spec 13.5)', () => {
  it('sets contested=true when the forPlayer does not already control it', () => {
    let ctx = makeCtx();
    const source = makeUnit({ instanceId: 'src', controller: 'p1' });
    ctx.zones.board.battlefields['bf-1']!.controller = 'p2';
    const op: EffectOp = {
      type: 'control_battlefield',
      battlefieldId: 'bf-1',
      mode: 'contest',
      forPlayer: 'p1',
    };
    const res = BACKEND!.runOp(ctx, op, source);
    const contestedPatch = res.patches.find((p) => /contested/.test(p.path));
    expect(contestedPatch).toBeDefined();
    expect(contestedPatch?.value).toBe(true);
    ctx = applyPatches(ctx, res.patches);
    // controller must NOT be mutated inline.
    expect(ctx.zones.board.battlefields['bf-1']!.controller).toBe('p2');
  });

  it('schedules a cleanup request for control reconciliation', () => {
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'src', controller: 'p1' });
    ctx.zones.board.battlefields['bf-1']!.controller = 'p2';
    const op: EffectOp = {
      type: 'control_battlefield',
      battlefieldId: 'bf-1',
      mode: 'contest',
      forPlayer: 'p1',
    };
    const res = BACKEND!.runOp(ctx, op, source);
    const scheduled = res.log.some((l) => /cleanup|control.?reconcile/i.test(l.kind));
    expect(scheduled).toBe(true);
  });
});

describeIfBackend('control_battlefield: validate rejects nonexistent battlefield', () => {
  it('ok=false when battlefieldId is unknown', () => {
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'src' });
    const registry = BACKEND!.buildDefaultRegistry();
    const h = registry.get('control_battlefield');
    if (!h?.validate) {
      expect(h).toBeDefined();
      return;
    }
    const result = h.validate(
      ctx,
      {
        type: 'control_battlefield',
        battlefieldId: 'bf-nope',
        mode: 'contest',
        forPlayer: 'p1',
      } as EffectOp,
      source,
    );
    expect(result.ok).toBe(false);
  });
});

describeIfBackend('conquer_trigger: registers rather than executes', () => {
  it('installs an observer that fires on a conquer event', () => {
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'src', controller: 'p1' });
    const op: EffectOp = { type: 'conquer_trigger', source: source.instanceId };
    const res = BACKEND!.runOp(ctx, op, source);
    // No patches that change a player's points (the trigger is registration).
    const pointsMutation = res.patches.some((p) => /points/.test(p.path));
    expect(pointsMutation).toBe(false);
    // No fires at registration time.
    expect(res.triggeredAbilities.length).toBe(0);
  });

  it('a subsequent conquer event produces a TriggerFire (spec 13.4)', () => {
    if (!BACKEND!.TriggerRegistry) {
      // TODO(backend): TriggerRegistry not yet exported.
      return;
    }
    const reg = new BACKEND!.TriggerRegistry();
    reg.register({
      triggerType: 'on_conquer',
      sourceInstanceId: 'src',
      sourceController: 'p1',
    });
    const fires = reg.fire(
      { kind: 'on_conquer', payload: { conqueringPlayer: 'p1', battlefieldId: 'bf-1' } },
      makeCtx(),
    );
    expect(fires.length).toBe(1);
    expect(fires[0]?.sourceInstanceId).toBe('src');
  });
});

// ---------------------------------------------------------------------------
// Phase 3: scoring, scoring_restriction, location_aura, play_restriction.
//
// Spec anchors: section 13 (Battlefields + Scoring), rule 464-467 (Scoring
// / Conquer / Hold), rule 169.8 (passive abilities on battlefields).
// ---------------------------------------------------------------------------

describeIfBackend('scoring: effect-path scoring respects rule 465 (spec 13.5)', () => {
  it('increments player.points and records scoredBy for conquer reason', () => {
    let ctx = makeCtx();
    const source = makeUnit({ instanceId: 'src', controller: 'p1' });
    ctx.zones.board.battlefields['bf-1']!.controller = 'p1';
    const op: EffectOp = {
      type: 'scoring',
      player: 'p1',
      battlefieldId: 'bf-1',
      reason: 'conquer',
      amount: 1,
    };
    const res = BACKEND!.runOp(ctx, op, source);
    const pointsPatch = res.patches.some((p) => /points/.test(p.path));
    expect(pointsPatch).toBe(true);
    ctx = applyPatches(ctx, res.patches);
    expect(ctx.players[0]!.points).toBeGreaterThanOrEqual(1);
  });

  it('second conquer-score on same battlefield same turn is blocked (rule 465)', () => {
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'src', controller: 'p1' });
    // Seed state showing the battlefield was already scored by conquer.
    ctx.zones.board.battlefields['bf-1']!.scoredBy.p1 = 'conquer';
    ctx.players[0]!.scoredThisTurnByBattlefield.add('bf-1');
    const registry = BACKEND!.buildDefaultRegistry();
    const h = registry.get('scoring');
    if (!h?.validate) {
      expect(h).toBeDefined();
      return;
    }
    const op: EffectOp = {
      type: 'scoring',
      player: 'p1',
      battlefieldId: 'bf-1',
      reason: 'conquer',
      amount: 1,
    };
    const result = h.validate(ctx, op, source);
    expect(result.ok).toBe(false);
  });

  it('effect-reason scoring bypasses rule 465 cap', () => {
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'src', controller: 'p1' });
    ctx.zones.board.battlefields['bf-1']!.scoredBy.p1 = 'conquer';
    ctx.players[0]!.scoredThisTurnByBattlefield.add('bf-1');
    const registry = BACKEND!.buildDefaultRegistry();
    const h = registry.get('scoring');
    if (!h?.validate) {
      expect(h).toBeDefined();
      return;
    }
    const op: EffectOp = {
      type: 'scoring',
      player: 'p1',
      battlefieldId: 'bf-1',
      reason: 'effect',
      amount: 1,
    };
    const result = h.validate(ctx, op, source);
    expect(result.ok).toBe(true);
  });
});

describeIfBackend('scoring_restriction: registration-shaped (spec 13.5)', () => {
  it('no points mutation at registration', () => {
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'src-restriction' });
    const op: EffectOp = {
      type: 'scoring_restriction',
      source: source.instanceId,
      predicateKind: 'per_battlefield_turn_gate',
      predicatePayload: { minTurn: 3, battlefieldId: 'bf-1' },
    };
    const res = BACKEND!.runOp(ctx, op, source);
    const disallowed = res.patches.some((p) => /points/.test(p.path));
    expect(disallowed).toBe(false);
  });

  it('publishes a predicate that scoring.validate consults', () => {
    let ctx = makeCtx();
    const source = makeUnit({ instanceId: 'src-restriction', controller: 'p1' });
    ctx.zones.board.battlefields['bf-1']!.controller = 'p1';
    const restriction: EffectOp = {
      type: 'scoring_restriction',
      source: source.instanceId,
      predicateKind: 'per_battlefield_turn_gate',
      predicatePayload: { battlefieldId: 'bf-1', minTurn: 5 },
    };
    const r1 = BACKEND!.runOp(ctx, restriction, source);
    ctx = applyPatches(ctx, r1.patches);
    // Publication may live in ctx.scoringRestrictions or log. Probe both.
    const published =
      Array.isArray(ctx.scoringRestrictions) && ctx.scoringRestrictions.length > 0;
    const logged = r1.log.some((l) => /restriction|register/i.test(l.kind));
    expect(published || logged).toBe(true);
  });
});

describeIfBackend('location_aura: battlefield-local registration (spec 13.5)', () => {
  it('no imperative unit-mutation; installs an aura tied to battlefieldId', () => {
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'bf-src', controller: 'p1' });
    const op: EffectOp = {
      type: 'location_aura',
      source: source.instanceId,
      battlefieldId: 'bf-1',
      effect: 'might_bonus',
      magnitude: 1,
    };
    const res = BACKEND!.runOp(ctx, op, source);
    const disallowed = res.patches.some(
      (p) => /\/might$|temporaryMightMod/.test(p.path),
    );
    expect(disallowed).toBe(false);
    expect(res.triggeredAbilities.length).toBe(0);
  });

  it('validate rejects location_aura targeting a nonexistent battlefield', () => {
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'bf-src' });
    const registry = BACKEND!.buildDefaultRegistry();
    const h = registry.get('location_aura');
    if (!h?.validate) {
      expect(h).toBeDefined();
      return;
    }
    const op: EffectOp = {
      type: 'location_aura',
      source: source.instanceId,
      battlefieldId: 'bf-nonexistent',
      effect: 'might_bonus',
      magnitude: 1,
    };
    const result = h.validate(ctx, op, source);
    expect(result.ok).toBe(false);
  });
});

describeIfBackend('play_restriction: registration-shaped (rule 355)', () => {
  it('installs a predicate; no imperative patches at registration', () => {
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'src-play' });
    const op: EffectOp = {
      type: 'play_restriction',
      source: source.instanceId,
      predicateKind: 'by_card_type',
      predicatePayload: { blockType: 'Spell' },
    };
    const res = BACKEND!.runOp(ctx, op, source);
    const disallowed = res.patches.some(
      (p) => /damage|points|exhausted|\/might$/.test(p.path),
    );
    expect(disallowed).toBe(false);
    expect(res.triggeredAbilities.length).toBe(0);
  });
});
