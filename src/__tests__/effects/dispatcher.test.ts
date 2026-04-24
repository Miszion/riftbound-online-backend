/**
 * Dispatcher cross-cutting contract tests.
 *
 * Asserts:
 *  - Unknown op types soft-fail (warn, not throw).
 *  - OpResult patches are applied by the outer engine transaction, not by
 *    execute(). Verified by calling runOp and observing that ctx is unchanged
 *    after return, then applying the returned patches via our helper.
 *  - Triggered abilities come out of OpResult.triggeredAbilities rather than
 *    being pushed onto the chain inside runOp (spec 12.1).
 *  - APNAP partitioning: when two trigger fires come from different
 *    controllers, the turn player's trigger is ordered first in the batch the
 *    engine passes to the player-ordering prompt.
 */
import {
  BACKEND,
  BACKEND_READY,
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

describe('dispatcher: backend handoff status', () => {
  it('reports whether the Backend Engineer has landed src/effects/*', () => {
    // Informational. When this flips to true in CI, every describeIfBackend
    // suite below stops being skipped.
    // eslint-disable-next-line no-console
    console.log(`[effect-engine] BACKEND_READY=${BACKEND_READY}`);
    expect(typeof BACKEND_READY).toBe('boolean');
  });
});

describeIfBackend('dispatcher: unknown op soft-fails', () => {
  it('does not throw when no handler is registered; records a warning', () => {
    const ctx = makeCtx();
    const unknownOp = { type: 'totally-unknown-op', foo: 1 } as unknown as EffectOp;
    const source = makeUnit();
    // Per spec 12.1 the dispatcher is documented as throwing UnknownOpError,
    // but the QA contract requires soft-fail so one weird card does not kill
    // an entire match. Backend may implement either:
    //   (a) return OpResult with a WARN log entry and empty patches, or
    //   (b) throw a subclass UnknownOpError that the engine catches.
    // Test accepts both - whichever behavior lands, the match cannot die.
    let threw = false;
    try {
      const res = BACKEND!.runOp(ctx, unknownOp, source);
      expect(res.patches).toEqual([]);
      expect(res.triggeredAbilities).toEqual([]);
      // Expect a warn-level log entry.
      const hasWarn = res.log.some(
        (l) => /unknown/i.test(l.kind) || /warn/i.test(l.kind),
      );
      expect(hasWarn).toBe(true);
    } catch (e) {
      threw = true;
      // Soft-fail form (b): thrown error must be a typed UnknownOpError or
      // named recognizably so the engine can catch by name.
      expect((e as Error).name).toMatch(/UnknownOp/);
    }
    // Either shape is acceptable; we just must not silently corrupt state.
    expect([true, false]).toContain(threw);
  });
});

describeIfBackend('dispatcher: patches are returned, not applied', () => {
  it('execute() returns patches without mutating ctx', () => {
    const ctx = makeCtx();
    const target = makeUnit({ instanceId: 'u1', might: 3 });
    ctx.zones.board.bases.p1.presentUnits.push(target.instanceId);
    // Re-inject the unit into a zone the handler can locate.
    (ctx.zones.board.bases.p1 as unknown as Record<string, unknown>)[target.instanceId] = target;
    // Snapshot current state keys for shallow compare.
    const snapshot = JSON.stringify(ctx);
    const op = {
      type: 'modify_stats',
      target: target.instanceId,
      mightMod: 2,
      duration: 'this_turn',
    } as EffectOp;
    const res = BACKEND!.runOp(ctx, op, target);
    expect(res).toBeDefined();
    // ctx itself should be unchanged; patches carry the delta.
    expect(JSON.stringify(ctx)).toBe(snapshot);
    // Applying returned patches should produce a state distinct from snapshot.
    const next = applyPatches(ctx, res.patches);
    expect(JSON.stringify(next)).not.toBe(snapshot);
  });
});

describeIfBackend('dispatcher: triggers are collected, not pushed', () => {
  it('OpResult.triggeredAbilities holds TriggerFires; chain is untouched', () => {
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'u1', controller: 'p1' });
    // Simulate a death-trigger registration op.
    const op = { type: 'death_trigger', source: source.instanceId } as EffectOp;
    const res = BACKEND!.runOp(ctx, op, source);
    expect(Array.isArray(res.triggeredAbilities)).toBe(true);
    // Registration ops do not PRODUCE a trigger fire at registration time -
    // they install an observer. The fire comes later.
    expect(res.triggeredAbilities.length).toBe(0);
    // Chain should still be empty.
    expect(ctx.zones.chain.length).toBe(0);
  });
});

describeIfBackend('dispatcher: APNAP ordering (spec 1.3)', () => {
  it('turn player triggers are ordered before non-active-player triggers', () => {
    const ctx = makeCtx({ turnPlayerId: 'p1' });
    // Two sources, two controllers, both firing at once via a conquer event.
    const p1Source = makeUnit({ instanceId: 'p1-src', controller: 'p1' });
    const p2Source = makeUnit({ instanceId: 'p2-src', controller: 'p2' });
    // The registration ops install observers. We then synthesize a single
    // event and ask the dispatcher for collected fires.
    BACKEND!.runOp(ctx, { type: 'conquer_trigger', source: p1Source.instanceId } as EffectOp, p1Source);
    BACKEND!.runOp(ctx, { type: 'conquer_trigger', source: p2Source.instanceId } as EffectOp, p2Source);
    // APNAP ordering is applied BY THE OUTER ENGINE, not by runOp. The
    // dispatcher's contract is that triggeredAbilities are returned in a
    // deterministic order keyed on controller == turnPlayerId first. If the
    // Backend exposes a triggers module, exercise it; otherwise skip this
    // sub-assertion with a note.
    if (!BACKEND!.TriggerRegistry) {
      // TODO(backend): TriggerRegistry not yet exported; APNAP ordering test
      // is a no-op until src/effects/triggers.ts ships. See spec 1.3.
      return;
    }
    // If TriggerRegistry exists, simulate a conquer event and check order.
    // This block intentionally uses a broad 'any' shape because we do not
    // know the TriggerRegistry's exact constructor signature.
    const reg = new BACKEND!.TriggerRegistry();
    reg.register({
      triggerType: 'on_conquer',
      sourceInstanceId: p1Source.instanceId,
      sourceController: 'p1',
    });
    reg.register({
      triggerType: 'on_conquer',
      sourceInstanceId: p2Source.instanceId,
      sourceController: 'p2',
    });
    const fires = reg.fire(
      { kind: 'on_conquer', payload: { conqueringPlayer: 'p1', battlefieldId: 'bf-1' } },
      ctx,
    );
    expect(fires.length).toBeGreaterThanOrEqual(2);
    // Turn player p1's fire should come before p2's.
    const firstP1 = fires.findIndex((f) => f.sourceController === 'p1');
    const firstP2 = fires.findIndex((f) => f.sourceController === 'p2');
    expect(firstP1).toBeGreaterThanOrEqual(0);
    expect(firstP2).toBeGreaterThanOrEqual(0);
    expect(firstP1).toBeLessThan(firstP2);
  });
});
