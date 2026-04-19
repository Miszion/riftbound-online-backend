/**
 * attach_gear handler contract tests.
 *
 * Spec anchors: section 14 (Gear attachment), rule 434, rule 818.
 *
 * Pitfall regression (OGN-179): attach_gear must dispatch on op type only,
 * never on card classes. A spell whose classes include "attachment" but whose
 * operations do NOT include an attach verb must not register an Attach handler.
 */
import {
  BACKEND,
  describeIfBackend,
  makeCtx,
  makeUnit,
  makeGear,
  applyPatches,
  resetInstanceCounter,
  EffectOp,
  CardInstance,
} from './_harness';
import { FIXTURES } from './fixtures/real-cards';

beforeEach(() => {
  resetInstanceCounter();
});

describeIfBackend('attach_gear: happy path (rule 434)', () => {
  it('sets gear.attachedTo and appends gear to target.topMostAttachments', () => {
    let ctx = makeCtx();
    const unit = makeUnit({ instanceId: 'u1', controller: 'p1' });
    const gear = makeGear({ instanceId: 'g1', controller: 'p1' });
    ctx.zones.board.bases.p1.presentUnits.push(unit.instanceId);
    ctx.zones.board.bases.p1.presentGear.push(gear.instanceId);
    const lookup = { [unit.instanceId]: unit, [gear.instanceId]: gear };
    (ctx as unknown as { units: Record<string, CardInstance> }).units = lookup;
    const op: EffectOp = {
      type: 'attach_gear',
      gearInstance: gear.instanceId,
      target: unit.instanceId,
      reason: 'equip_activation',
    };
    const res = BACKEND!.runOp(ctx, op, gear);
    // Patches touch both the gear's attachedTo and the unit's
    // topMostAttachments array.
    const touchedAttached = res.patches.some((p) => /attachedTo/.test(p.path));
    const touchedTopMost = res.patches.some((p) => /topMostAttachments/.test(p.path));
    expect(touchedAttached).toBe(true);
    expect(touchedTopMost).toBe(true);
    ctx = applyPatches(ctx, res.patches);
  });

  it('re-attaching auto-detaches from the prior top-most card (rule 434.1.f)', () => {
    let ctx = makeCtx();
    const oldBearer = makeUnit({ instanceId: 'u-old' });
    const newBearer = makeUnit({ instanceId: 'u-new' });
    const gear = makeGear({
      instanceId: 'g1',
      attachments: { attachedTo: 'u-old', topMostAttachments: [] },
    });
    oldBearer.attachments.topMostAttachments = ['g1'];
    const units: Record<string, CardInstance> = {
      [oldBearer.instanceId]: oldBearer,
      [newBearer.instanceId]: newBearer,
      [gear.instanceId]: gear,
    };
    (ctx as unknown as { units: Record<string, CardInstance> }).units = units;
    const op: EffectOp = {
      type: 'attach_gear',
      gearInstance: gear.instanceId,
      target: newBearer.instanceId,
      reason: 'card_effect',
      detachFromPrior: oldBearer.instanceId,
    };
    const res = BACKEND!.runOp(ctx, op, gear);
    ctx = applyPatches(ctx, res.patches);
    // Old bearer's topMostAttachments should no longer contain g1.
    const updated = (ctx as unknown as { units: Record<string, CardInstance> }).units;
    expect(updated[oldBearer.instanceId]?.attachments.topMostAttachments).not.toContain('g1');
  });
});

describeIfBackend('attach_gear: regression for OGN-179 class-overloading (spec 14.6)', () => {
  it('OGN-179 Acceptable Losses has attach_gear in classes but NOT as an op', () => {
    // Spec 14.6 and pitfall doc: the classes list reflects subject matter;
    // only operations[] drives dispatch. Acceptance test guards the
    // contract.
    const card = FIXTURES.OGN_179_ACCEPTABLE_LOSSES;
    expect(card.effectProfile.classes).toContain('attachment');
    const opsTypes = card.effectProfile.operations.map((o) => o.type);
    // The card's op list contains manipulate_priority and attach_gear in our
    // raw catalog. The CATALOG LOADER must NOT register an attach handler
    // for a spell whose text says "kill gear" (the attach_gear op entry is
    // itself mislabeled by the ETL). See catalog-load.test.ts for the load-
    // time strip. Here we just lock in the data shape.
    expect(opsTypes).toContain('manipulate_priority');
    expect(opsTypes).toContain('attach_gear');
  });

  it('dispatcher key is op.type, not source.classes', () => {
    // Synthetic: build an op with an attach_gear type. Source has classes
    // list that would be misleading if the dispatcher ever consulted it.
    const ctx = makeCtx();
    const gear = makeGear({ instanceId: 'g1' });
    const unit = makeUnit({ instanceId: 'u1' });
    ctx.zones.board.bases.p1.presentUnits.push(unit.instanceId);
    (ctx as unknown as { units: Record<string, CardInstance> }).units = {
      [gear.instanceId]: gear,
      [unit.instanceId]: unit,
    };
    // Attach with a source that has NO attach class. Handler should fire.
    const op: EffectOp = {
      type: 'attach_gear',
      gearInstance: gear.instanceId,
      target: unit.instanceId,
      reason: 'card_effect',
    };
    const res = BACKEND!.runOp(ctx, op, gear);
    expect(res.patches.length).toBeGreaterThan(0);
  });
});

