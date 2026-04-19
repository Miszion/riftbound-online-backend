import logger from '../../logger';
import type {
  EngineCtx,
  OpHandler,
  OpResult,
  Patch
} from '../types';
import { emptyResult } from '../types';

/**
 * generic - catch-all for cards whose effects the enricher could not
 * reduce to a typed op. Current fall-throughs in cards.enriched.json:
 *   - OGN-029 Falling Star
 *   - OGN-248 (short-ops card)
 *   - OGN-105
 *   - SFD-107
 * Each of these has bespoke text that would require per-card shims. Per
 * the Tech Lead note: emit a GENERIC_OP_SKIPPED warn and move on. If a
 * card needs real behavior later, carve it out of `generic` into its
 * own op type.
 */

const GENERIC_KNOWN_CARDS = new Set<string>(['OGN-029', 'OGN-248', 'OGN-105', 'SFD-107']);

export const genericHandler: OpHandler<{ type: 'generic' }> = {
  op: 'generic',
  execute(_ctx: EngineCtx, _op, source): OpResult {
    const sourceCardId = (source as unknown as { id?: string })?.id;
    const known = sourceCardId ? GENERIC_KNOWN_CARDS.has(sourceCardId) : false;
    logger.warn('[effects] GENERIC_OP_SKIPPED', {
      sourceCardId,
      known,
      event: 'GENERIC_OP_SKIPPED'
    });
    return {
      patches: [],
      triggeredAbilities: [],
      log: [
        {
          tick: 0,
          kind: 'generic_op_skipped',
          payload: { sourceCardId, known }
        }
      ]
    };
  }
};

/**
 * ability_copy - Clone the source's abilities onto a target card so the
 * target gains the source's rules text. Guarded against infinite copy
 * chains via a depth counter (cap 10).
 *
 * Patch path stores a copiedAbilities descriptor referencing the source
 * card id; the layer engine reads the descriptor when computing the
 * target's effective rules text.
 */

const COPY_DEPTH_CAP = 10;

interface AbilityCopyOp {
  type: 'ability_copy';
  source?: string;
  target?: string;
  // Depth is tracked per-chain so a card that copies a card that copies a
  // card does not recurse unbounded.
  copyDepth?: number;
}

interface PatchCtxShape {
  units?: Record<
    string,
    { copiedAbilities?: Array<{ source: string; depth: number }> }
  >;
}

export const abilityCopyHandler: OpHandler<{ type: 'ability_copy' }> = {
  op: 'ability_copy',
  execute(ctx: EngineCtx, _op, source): OpResult {
    const op = _op as unknown as AbilityCopyOp;
    const patches: Patch[] = [];

    const sourceInstanceId =
      op.source ??
      (source as unknown as { instanceId?: string })?.instanceId ??
      (source as unknown as { id?: string })?.id ??
      '';
    const targetId = op.target ?? sourceInstanceId;
    if (!sourceInstanceId || !targetId) return emptyResult();

    const depth = (op.copyDepth ?? 0) + 1;
    if (depth > COPY_DEPTH_CAP) {
      logger.warn('[effects] ability_copy depth cap hit', {
        source: sourceInstanceId,
        target: targetId,
        depth,
        cap: COPY_DEPTH_CAP
      });
      return {
        patches: [],
        triggeredAbilities: [],
        log: [
          {
            tick: 0,
            kind: 'ability_copy_depth_cap',
            payload: { source: sourceInstanceId, target: targetId, depth }
          }
        ]
      };
    }

    const shape = ctx as unknown as PatchCtxShape;
    const existing = shape.units?.[targetId]?.copiedAbilities ?? [];
    if (existing.some((c) => c.source === sourceInstanceId)) {
      return {
        patches: [],
        triggeredAbilities: [],
        log: [
          {
            tick: 0,
            kind: 'ability_copy_redundant_noop',
            payload: { source: sourceInstanceId, target: targetId }
          }
        ]
      };
    }

    patches.push({
      op: 'add',
      path: `/units/${targetId}/copiedAbilities/-`,
      value: { source: sourceInstanceId, depth }
    });
    return {
      patches,
      triggeredAbilities: [],
      log: [
        {
          tick: 0,
          kind: 'ability_copy_applied',
          payload: { source: sourceInstanceId, target: targetId, depth }
        }
      ]
    };
  }
};
