import type { EffectOperation } from '../../card-catalog';
import type { BoardCard } from '../../game-engine';
import { CardType } from '../../game-engine';
import logger from '../../logger';
import type {
  EngineCtx,
  LogEntry,
  OpHandler,
  OpResult,
  Patch,
  TriggerFire,
  ValidationResult
} from '../types';
import { emptyResult } from '../types';

// ---------------------------------------------------------------------------
// Recursion depth cap for move_unit chains (Phase 5d).
//
// UNL-082A (Lillia - Fae Fawn) has an on_move trigger whose operations list
// includes `move_unit`, which re-fires the same trigger via the engine's
// `triggerAbilities('move_from_battlefield'|'move_to_battlefield')` hook.
// That is a synchronous re-entry of the dispatcher and the stack overflows
// within ~1000 frames. The card itself is legal; the crash is a DoS on the
// match server any player can trigger.
//
// Magic-style TCGs cap effect recursion somewhere between 20 and 500 (Arena
// uses 500, paper-rules-lawyers use "game loop" short-circuit at 3-20). We
// pick 50 here: the longest legitimate move-chain we've seen in play-tests
// tops out at 4-5 (Lillia + follow_movement + follow_movement), so 50 leaves
// 10x headroom for unknown interactions while catching pathological loops
// well before node's 10k+ default stack limit.
//
// Keyed on ctx.engine: the engine caches getEffectsAdapter() across a match,
// so the same adapter object is the entry for every trigger re-fire inside
// that match. WeakMap means finalization runs when the engine is GC'd.
// ---------------------------------------------------------------------------

const MOVE_DEPTH_CAP = 50;
const moveDepthByEngine = new WeakMap<object, number>();

function enterMoveFrame(ctx: EngineCtx): boolean {
  const key = ctx.engine as unknown as object;
  if (!key) return true;
  const current = moveDepthByEngine.get(key) ?? 0;
  if (current >= MOVE_DEPTH_CAP) {
    return false;
  }
  moveDepthByEngine.set(key, current + 1);
  return true;
}

function exitMoveFrame(ctx: EngineCtx): void {
  const key = ctx.engine as unknown as object;
  if (!key) return;
  const current = moveDepthByEngine.get(key) ?? 0;
  if (current <= 1) moveDepthByEngine.delete(key);
  else moveDepthByEngine.set(key, current - 1);
}

interface MoveUnitOp {
  type: 'move_unit';
  unit?: string;
  to?:
    | { kind: 'base'; player: string }
    | { kind: 'battlefield'; battlefieldId: string };
  reason?: 'standard_move' | 'ganking' | 'card_effect' | 'combat_cleanup';
  batchId?: string;
}

interface PatchCtxUnit {
  instanceId: string;
  owner?: string;
  controller?: string;
  cardType?: string;
  [k: string]: unknown;
}

