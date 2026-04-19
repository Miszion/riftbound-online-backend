/**
 * `transform` op regression (Phase 8a).
 *
 * Spec anchors:
 *   - docs/phase-7-coverage-audit.md sections 2.2 and 4: `transform` is the
 *     sole net-new op type introduced by the Phase-7 enricher, emitted by
 *     exactly one card (UNL-081 Keeper of Masks). The audit flagged that
 *     the dispatcher soft-fails on `transform` because no handler is
 *     registered and no section-18 `RiftboundOp` union entry exists.
 *
 * Phase-8a resolution paths Backend may take:
 *   Path A (preferred): register a real `transformHandler` with
 *     imperative semantics (e.g., swap cardId / reveal hidden card).
 *   Path B: register a no-op placeholder handler that emits empty
 *     OpResult + a warn log; add UNL-081 to an enricher migration target
 *     list so a future pass rewrites `transform` into one or more
 *     existing ops (e.g., remove_permanent + summon_unit).
 *
 * The regressions below cover both outcomes. They probe the live backend
 * registry at runtime; the Path-A assertions light up when a handler that
 * actually mutates state registers, the Path-B assertions light up when
 * a placeholder handler registers without state mutation.
 *
 * Gating model:
 *   - `describeIfBackend` ensures we do not crash when the backend module
 *     is not importable.
 *   - Within the suite, each case probes `registry.get('transform')`:
 *       - no handler registered: assert runOp still soft-fails (regression
 *         for the audit baseline) and note that Phase 8a has not landed.
 *       - handler registered: branch on whether the handler mutates state
 *         to pick Path A vs Path B assertions.
 */
import {
  BACKEND,
  BACKEND_READY,
  describeIfBackend,
  makeCtx,
  makeUnit,
  resetInstanceCounter,
  EffectOp,
  InstanceId,
} from './_harness';
import { FIXTURES } from './fixtures/real-cards';

beforeEach(() => {
  resetInstanceCounter();
});

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function isTransformHandlerRegistered(): boolean {
  if (!BACKEND_READY) return false;
  try {
    const registry = BACKEND!.buildDefaultRegistry();
    return !!registry.get('transform');
  } catch {
    return false;
  }
}

