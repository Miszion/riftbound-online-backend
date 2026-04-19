import type { EffectOperation } from '../../card-catalog';
import type { BoardCard } from '../../game-engine';
import type {
  EngineCtx,
  LogEntry,
  OpHandler,
  OpResult,
  Patch
} from '../types';
import { emptyResult } from '../types';

interface ReadyOp {
  type: 'ready';
  target?: string;
  count?: number;
}

interface PatchCtxUnit {
  instanceId: string;
  state?: { exhausted?: boolean; [k: string]: unknown };
  [k: string]: unknown;
}

interface PatchCtxShape {
  units?: Record<string, PatchCtxUnit>;
  zones?: {
    board?: {
      bases?: Record<string, { presentUnits?: string[] } & Record<string, unknown>>;
      battlefields?: Record<string, { presentUnits?: string[] } & Record<string, unknown>>;
    };
  };
}

function resolveBoardTargets(ctx: EngineCtx): BoardCard[] {
  const opCtx = ctx.operationContext;
  if (!opCtx) return [];
  const { targets, boardTarget } = opCtx;
  if (targets && targets.length > 0) {
    return targets
      .map((id) => ctx.engine?.findCardInstance?.(id))
      .filter((c): c is BoardCard => Boolean(c));
  }
  return boardTarget ? [boardTarget] : [];
}

function locateUnit(
  ctx: EngineCtx,
  instanceId: string
): { basePath: string | null } {
  const shape = ctx as unknown as PatchCtxShape;
  const bases = shape.zones?.board?.bases ?? {};
  for (const [playerId, base] of Object.entries(bases)) {
    if (base?.presentUnits?.includes(instanceId)) {
      return { basePath: `/zones/board/bases/${playerId}` };
    }
  }
  const battlefields = shape.zones?.board?.battlefields ?? {};
  for (const [bfId, bf] of Object.entries(battlefields)) {
    if (bf?.presentUnits?.includes(instanceId)) {
      return { basePath: `/zones/board/battlefields/${bfId}` };
    }
  }
  return { basePath: null };
}

/**
 * ready - Rule 415 (opposite of Exhaust). Patch path flips exhausted=false
 * on the target unit; idempotent (no patch if already ready).
 */
export const readyHandler: OpHandler<{ type: 'ready' }> = {
  op: 'ready',
  execute(ctx: EngineCtx, _op): OpResult {
    const op = _op as unknown as ReadyOp;
    const operation = _op as unknown as EffectOperation;

    // Engine adapter path (legacy production behavior).
    if (ctx.engine && typeof ctx.engine.addDuelLogEntry === 'function' && ctx.engine.getOtherPlayer) {
      const unitTargets = resolveBoardTargets(ctx).filter((t) => t.isTapped);
      if (unitTargets.length > 0) {
        for (const target of unitTargets) {
          target.isTapped = false;
          ctx.engine?.addDuelLogEntry?.({
            playerId: ctx.caster?.playerId,
            message: `${target.name ?? 'A unit'} is readied.`,
            tone: 'success'
          });
        }
        return emptyResult();
      }

      if (!ctx.caster) return emptyResult();
      const count = Math.max(1, operation.magnitudeHint ?? 1);
      const targetPlayer = operation.targetHint === 'enemy'
        ? ctx.engine.getOtherPlayer(ctx.caster)
        : ctx.caster;

      let readied = 0;
      for (const rune of targetPlayer.channeledRunes) {
        if (rune.isTapped && readied < count) {
          rune.isTapped = false;
          readied++;
        }
      }
      if (readied > 0) {
        ctx.engine?.addDuelLogEntry?.({
          playerId: targetPlayer.playerId,
          message: `${readied} rune${readied === 1 ? '' : 's'} readied.`,
          tone: 'success'
        });
      }
      return emptyResult();
    }

    // Patch-only path.
    const patches: Patch[] = [];
    const log: LogEntry[] = [];
    const targetId = op.target;
    if (!targetId) return emptyResult();

    const shape = ctx as unknown as PatchCtxShape;
    const unit = shape.units?.[targetId];
    const alreadyReady = unit?.state?.exhausted !== true;
    if (alreadyReady) {
      log.push({ tick: 0, kind: 'ready_redundant_noop', payload: { target: targetId } });
      return { patches, triggeredAbilities: [], log };
    }

    const { basePath } = locateUnit(ctx, targetId);
    if (basePath) {
      patches.push({
        op: 'replace',
        path: `${basePath}/${targetId}/state/exhausted`,
        value: false
      });
    }
    patches.push({
      op: 'replace',
      path: `/units/${targetId}/state/exhausted`,
      value: false
    });
    log.push({ tick: 0, kind: 'ready_applied', payload: { target: targetId } });
    return { patches, triggeredAbilities: [], log };
  }
};