interface PatchCtxShape {
  zones?: {
    board?: {
      bases?: Record<string, { presentUnits?: string[] } & Record<string, unknown>>;
      battlefields?: Record<string, { presentUnits?: string[] } & Record<string, unknown>>;
    };
  };
  units?: Record<string, PatchCtxUnit>;
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

const isCreature = (c: BoardCard | undefined): c is BoardCard =>
  Boolean(c && c.type === CardType.CREATURE);

function findUnitInCtx(ctx: EngineCtx, instanceId: string): PatchCtxUnit | null {
  const shape = ctx as unknown as PatchCtxShape;
  return shape.units?.[instanceId] ?? null;
}

function locate(
  ctx: EngineCtx,
  instanceId: string
): {
  location:
    | { kind: 'base'; player: string }
    | { kind: 'battlefield'; battlefieldId: string }
    | null;
  index: number;
} {
  const shape = ctx as unknown as PatchCtxShape;
  const bases = shape.zones?.board?.bases ?? {};
  for (const [playerId, base] of Object.entries(bases)) {
    const idx = base?.presentUnits?.indexOf(instanceId) ?? -1;
    if (idx >= 0) return { location: { kind: 'base', player: playerId }, index: idx };
  }
  const battlefields = shape.zones?.board?.battlefields ?? {};
  for (const [bfId, bf] of Object.entries(battlefields)) {
    const idx = bf?.presentUnits?.indexOf(instanceId) ?? -1;
    if (idx >= 0)
      return { location: { kind: 'battlefield', battlefieldId: bfId }, index: idx };
  }
  return { location: null, index: -1 };
}

/**
 * move_unit - Rule 442-448 Move action. Rule 442.3 forbids gear from
 * Moving, so validate rejects non-unit targets up front. Invalid
 * destinations trigger a substitute recall op per rule 442.2.c.
 */
export const moveUnitHandler: OpHandler<{ type: 'move_unit' }> = {
  op: 'move_unit',
  validate(ctx: EngineCtx, _op): ValidationResult {
    const op = _op as unknown as MoveUnitOp;

    // Engine adapter path: legacy validate (gear rejection).
    if (ctx.engine && typeof ctx.engine.findCardInstance === 'function') {
      const targets = resolveBoardTargets(ctx);
      if (targets.length === 0) return { ok: true };
      const firstGear = targets.find((t) => t.type !== CardType.CREATURE);
      if (firstGear) {
        return { ok: false, reason: 'gear cannot move' };
      }
      return { ok: true };
    }

    // Patch-only validate path.
    const unitId = op.unit;
    if (!unitId) return { ok: true };
    const unit = findUnitInCtx(ctx, unitId);

    // Gear rejection: rule 442.3.
    if (unit?.cardType === 'Gear') {
      return { ok: false, reason: 'gear cannot move' };
    }

    // Invalid destination becomes recall (rule 442.2.c).
    if (op.to?.kind === 'battlefield') {
      const shape = ctx as unknown as PatchCtxShape;
      const bf = shape.zones?.board?.battlefields?.[op.to.battlefieldId];
      if (!bf) {
        const controller = unit?.controller ?? unit?.owner ?? 'p1';
        return {
          ok: true,
          substituteOp: {
            type: 'recall',
            unit: unitId,
            to: { kind: 'base', player: controller },
            reason: op.reason ?? 'card_effect'
          } as unknown as { type: string; [k: string]: unknown }
        };
      }
    }

    return { ok: true };
  },
  execute(ctx: EngineCtx, _op, source): OpResult {
    const op = _op as unknown as MoveUnitOp;

    // Engine adapter path (legacy production behavior).
    if (ctx.engine && typeof ctx.engine.moveUnitToBattlefield === 'function') {
      const operation = _op as unknown as EffectOperation;
      const sourceAsBoard = source as unknown as BoardCard;

      // Per-match recursion cap. Handler re-enters itself via
      // triggerAbilities('move_from_battlefield'|'move_to_battlefield') when
      // an on_move ability's operation list includes move_unit (UNL-082A).
      // Bail quietly on cap so downstream triggers still see a well-formed
      // empty OpResult.
      if (!enterMoveFrame(ctx)) {
        logger.warn('[effects] MOVE_DEPTH_CAP_HIT', {
          cap: MOVE_DEPTH_CAP,
          sourceCardId: (source as unknown as { id?: string })?.id,
          sourceInstanceId: sourceAsBoard?.instanceId
        });
        return emptyResult();
      }

      try {
        const targets = resolveBoardTargets(ctx);
        const unitsToMove = targets.length > 0
          ? targets.filter(isCreature)
          : isCreature(sourceAsBoard)
            ? [sourceAsBoard]
            : [];

        if (unitsToMove.length === 0) return emptyResult();

        const destMeta =
          typeof operation.metadata === 'object' && operation.metadata
            ? (operation.metadata as { destination?: 'base' | 'battlefield' }).destination
            : undefined;
        const battlefield = ctx.operationContext?.battlefieldTarget;
        const prefersBattlefield =
          destMeta === 'battlefield' ||
          (destMeta === undefined &&
            unitsToMove[0].location.zone === 'base' &&
            operation.targetHint !== 'enemy');

        for (const unit of unitsToMove) {
          const owner = ctx.engine.getPlayerByCard(unit.instanceId);
          if (prefersBattlefield && battlefield) {
            const alreadyThere =
              unit.location.zone === 'battlefield' &&
              unit.location.battlefieldId === battlefield.battlefieldId;
            if (!alreadyThere) {
              ctx.engine.moveUnitToBattlefield(owner, unit, battlefield);
            }
          } else if (unit.location.zone !== 'base') {
            ctx.engine.moveUnitToBase(owner, unit);
          }
        }
        return emptyResult();
      } finally {
        exitMoveFrame(ctx);
      }
    }

    // Patch-only path.
    const patches: Patch[] = [];
    const triggered: TriggerFire[] = [];
    const log: LogEntry[] = [];
    const unitId = op.unit;
    if (!unitId || !op.to) return emptyResult();

    const { location: fromLoc, index: fromIndex } = locate(ctx, unitId);
    if (!fromLoc) return emptyResult();

    // Remove from old presence.
    if (fromLoc.kind === 'base') {
      patches.push({
        op: 'remove',
        path: `/zones/board/bases/${fromLoc.player}/presentUnits/${fromIndex}`
      });
    } else {
      patches.push({
        op: 'remove',
        path: `/zones/board/battlefields/${fromLoc.battlefieldId}/presentUnits/${fromIndex}`
      });
    }
    // Append to new presence.
    if (op.to.kind === 'base') {
      patches.push({
        op: 'add',
        path: `/zones/board/bases/${op.to.player}/presentUnits/-`,
        value: unitId
      });
    } else {
      patches.push({
        op: 'add',
        path: `/zones/board/battlefields/${op.to.battlefieldId}/presentUnits/-`,
        value: unitId
      });
    }
    // Update the instance's location (via /units lookup).
    patches.push({
      op: 'replace',
      path: `/units/${unitId}/location`,
      value: op.to
    });

    // Fire on_move.
    const unit = findUnitInCtx(ctx, unitId);
    const controller = unit?.controller ?? unit?.owner ?? 'p1';
    triggered.push({
      triggerType: 'on_move',
      sourceInstanceId: unitId,
      sourceController: controller,
      eventSnapshot: {
        kind: 'on_move',
        payload: { unit: unitId, from: fromLoc, to: op.to, reason: op.reason }
      }
    });
    log.push({ tick: 0, kind: 'move_unit_applied', payload: { unit: unitId, from: fromLoc, to: op.to } });

    return { patches, triggeredAbilities: triggered, log };
  }
};

/**
 * follow_movement - Spec 15.5. Registration op (not imperative). A unit
 * with follow_movement watches for primary moves and piggybacks. The
 * actual follow fires AFTER the primary move resolves, via an
 * on_move_other observer installed here.
 *
 * Infinite-chain protection lives in the observer payload: the observer
 * tags its synthesized move events with the primary move's batchId and
 * refuses to re-match the same batch.
 */
interface FollowMovementOp {
  type: 'follow_movement';
  source?: string;
}

interface FollowMovementCtx {
  followMovementSubs?: Array<{
    source: string;
    controller: string;
    trigger: { originMatch: string; controllerMatch: string };
    action: 'may_follow';
  }>;
}

export const followMovementHandler: OpHandler<{ type: 'follow_movement' }> = {
  op: 'follow_movement',
  execute(ctx, _op, source): OpResult {
    const op = _op as unknown as FollowMovementOp;
    const sourceInstanceId =
      op.source ??
      (source as unknown as { instanceId?: string })?.instanceId ??
      (source as unknown as { id?: string })?.id ??
      '';
    if (!sourceInstanceId) return emptyResult();

    const shape = ctx as unknown as FollowMovementCtx & { units?: Record<string, { controller?: string }> };
    const existing = shape.followMovementSubs ?? [];
    if (existing.some((s) => s.source === sourceInstanceId)) {
      return {
        patches: [],
        triggeredAbilities: [],
        log: [{ tick: 0, kind: 'follow_movement_redundant_noop', payload: { source: sourceInstanceId } }]
      };
    }
    const controller =
      shape.units?.[sourceInstanceId]?.controller ?? ctx.caster?.playerId ?? 'p1';
    return {
      patches: [
        {
          op: 'add',
          path: '/followMovementSubs/-',
          value: {
            source: sourceInstanceId,
            controller,
            trigger: { originMatch: 'self_location', controllerMatch: 'friendly' },
            action: 'may_follow'
          }
        }
      ],
      triggeredAbilities: [],
      log: [{ tick: 0, kind: 'follow_movement_registered', payload: { source: sourceInstanceId, controller } }]
    };
  }
};