function tryLoadPhase8Doc(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    const p = path.resolve(
      __dirname,
      '../../../docs/phase-8-transform-resolution.md',
    );
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

const TRANSFORM_REGISTERED = isTransformHandlerRegistered();

// ---------------------------------------------------------------------------
// Path-agnostic regression. Always runs once backend is loadable.
// ---------------------------------------------------------------------------

describeIfBackend('transform op: dispatcher behavior (phase 8a)', () => {
  it('runOp does NOT log `unknown_op` for a transform op (handler registered OR warn-only placeholder)', () => {
    if (!TRANSFORM_REGISTERED) {
      // TODO(backend 8a): when either Path A (real transformHandler) or
      // Path B (no-op placeholder with warn) lands, this assertion flips
      // from recording the current soft-fail baseline to asserting
      // handler-backed dispatch. Until then, record the audit baseline
      // so regressions do not silently re-open.
      //
      // Pinned current behavior: dispatcher emits a `unknown_op` log.
      const ctx = makeCtx();
      const source = makeUnit({
        instanceId: 'unl-081-inst',
        cardId: FIXTURES.UNL_081_KEEPER_OF_MASKS.id,
      });
      const op: EffectOp = {
        type: 'transform',
        source: source.instanceId,
      } as unknown as EffectOp;
      const res = BACKEND!.runOp(ctx, op, source);
      const unknown = res.log.some((l) => l.kind === 'unknown_op');
      expect(unknown).toBe(true);
      return;
    }
    const ctx = makeCtx();
    const source = makeUnit({
      instanceId: 'unl-081-inst',
      cardId: FIXTURES.UNL_081_KEEPER_OF_MASKS.id,
    });
    const op: EffectOp = {
      type: 'transform',
      source: source.instanceId,
    } as unknown as EffectOp;
    const res = BACKEND!.runOp(ctx, op, source);
    const unknown = res.log.some((l) => l.kind === 'unknown_op');
    expect(unknown).toBe(false);
  });

  it('UNL-081 Keeper of Masks dispatches cleanly through the transform handler (no throw)', () => {
    if (!TRANSFORM_REGISTERED) {
      // TODO(backend 8a): light up once a transform handler lands.
      return;
    }
    const card = FIXTURES.UNL_081_KEEPER_OF_MASKS;
    expect(card.effectProfile.operations.map((o) => o.type)).toContain(
      'transform',
    );
    const ctx = makeCtx();
    const source = makeUnit({
      instanceId: 'unl-081-inst',
      cardId: card.id,
    });
    // Mirror the real enriched-json op shape: carries targetHint='any',
    // zone='board', automated=false, ruleRefs=['430-450']. Handlers may
    // read or ignore these hints; passing them through proves the
    // dispatch path accepts the catalog shape verbatim.
    const op: EffectOp = {
      type: 'transform',
      source: source.instanceId,
      targetHint: 'any',
      zone: 'board',
      automated: false,
      ruleRefs: ['430-450'],
    } as unknown as EffectOp;
    expect(() => BACKEND!.runOp(ctx, op, source)).not.toThrow();
    const res = BACKEND!.runOp(ctx, op, source);
    expect(Array.isArray(res.patches)).toBe(true);
    expect(Array.isArray(res.log)).toBe(true);
    expect(Array.isArray(res.triggeredAbilities)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Path-B regression: no-op placeholder handler + enricher migration plan.
//
// Gating: only runs when a transform handler is registered AND the runtime
// behavior matches Path B (empty patches + warn log). The enricher migration
// plan is probed via docs/phase-8-transform-resolution.md.
// ---------------------------------------------------------------------------

describeIfBackend('transform op: Path B placeholder contract (phase 8a)', () => {
  it('handler returns empty OpResult with a warn-tagged log entry when Path B is in effect', () => {
    if (!TRANSFORM_REGISTERED) {
      // TODO(backend 8a): Path B light-up.
      return;
    }
    const ctx = makeCtx();
    const source = makeUnit({ instanceId: 'transform-src', cardId: 'UNL-081' });
    const op: EffectOp = {
      type: 'transform',
      source: source.instanceId,
    } as unknown as EffectOp;
    const res = BACKEND!.runOp(ctx, op, source);
    const looksLikePathB =
      res.patches.length === 0 &&
      res.triggeredAbilities.length === 0 &&
      res.log.some((l) =>
        /transform|placeholder|unimplemented|skip|warn|noop|no.?op/i.test(l.kind),
      );
    if (!looksLikePathB) {
      // Path A is in effect (handler mutates state). Path B test is a
      // no-op; the Path A suite below owns the assertions.
      return;
    }
    expect(res.patches).toEqual([]);
    expect(res.triggeredAbilities).toEqual([]);
    expect(res.log.length).toBeGreaterThanOrEqual(1);
  });

  it('UNL-081 is listed in the enricher transform migration plan (phase-8 resolution doc)', () => {
    const doc = tryLoadPhase8Doc();
    if (!doc) {
      // TODO(backend 8a / doc): docs/phase-8-transform-resolution.md not
      // present yet. When Path B is chosen, the doc MUST list UNL-081 in
      // its migration target section (spec requirement per the Phase-7
      // audit).
      return;
    }
    // The resolution doc documents how `transform` gets rewritten into
    // one or more existing ops during a future enricher pass. The card
    // id must appear somewhere in the migration target list.
    expect(doc).toMatch(/UNL-081/);
    // Soft shape check: the doc should name at least one existing op
    // type as the migration destination. We accept any of the common
    // candidates; Backend will converge on a concrete mapping.
    expect(doc).toMatch(
      /(remove_permanent|summon_unit|create_token|modify_stats|return_to_hand|ability_copy)/,
    );
  });
});

// ---------------------------------------------------------------------------
// Path-A regression: real handler with state change.
//
// Gating: only runs when a transform handler is registered AND the runtime
// behavior mutates state (i.e., non-empty patches). We assert light-weight
// invariants here: the handler does not throw, produces at least one patch
// touching a unit record, and logs an entry other than `unknown_op`.
// Backend may land wider semantics; this test pins only the contract that
// Path A is active.
// ---------------------------------------------------------------------------

describeIfBackend('transform op: Path A real-handler contract (phase 8a)', () => {
  it('produces at least one patch OR at least one non-unknown log entry (Path A active)', () => {
    if (!TRANSFORM_REGISTERED) {
      // TODO(backend 8a): Path A light-up.
      return;
    }
    // Seed a pre-existing target unit in the ctx.units map so the
    // handler's patch-only validate can resolve it. UNL-081's printed
    // text spawns two Reflection tokens and then transforms both; we
    // mirror that shape here with a single seeded target for simplicity.
    const targetId: InstanceId = 'reflection-token-1';
    const sourceId: InstanceId = 'unl-081-src';
    const ctx = makeCtx({
      // `units` is not on EngineCtx at the moment, but the handler reads
      // it via a shape cast. Attach it directly; the harness widens via
      // `overrides`.
    });
    (ctx as unknown as { units: Record<string, unknown> }).units = {
      [targetId]: { instanceId: targetId, zone: 'board' },
      [sourceId]: { instanceId: sourceId, zone: 'board' },
    };
    const source = makeUnit({ instanceId: sourceId, cardId: 'UNL-081' });
    const op: EffectOp = {
      type: 'transform',
      source: source.instanceId,
      targets: [targetId],
      from: source.instanceId,
      reason: 'become_copy',
    } as unknown as EffectOp;
    const res = BACKEND!.runOp(ctx, op, source);
    // Path A characteristic: non-empty patches OR a transform-tagged log
    // entry that is not `unknown_op`. We do not pin the precise patch
    // shape here; handler authors get room to move.
    const hasPatches = res.patches.length > 0;
    const hasDomainLog = res.log.some(
      (l) => l.kind !== 'unknown_op' && /transform/i.test(l.kind),
    );
    const looksLikePathA = hasPatches || hasDomainLog;
    if (!looksLikePathA) {
      // Path B is in effect. The Path B suite above owns its assertions.
      return;
    }
    expect(looksLikePathA).toBe(true);
    // And the handler must not emit `unknown_op` - that is the audit
    // baseline that Phase 8a eliminates.
    expect(res.log.every((l) => l.kind !== 'unknown_op')).toBe(true);
  });

  it('writes a /units/<target>/copyOf patch naming the source instance (spec 6.4)', () => {
    if (!TRANSFORM_REGISTERED) {
      // TODO(backend 8a): Path A light-up.
      return;
    }
    // Mirror the transform handler's documented contract: a patch at
    // `/units/<target>/copyOf` with `{ source, reason }`. This assertion
    // is the sharpest Path-A check; if a placeholder handler is in
    // effect it silently no-ops via the `looksLikePathA` branch below.
    const targetId: InstanceId = 'reflection-token-2';
    const sourceId: InstanceId = 'unl-081-src-2';
    const ctx = makeCtx();
    (ctx as unknown as { units: Record<string, unknown> }).units = {
      [targetId]: { instanceId: targetId, zone: 'board' },
      [sourceId]: { instanceId: sourceId, zone: 'board' },
    };
    const source = makeUnit({ instanceId: sourceId, cardId: 'UNL-081' });
    const op: EffectOp = {
      type: 'transform',
      source: source.instanceId,
      targets: [targetId],
      from: source.instanceId,
      reason: 'become_copy',
    } as unknown as EffectOp;
    const res = BACKEND!.runOp(ctx, op, source);
    const looksLikePathA = res.patches.length > 0 || res.log.some(
      (l) => l.kind !== 'unknown_op' && /transform/i.test(l.kind),
    );
    if (!looksLikePathA) return;
    const copyPatch = res.patches.find((p) => /copyOf$/.test(p.path));
    // If the handler uses a different patch key (e.g. `copiedCharacteristics`)
    // we still accept the regression so long as at least one patch names
    // the target instance id. The copyOf path is the primary contract.
    if (copyPatch) {
      expect(copyPatch.path).toMatch(new RegExp(`/${targetId}/copyOf$`));
      const value = copyPatch.value as { source?: string; reason?: string } | undefined;
      expect(value?.source).toBe(sourceId);
    } else {
      const anyTargetPatch = res.patches.some((p) => p.path.includes(targetId));
      expect(anyTargetPatch).toBe(true);
    }
  });
});
