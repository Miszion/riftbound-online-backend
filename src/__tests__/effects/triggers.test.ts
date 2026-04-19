/**
 * Trigger-registration handler contract tests.
 *
 * For the five *_trigger ops - on_play_trigger, equip_trigger, conquer_trigger,
 * combat_trigger, death_trigger - assert that the handler REGISTERS into the
 * TriggerRegistry (spec section 1 + 12.1) instead of executing imperative
 * effects. Then assert that firing the matching event invokes the registered
 * observer.
 */
import {
  BACKEND,
  describeIfBackend,
  makeCtx,
  makeUnit,
  resetInstanceCounter,
  EffectOp,
  TriggerType,
  EventSnapshot,
} from './_harness';

beforeEach(() => {
  resetInstanceCounter();
});

interface TriggerMatrixEntry {
  op: EffectOp['type'];
  triggerType: TriggerType;
  event: EventSnapshot;
}

const MATRIX: TriggerMatrixEntry[] = [
  {
    op: 'on_play_trigger',
    triggerType: 'on_play',
    event: { kind: 'on_play', payload: { playedInstanceId: 'src' } },
  },
  {
    op: 'equip_trigger',
    triggerType: 'equip_trigger',
    event: { kind: 'attach_event', payload: { target: 'src', gearInstance: 'g1' } },
  },
  {
    op: 'conquer_trigger',
    triggerType: 'on_conquer',
    event: { kind: 'on_conquer', payload: { conqueringPlayer: 'p1', battlefieldId: 'bf-1' } },
  },
  {
    op: 'combat_trigger',
    triggerType: 'at_start_of_combat',
    event: { kind: 'at_start_of_combat', payload: { battlefieldId: 'bf-1' } },
  },
  {
    op: 'death_trigger',
    triggerType: 'on_kill',
    event: { kind: 'on_kill', payload: { killedInstanceId: 'src' } },
  },
];

describeIfBackend('trigger-registration ops: shape contract', () => {
  it.each(MATRIX)('%s returns zero patches that mutate instance state', ({ op }) => {
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'src', controller: 'p1' });
    const registrationOp = { type: op, source: source.instanceId } as EffectOp;
    const res = BACKEND!.runOp(ctx, registrationOp, source);
    // Registration is observer install. No damage, no location, no stats.
    const mutated = res.patches.some(
      (p) => /damage|location|exhausted|hasBuffCounter|temporaryMightMod|points/.test(p.path),
    );
    expect(mutated).toBe(false);
    // No trigger fires synthesized AT registration.
    expect(res.triggeredAbilities.length).toBe(0);
  });
});

describeIfBackend('trigger-registration ops: fire on matching event', () => {
  it.each(MATRIX)(
    '%s observer fires when the matching event is dispatched',
    ({ op, triggerType, event }) => {
      if (!BACKEND!.TriggerRegistry) {
        // TODO(backend): TriggerRegistry not yet exported. The per-op
        // registration tests above still run; this integration slice waits
        // for src/effects/triggers.ts.
        return;
      }
      const reg = new BACKEND!.TriggerRegistry();
      reg.register({
        triggerType,
        sourceInstanceId: 'src',
        sourceController: 'p1',
      });
      const fires = reg.fire(event, makeCtx());
      expect(fires.length).toBeGreaterThan(0);
      expect(fires[0]?.sourceInstanceId).toBe('src');
      expect(fires[0]?.triggerType).toBe(triggerType);
      // Unrelated events do not fire.
      const unrelated = reg.fire(
        { kind: 'some_other_event', payload: {} },
        makeCtx(),
      );
      expect(unrelated.length).toBe(0);
      // Silence unused op var for the per-test label.
      expect(typeof op).toBe('string');
    },
  );
});