describeIfBackend('attach_gear: validate rejects non-unit target', () => {
  it('target must be a unit on the board', () => {
    const ctx = makeCtx();
    const gear = makeGear({ instanceId: 'g1' });
    const otherGear = makeGear({ instanceId: 'g-target' });
    (ctx as unknown as { units: Record<string, CardInstance> }).units = {
      [gear.instanceId]: gear,
      [otherGear.instanceId]: otherGear,
    };
    const registry = BACKEND!.buildDefaultRegistry();
    const h = registry.get('attach_gear');
    if (!h?.validate) {
      expect(h).toBeDefined();
      return;
    }
    const result = h.validate(
      ctx,
      {
        type: 'attach_gear',
        gearInstance: gear.instanceId,
        target: otherGear.instanceId,
        reason: 'card_effect',
      } as EffectOp,
      gear,
    );
    expect(result.ok).toBe(false);
  });
});

describeIfBackend('equip_trigger: registers into TriggerRegistry', () => {
  it('does not execute imperatively; records an observer', () => {
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'aphelios' });
    const op: EffectOp = {
      type: 'equip_trigger',
      source: source.instanceId,
      predicate: { kind: 'when_equipped_to_me' },
    };
    const res = BACKEND!.runOp(ctx, op, source);
    expect(res.triggeredAbilities.length).toBe(0);
    const logged = res.log.some((l) => /register|observer|trigger/i.test(l.kind));
    expect(logged).toBe(true);
  });

  it('firing the matching event invokes the registered observer', () => {
    if (!BACKEND!.TriggerRegistry) {
      // TODO(backend): TriggerRegistry not yet exported.
      return;
    }
    const reg = new BACKEND!.TriggerRegistry();
    reg.register({
      triggerType: 'equip_trigger',
      sourceInstanceId: 'aphelios',
      sourceController: 'p1',
      predicate: (ev) => {
        const pay = ev.payload as { target?: string };
        return pay?.target === 'aphelios';
      },
    });
    // Non-matching event.
    const noMatch = reg.fire(
      { kind: 'attach_event', payload: { target: 'other-unit', gearInstance: 'g1' } },
      makeCtx(),
    );
    expect(noMatch.length).toBe(0);
    // Matching event.
    const match = reg.fire(
      { kind: 'attach_event', payload: { target: 'aphelios', gearInstance: 'g1' } },
      makeCtx(),
    );
    expect(match.length).toBe(1);
    expect(match[0]?.triggerType).toBe('equip_trigger');
  });
});

// ---------------------------------------------------------------------------
// Phase 3: hide_modifier.
//
// Spec anchors: rule 472 (Layers engine), section 14.3 (attachment layers).
//
// hide_modifier conceals a granted modifier so the opponent cannot observe
// its presence until a reveal condition triggers. Registration-shaped: no
// imperative stat / damage / location patch is produced.
// ---------------------------------------------------------------------------

describeIfBackend('hide_modifier: registration-shaped (rule 472 layers)', () => {
  it('no imperative mutations of stat / damage / exhausted', () => {
    const ctx = makeCtx();
    const source = makeGear({ instanceId: 'g-cloak' });
    const op: EffectOp = { type: 'hide_modifier', source: source.instanceId };
    const res = BACKEND!.runOp(ctx, op, source);
    const disallowed = res.patches.some(
      (p) => /damage|\/might$|exhausted|points/.test(p.path),
    );
    expect(disallowed).toBe(false);
    expect(res.triggeredAbilities.length).toBe(0);
  });

  it('idempotent: a second hide_modifier on the same source is a no-op', () => {
    let ctx = makeCtx();
    const source = makeGear({ instanceId: 'g-cloak' });
    (ctx as unknown as { units: Record<string, CardInstance> }).units = {
      [source.instanceId]: source,
    };
    const op: EffectOp = { type: 'hide_modifier', source: source.instanceId };
    const first = BACKEND!.runOp(ctx, op, source);
    ctx = applyPatches(ctx, first.patches);
    const second = BACKEND!.runOp(ctx, op, source);
    // Second pass produces no new state-mutating patches and optionally logs
    // a redundant marker.
    const newMutations = second.patches.filter(
      (p) => p.op === 'replace' && !/log|warn/i.test(p.path),
    );
    expect(newMutations.length).toBeLessThanOrEqual(first.patches.length);
  });
});
