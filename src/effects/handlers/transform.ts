import logger from '../../logger';
import type {
  EngineCtx,
  InstanceId,
  OpHandler,
  OpResult,
  Patch,
  ValidationResult
} from '../types';
import { emptyResult } from '../types';

/**
 * transform - "become a copy of" op (spec section 6.4).
 *
 * Riftbound's core rules doc does not define a formal "transform" action;
 * the only printed mechanic in the current enriched catalog that maps to
 * this op is UNL-081 "Keeper of Masks" clause 2 ("They become copies of
 * me."). The Phase-7 op-frequency audit flagged transform (count=1) as a
 * new op type not yet in buildDefaultRegistry(). See
 * docs/effect-ops-frequency-phase7.csv line 56.
 *
 * The one concrete semantic we can derive from the card pool is the
 * "token copy of real card" snapshot discussed in the effect spec at
 * section 6.4 ("Tokens copying real cards"): one or more target units
 * snapshot the public characteristics of a source unit at patch time.
 * Copies do not inherit damage, buffs, attachments, or granted temporary
 * keywords (rule 110); the engine applies that filter when it computes
 * effective characteristics from the copyOf descriptor.
 *
 * This handler is intentionally narrow. If a future card prints a richer
 * transform mechanic (e.g. face-flip, alt-form on cost, unit-into-gear),
 * extend the op union rather than overloading this handler.
 *
 * TODO (ambiguity flag): UNL-081 is the only printed instance and the
 * enricher emits transform alongside a spurious remove_permanent; the
 * Phase-8b enricher-pipeline agent is revisiting the upstream mapping.
 * If that work reduces transform back to a pure create_token-with-copyOf,
 * this handler remains as defense-in-depth (same thinking as
 * runeResourceHandler at 0 cards per Phase-7).
 */

interface TransformOp {
  type: 'transform';
  /**
   * Instance that receives the new form. When a card text reads "they
   * become copies of me", each newly spawned token is a separate `to`
   * target dispatched once per token. If omitted, validate fails.
   */
  to?: InstanceId;
  /**
   * Optional: multiple simultaneous targets (e.g. both Reflection tokens
   * from UNL-081). If provided, `to` is ignored.
   */
  targets?: InstanceId[];
  /**
   * Instance whose public characteristics are snapshotted onto each
   * target. Defaults to the source instance (UNL-081 self-copy pattern).
   */
  from?: InstanceId;
  /**
   * Template identifier when the copy source is not an on-board instance
   * but a card template (reserved for future cards; unused by UNL-081).
   */
  fromTemplate?: string;
  /**
   * Reason tag for replay / rules attribution. Defaults to 'become_copy'.
   */
  reason?: 'become_copy' | 'face_flip' | 'alt_form';
}

interface TransformCtxUnit {
  instanceId: string;
  zone?: string;
  copyOf?: { source: string; reason: string };
  [k: string]: unknown;
}

interface TransformCtxShape {
  units?: Record<string, TransformCtxUnit>;
}

function resolveTargets(op: TransformOp): InstanceId[] {
  if (Array.isArray(op.targets) && op.targets.length > 0) {
    return op.targets.filter((t): t is InstanceId => Boolean(t));
  }
  if (op.to) return [op.to];
  return [];
}

function resolveSourceInstance(
  op: TransformOp,
  source: { instanceId?: string; id?: string } | undefined
): string | undefined {
  return (
    op.from ?? source?.instanceId ?? (source?.id as string | undefined)
  );
}

/**
 * transform - spec section 6.4 "tokens copying real cards".
 *
 * Validate:
 *  - At least one target must be resolvable.
 *  - A copy source must be resolvable (either `from` or `fromTemplate`,
 *    falling back to the dispatch source).
 *  - In patch-only mode, each target must already exist on the board
 *    (self-transform of a nonexistent unit is illegal per spec 6.4).
 *
 * Execute:
 *  - Emits one `replace`/`add` patch per target writing a `copyOf`
 *    descriptor under `/units/<id>/copyOf`. The engine's characteristic
 *    pipeline reads this descriptor when resolving might, keywords, and
 *    abilities (rule 110 strip is applied there, not here).
 *  - Does NOT fire on-leave triggers of the prior form: the only printed
 *    case (UNL-081) targets freshly spawned tokens that have no prior
 *    form to leave. When a richer face-flip mechanic lands, the trigger
 *    fan-out moves into this handler's OpResult.triggeredAbilities.
 */
export const transformHandler: OpHandler<{ type: 'transform' }> = {
  op: 'transform',
  validate(ctx: EngineCtx, _op, source): ValidationResult {
    const op = _op as unknown as TransformOp;
    const targets = resolveTargets(op);
    if (targets.length === 0) {
      return { ok: false, reason: 'transform_missing_target' };
    }
    const copySource = resolveSourceInstance(
      op,
      source as unknown as { instanceId?: string; id?: string }
    );
    if (!copySource && !op.fromTemplate) {
      return { ok: false, reason: 'transform_missing_source' };
    }
    // Engine adapter path: the engine owns board-state validation.
    if (ctx.engine && typeof ctx.engine.findCardInstance === 'function') {
      for (const t of targets) {
        const inst = ctx.engine.findCardInstance(t);
        if (!inst) {
          return { ok: false, reason: 'transform_target_not_on_board' };
        }
      }
      return { ok: true };
    }
    // Patch-only path: check the ctx shape.
    const shape = ctx as unknown as TransformCtxShape;
    for (const t of targets) {
      if (!shape.units?.[t]) {
        return { ok: false, reason: 'transform_target_not_on_board' };
      }
    }
    return { ok: true };
  },
  execute(ctx: EngineCtx, _op, source): OpResult {
    const op = _op as unknown as TransformOp;
    const targets = resolveTargets(op);
    if (targets.length === 0) {
      logger.warn('[effects] transform_no_target', {
        sourceCardId: (source as unknown as { id?: string } | undefined)?.id,
        event: 'TRANSFORM_NO_TARGET'
      });
      return emptyResult();
    }
    const copySource =
      resolveSourceInstance(
        op,
        source as unknown as { instanceId?: string; id?: string }
      ) ?? op.fromTemplate;
    if (!copySource) {
      logger.warn('[effects] transform_no_source', {
        event: 'TRANSFORM_NO_SOURCE'
      });
      return emptyResult();
    }

    const reason = op.reason ?? 'become_copy';
    const patches: Patch[] = [];
    const log: OpResult['log'] = [];
    const shape = ctx as unknown as TransformCtxShape;

    for (const targetId of targets) {
      if (targetId === copySource) {
        // Self-copy is a no-op per rule 110 snapshot semantics: the unit
        // is already itself. Log a diagnostic so replay can reconstruct
        // intent without producing a phantom patch.
        log.push({
          tick: 0,
          kind: 'transform_self_copy_noop',
          payload: { target: targetId, source: copySource, reason }
        });
        continue;
      }
      const existing = shape.units?.[targetId]?.copyOf;
      const verb: 'add' | 'replace' = existing ? 'replace' : 'add';
      patches.push({
        op: verb,
        path: `/units/${targetId}/copyOf`,
        value: { source: copySource, reason }
      });
      log.push({
        tick: 0,
        kind: 'transform_applied',
        payload: { target: targetId, source: copySource, reason }
      });
    }

    return { patches, triggeredAbilities: [], log };
  }
};