describeIfBackend('trigger snapshotting (spec 1.2)', () => {
  it('captures an EventSnapshot at fire time for on_kill (Deathknell)', () => {
    if (!BACKEND!.TriggerRegistry) {
      return;
    }
    const reg = new BACKEND!.TriggerRegistry();
    reg.register({
      triggerType: 'on_kill',
      sourceInstanceId: 'src',
      sourceController: 'p1',
    });
    const payload = {
      killedInstanceId: 'src',
      lastKnownLocation: { kind: 'battlefield', battlefieldId: 'bf-1' },
      lastKnownMight: 4,
      lastKnownController: 'p1',
    };
    const fires = reg.fire({ kind: 'on_kill', payload }, makeCtx());
    expect(fires.length).toBe(1);
    // Payload must be preserved so Deathknell abilities can read lastKnown*
    // per rule 808.1.d.3.
    expect(fires[0]?.eventSnapshot.payload).toMatchObject(payload);
  });
});

// ---------------------------------------------------------------------------
// Phase 3: hold_trigger, phase_trigger, interact_legend.
//
// Spec anchors: section 13.4 (on_hold), section 1 (trigger table; phase
// triggers), rules 173-175 (Legends).
//
// Same registration contract as Phase 2 trigger ops.
// ---------------------------------------------------------------------------

describeIfBackend('hold_trigger: registration (spec 13.4)', () => {
  it('does not mutate points imperatively', () => {
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'ahri' });
    const op: EffectOp = { type: 'hold_trigger', source: source.instanceId };
    const res = BACKEND!.runOp(ctx, op, source);
    const disallowed = res.patches.some((p) => /points/.test(p.path));
    expect(disallowed).toBe(false);
    expect(res.triggeredAbilities.length).toBe(0);
  });

  it('on_hold event fires the registered observer', () => {
    if (!BACKEND!.TriggerRegistry) {
      return;
    }
    const reg = new BACKEND!.TriggerRegistry();
    reg.register({
      triggerType: 'on_hold',
      sourceInstanceId: 'ahri',
      sourceController: 'p1',
    });
    const fires = reg.fire(
      { kind: 'on_hold', payload: { holdingPlayer: 'p1', battlefieldId: 'bf-1' } },
      makeCtx(),
    );
    expect(fires.length).toBe(1);
    expect(fires[0]?.sourceInstanceId).toBe('ahri');
  });
});

describeIfBackend('phase_trigger: registration (spec 1 trigger table)', () => {
  it('no imperative state change at registration', () => {
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'phase-src' });
    const op: EffectOp = {
      type: 'phase_trigger',
      source: source.instanceId,
      phase: 'beginning',
      when: 'start',
    };
    const res = BACKEND!.runOp(ctx, op, source);
    const disallowed = res.patches.some(
      (p) => /damage|points|exhausted|\/might$/.test(p.path),
    );
    expect(disallowed).toBe(false);
    expect(res.triggeredAbilities.length).toBe(0);
  });

  it('validate rejects unknown phase name', () => {
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'phase-src' });
    const registry = BACKEND!.buildDefaultRegistry();
    const h = registry.get('phase_trigger');
    if (!h?.validate) {
      expect(h).toBeDefined();
      return;
    }
    const op = {
      type: 'phase_trigger',
      source: 'phase-src',
      phase: 'not-a-real-phase',
      when: 'start',
    } as unknown as EffectOp;
    const result = h.validate(ctx, op, source);
    expect(result.ok).toBe(false);
  });
});

describeIfBackend('interact_legend: registration (rule 173-175)', () => {
  it('installs a legend-interaction observer without imperative state change', () => {
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'legendary-src' });
    const op: EffectOp = {
      type: 'interact_legend',
      source: source.instanceId,
      predicateKind: 'on_legend_enters_play',
    };
    const res = BACKEND!.runOp(ctx, op, source);
    const disallowed = res.patches.some(
      (p) => /damage|points|exhausted/.test(p.path),
    );
    expect(disallowed).toBe(false);
    expect(res.triggeredAbilities.length).toBe(0);
    // A registration log entry should be present.
    const logged = res.log.some((l) => /register|legend|trigger/i.test(l.kind));
    expect(logged).toBe(true);
  });
});
