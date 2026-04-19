import type {
  EngineCtx,
  LogEntry,
  OpHandler,
  OpResult,
  Patch,
  ValidationResult
} from '../types';
import { emptyResult } from '../types';

interface AttachGearOp {
  type: 'attach_gear';
  gearInstance?: string;
  target?: string;
  reason?: 'equip_activation' | 'weaponmaster' | 'quickdraw' | 'card_effect';
  detachFromPrior?: string;
}

interface PatchCtxUnit {
  instanceId: string;
  cardType?: string;
  attachments?: { attachedTo?: string; topMostAttachments?: string[] };
  [k: string]: unknown;
}

interface PatchCtxShape {
  units?: Record<string, PatchCtxUnit>;
}

/**
 * attach_gear - Rule 434 Attach action. Validate rejects non-unit bearers.
 * Emits patches that set the gear's attachedTo and push the gear onto the
 * bearer's topMostAttachments. Detaches from a prior bearer first.
 *
 * The existing OGN-179 skip list (a card whose text says "kill gear") is
 * preserved for the engine-adapter production path only.
 */
const SKIPLIST = new Set<string>(['OGN-179']);

export const attachGearHandler: OpHandler<{ type: 'attach_gear' }> = {
  op: 'attach_gear',
  validate(ctx: EngineCtx, _op, source): ValidationResult {
    const op = _op as unknown as AttachGearOp;

    // Adapter path preserves the OGN-179 skip-list guard.
    if (ctx.engine && typeof ctx.engine.addDuelLogEntry === 'function') {
      if (source && SKIPLIST.has(source.id)) {
        return { ok: false, reason: 'attach_gear_card_on_skip_list' };
      }
      return { ok: true };
    }

    // Patch path: target must be a Unit.
    const targetId = op.target;
    if (!targetId) return { ok: true };
    const shape = ctx as unknown as PatchCtxShape;
    const target = shape.units?.[targetId];
    if (target && target.cardType !== 'Unit') {
      return { ok: false, reason: 'attach_target_not_unit' };
    }
    return { ok: true };
  },
  execute(ctx: EngineCtx, _op, source): OpResult {
    const op = _op as unknown as AttachGearOp;

    // Engine adapter path (legacy behavior).
    if (ctx.engine && typeof ctx.engine.addDuelLogEntry === 'function' && ctx.caster) {
      const name = source.name;
      const playerName = ctx.engine.resolvePlayerName(ctx.caster.playerId) ?? 'Player';
      ctx.engine.addDuelLogEntry({
        playerId: ctx.caster.playerId,
        message: `${playerName} equips a gear via ${name}.`,
        tone: 'info'
      });
      ctx.engine.logRuleUsage(source, 'attach-gear');
      return emptyResult();
    }

    // Patch-only path.
    const patches: Patch[] = [];
    const log: LogEntry[] = [];
    const gearId = op.gearInstance;
    const targetId = op.target;
    if (!gearId || !targetId) return emptyResult();

    const shape = ctx as unknown as PatchCtxShape;
    const priorId = op.detachFromPrior;
    if (priorId) {
      const prior = shape.units?.[priorId];
      const topMost = prior?.attachments?.topMostAttachments ?? [];
      const idx = topMost.indexOf(gearId);
      if (idx >= 0) {
        patches.push({
          op: 'remove',
          path: `/units/${priorId}/attachments/topMostAttachments/${idx}`
        });
      }
    }
    patches.push({
      op: 'replace',
      path: `/units/${gearId}/attachments/attachedTo`,
      value: targetId
    });
    patches.push({
      op: 'add',
      path: `/units/${targetId}/attachments/topMostAttachments/-`,
      value: gearId
    });
    log.push({ tick: 0, kind: 'attach_gear_applied', payload: { gear: gearId, target: targetId } });
    return { patches, triggeredAbilities: [], log };
  }
};

/**
 * hide_modifier - OGN-278 Bandle Tree: the card exposes a rules-text
 * modifier that should not be surfaced in the effective-abilities read
 * of its bearer/location (a printed-vs-granted distinction). Patch
 * flips `hideModifierActive=true` on the source so the layers pipeline
 * suppresses the appropriate modifier layer. Idempotent.
 */
export const hideModifierHandler: OpHandler<{ type: 'hide_modifier' }> = {
  op: 'hide_modifier',
  execute(ctx, _op, source) {
    const op = _op as unknown as { source?: string };
    const sourceInstanceId =
      op.source ??
      (source as unknown as { instanceId?: string })?.instanceId ??
      (source as unknown as { id?: string })?.id ??
      '';
    if (!sourceInstanceId) return emptyResult();

    const shape = ctx as unknown as {
      units?: Record<string, { hideModifierActive?: boolean }>;
    };
    const already = shape.units?.[sourceInstanceId]?.hideModifierActive === true;
    if (already) {
      return {
        patches: [],
        triggeredAbilities: [],
        log: [{ tick: 0, kind: 'hide_modifier_redundant_noop', payload: { source: sourceInstanceId } }]
      };
    }
    return {
      patches: [
        {
          op: 'add',
          path: `/units/${sourceInstanceId}/hideModifierActive`,
          value: true
        }
      ],
      triggeredAbilities: [],
      log: [{ tick: 0, kind: 'hide_modifier_registered', payload: { source: sourceInstanceId } }]
    };
  }
};
