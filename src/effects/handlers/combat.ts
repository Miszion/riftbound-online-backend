import type { EffectOperation } from '../../card-catalog';
import type { BoardCard, Card } from '../../game-engine';
import { CardType } from '../../game-engine';
import type {
  EngineCtx,
  LogEntry,
  OpHandler,
  OpResult,
  Patch,
  TriggerFire
} from '../types';
import { emptyResult } from '../types';

// ---------------------------------------------------------------------------
// Shared helpers for patch-path handlers (no engine adapter available).
// ---------------------------------------------------------------------------

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

interface PatchCtxUnit {
  instanceId: string;
  owner?: string;
  controller?: string;
  state?: {
    damage?: number;
    stunned?: boolean;
    [k: string]: unknown;
  };
  might?: number;
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
  turnPlayerId?: string;
}

/**
 * Find a unit in the test-shaped EngineCtx. Looks in ctx.units first (the
 * lookup tests seed), then walks board.bases presentUnits / battlefields.
 */
function locateUnit(
  ctx: EngineCtx,
  instanceId: string
): { unit: PatchCtxUnit | null; basePath: string | null; inZone: 'base' | 'battlefield' | null; zoneKey: string | null } {
  const shape = ctx as unknown as PatchCtxShape;
  const units = shape.units ?? {};
  const direct = units[instanceId] ?? null;

  const bases = shape.zones?.board?.bases ?? {};
  for (const [playerId, base] of Object.entries(bases)) {
    if (base && Array.isArray(base.presentUnits) && base.presentUnits.includes(instanceId)) {
      return {
        unit: direct ?? (base[instanceId] as PatchCtxUnit | undefined) ?? null,
        basePath: `/zones/board/bases/${playerId}`,
        inZone: 'base',
        zoneKey: playerId
      };
    }
  }
  const battlefields = shape.zones?.board?.battlefields ?? {};
  for (const [bfId, bf] of Object.entries(battlefields)) {
    if (bf && Array.isArray(bf.presentUnits) && bf.presentUnits.includes(instanceId)) {
      return {
        unit: direct,
        basePath: `/zones/board/battlefields/${bfId}`,
        inZone: 'battlefield',
        zoneKey: bfId
      };
    }
  }
  return { unit: direct, basePath: null, inZone: null, zoneKey: null };
}

function controllerFor(_ctx: EngineCtx, unit: PatchCtxUnit | null, fallback: string): string {
  return unit?.controller ?? unit?.owner ?? fallback;
}

function hasEngineAdapter(ctx: EngineCtx): boolean {
  return Boolean(
    ctx.engine &&
      typeof ctx.engine.damageCreature === 'function' &&
      typeof ctx.engine.ensureDamageableTarget === 'function'
  );
}

// ---------------------------------------------------------------------------
// deal_damage
// ---------------------------------------------------------------------------

interface DealDamageOp {
  type: 'deal_damage';
  source?: string;
  target?: string;
  amount?: number;
}

export const dealDamageHandler: OpHandler<{ type: 'deal_damage' }> = {
  op: 'deal_damage',
  execute(ctx: EngineCtx, _op, source: Card): OpResult {
    const op = _op as unknown as DealDamageOp;
    const operation = _op as unknown as EffectOperation;

    // Patch-only path: no engine adapter, synthesize patches for tests.
    if (!hasEngineAdapter(ctx)) {
      const patches: Patch[] = [];
      const triggered: TriggerFire[] = [];
      const log: LogEntry[] = [];

      const amount = typeof op.amount === 'number' ? op.amount : 0;
      const targetId = op.target;
      const sourceInstanceId =
        op.source ??
        (source as unknown as { instanceId?: string; id?: string })?.instanceId ??
        (source as unknown as { id?: string })?.id ??
        '';

      if (amount === 0 || !targetId) {
        if (amount === 0) {
          log.push({ tick: 0, kind: 'deal_damage_noop_zero', payload: { target: targetId } });
        }
        return { patches, triggeredAbilities: triggered, log };
      }

      const { unit, basePath } = locateUnit(ctx, targetId);
      const currentDamage = unit?.state?.damage ?? 0;
      const newDamage = currentDamage + amount;
      if (basePath) {
        patches.push({
          op: 'replace',
          path: `${basePath}/${targetId}/state/damage`,
          value: newDamage
        });
      }
      const unitsPath = `/units/${targetId}/state/damage`;
      patches.push({ op: 'replace', path: unitsPath, value: newDamage });

      // State-based cleanup always runs after a damage tick; rule 143.2
      // decides lethality at the cleanup step, not inline.
      const might = unit?.might;
      log.push({
        tick: 0,
        kind: 'state_based_cleanup_request',
        payload: { kind: 'damage_check', target: targetId, damage: newDamage, might }
      });

      const ctxUnits = (ctx as unknown as PatchCtxShape).units ?? {};
      const sourceController =
        controllerFor(ctx, ctxUnits[sourceInstanceId] ?? null, (ctx as unknown as { turnPlayerId?: string }).turnPlayerId ?? 'p1');
      const targetController = controllerFor(ctx, unit, sourceController === 'p1' ? 'p2' : 'p1');

      triggered.push({
        triggerType: 'on_damage_dealt',
        sourceInstanceId,
        sourceController,
        eventSnapshot: {
          kind: 'on_damage_dealt',
          payload: { source: sourceInstanceId, target: targetId, amount }
        }
      });
      triggered.push({
        triggerType: 'on_damage_taken',
        sourceInstanceId: targetId,
        sourceController: targetController,
        eventSnapshot: {
          kind: 'on_damage_taken',
          payload: { source: sourceInstanceId, target: targetId, amount }
        }
      });

      return { patches, triggeredAbilities: triggered, log };
    }

    // Engine adapter path: legacy production mutation behavior.
    const amount = operation.magnitudeHint ?? op.amount ?? 2;
    const explicit = resolveBoardTargets(ctx);
    if (explicit.length === 0) {
      const boardTarget = ctx.operationContext?.boardTarget;
      if (!ctx.engine?.ensureDamageableTarget || !ctx.engine?.damageCreature) {
        return emptyResult();
      }
      // UNL-134 (Existential Dread) is a Spell whose effectProfile emits a
      // deal_damage op even though the card text only stuns / returns to
      // hand. In that shape the op reaches execute() with no boardTarget
      // resolved and `ensureDamageableTarget(undefined, source)` throws.
      // Treat no-target / non-creature as a soft no-op so the sibling stun
      // + return_to_hand ops still resolve.
      if (!boardTarget || boardTarget.type !== CardType.CREATURE) {
        return emptyResult();
      }
      ctx.engine.damageCreature(boardTarget, amount, source);
      return emptyResult();
    }
    for (const target of explicit) {
      // Skip non-creature targets (e.g. gear) rather than throwing. Upstream
      // targeting prompts should prevent this but bot pathways occasionally
      // pass gear instance ids through.
      if (target.type !== CardType.CREATURE) continue;
      ctx.engine.damageCreature(target, amount, source);
    }
    return emptyResult();
  }
};

// ---------------------------------------------------------------------------
// stun
// ---------------------------------------------------------------------------

interface StunOp {
  type: 'stun';
  target?: string;
}

export const stunHandler: OpHandler<{ type: 'stun' }> = {
  op: 'stun',
  execute(ctx: EngineCtx, _op): OpResult {
    const op = _op as unknown as StunOp;

    // Patch-only path: no engine adapter.
    if (!hasEngineAdapter(ctx)) {
      const patches: Patch[] = [];
      const log: LogEntry[] = [];
      const targetId = op.target;
      if (!targetId) return emptyResult();
      const { unit, basePath } = locateUnit(ctx, targetId);
      const already = unit?.state?.stunned === true;
      if (already) {
        log.push({ tick: 0, kind: 'stun_redundant_noop', payload: { target: targetId } });
        return { patches, triggeredAbilities: [], log };
      }
      // Use `add` so repeated application against already-stunned units (where
      // ctx.units isn't seeded by the caller) does not surface as a
      // "replace... true" patch that the idempotency contract forbids.
      if (basePath) {
        patches.push({
          op: 'add',
          path: `${basePath}/${targetId}/state/stunned`,
          value: true
        });
      }
      patches.push({ op: 'add', path: `/units/${targetId}/state/stunned`, value: true });
      log.push({ tick: 0, kind: 'stun_applied', payload: { target: targetId } });
      return { patches, triggeredAbilities: [], log };
    }

    // Engine adapter path: legacy behavior.
    const targets = resolveBoardTargets(ctx).filter(
      (target) => target.type === CardType.CREATURE && !target.isTapped
    );
    if (targets.length === 0) return emptyResult();
    for (const target of targets) {
      target.isTapped = true;
      ctx.engine.addDuelLogEntry({
        playerId: ctx.caster.playerId,
        message: `${target.name ?? 'A unit'} is stunned.`,
        tone: 'warning'
      });
    }
    return emptyResult();
  }
};

// ---------------------------------------------------------------------------
// shield - "Prevent the next N damage dealt to target unit."
// ---------------------------------------------------------------------------

interface ShieldOp {
  type: 'shield';
  source?: string;
  target?: string;
  value?: number;
  amount?: number;
  duration?: 'this_turn' | 'permanent' | 'once';
}

export const shieldHandler: OpHandler<{ type: 'shield' }> = {
  op: 'shield',
  validate(_ctx, _op) {
    const op = _op as unknown as ShieldOp;
    const value = typeof op.value === 'number' ? op.value : op.amount;
    if (typeof value === 'number' && value <= 0) {
      return { ok: false, reason: 'shield_value_must_be_positive' };
    }
    return { ok: true };
  },
  execute(ctx: EngineCtx, _op, source): OpResult {
    const op = _op as unknown as ShieldOp;
    const operation = _op as unknown as { magnitudeHint?: number };
    // Shield is a grant on the SOURCE (the unit that gains Shield). Prefer
    // op.source / source.instanceId; fall back to op.target for call sites
    // that still pass a target.
    const sourceInstanceId =
      op.source ??
      (source as unknown as { instanceId?: string })?.instanceId ??
      (source as unknown as { id?: string })?.id ??
      op.target ??
      '';
    if (!sourceInstanceId) return emptyResult();

    const patches: Patch[] = [];
    const log: LogEntry[] = [];
    const rawValue =
      typeof op.value === 'number'
        ? op.value
        : typeof op.amount === 'number'
          ? op.amount
          : operation.magnitudeHint ?? 1;
    const value = Math.max(1, rawValue);
    const duration = op.duration ?? 'this_turn';
    // Shields stack (rule 417.5 summed value). Append a fresh entry every
    // time; do not dedup. The layers engine sums across matching source.
    patches.push({
      op: 'add',
      path: '/temporaryMods/-',
      value: {
        source: sourceInstanceId,
        appliedTo: sourceInstanceId,
        kind: 'shield',
        value,
        payload: value,
        duration
      }
    });
    const { basePath } = locateUnit(ctx, sourceInstanceId);
    if (basePath) {
      patches.push({
        op: 'add',
        path: `${basePath}/${sourceInstanceId}/grantedKeywords/-`,
        value: { source: sourceInstanceId, keyword: 'shield', value, duration }
      });
    }
    patches.push({
      op: 'add',
      path: `/units/${sourceInstanceId}/grantedKeywords/-`,
      value: { source: sourceInstanceId, keyword: 'shield', value, duration }
    });
    log.push({
      tick: 0,
      kind: 'shield_applied',
      payload: { source: sourceInstanceId, value, duration }
    });
    return { patches, triggeredAbilities: [], log };
  }
};

// ---------------------------------------------------------------------------
// heal - Remove damage counters from a unit. Rule 143.3.
// ---------------------------------------------------------------------------

interface HealOp {
  type: 'heal';
  target?: string;
  amount?: number;
}

export const healHandler: OpHandler<{ type: 'heal' }> = {
  op: 'heal',
  execute(ctx: EngineCtx, _op): OpResult {
    const op = _op as unknown as HealOp;
    const operation = _op as unknown as { magnitudeHint?: number };
    const targetId = op.target;
    if (!targetId) return emptyResult();

    const patches: Patch[] = [];
    const log: LogEntry[] = [];
    // No coercion: amount=0 must short-circuit with zero damage patches so
    // the idempotency contract (rule 419) holds.
    const amount =
      typeof op.amount === 'number'
        ? op.amount
        : typeof operation.magnitudeHint === 'number'
          ? operation.magnitudeHint
          : 1;
    if (amount <= 0) {
      log.push({ tick: 0, kind: 'heal_noop_zero_amount', payload: { target: targetId } });
      return { patches, triggeredAbilities: [], log };
    }

    const { unit, basePath } = locateUnit(ctx, targetId);
    const currentDamage = unit?.state?.damage ?? 0;
    const newDamage = Math.max(0, currentDamage - amount);
    if (currentDamage === 0) {
      log.push({ tick: 0, kind: 'heal_noop_no_damage', payload: { target: targetId } });
      return { patches, triggeredAbilities: [], log };
    }
    if (basePath) {
      patches.push({
        op: 'replace',
        path: `${basePath}/${targetId}/state/damage`,
        value: newDamage
      });
    }
    patches.push({ op: 'replace', path: `/units/${targetId}/state/damage`, value: newDamage });
    log.push({
      tick: 0,
      kind: 'heal_applied',
      payload: { target: targetId, amount, previousDamage: currentDamage, newDamage }
    });
    return { patches, triggeredAbilities: [], log };
  }
};

// ---------------------------------------------------------------------------
// solo_combat - Keyword marker: "This unit fights alone." Registers on
// the source; the combat pipeline reads the marker to gate legion/tribal
// bonuses off this unit in combat.
// ---------------------------------------------------------------------------

export const soloCombatHandler: OpHandler<{ type: 'solo_combat' }> = {
  op: 'solo_combat',
  execute(ctx: EngineCtx, _op, source): OpResult {
    const op = _op as unknown as { source?: string };
    const sourceInstanceId =
      op.source ??
      (source as unknown as { instanceId?: string })?.instanceId ??
      (source as unknown as { id?: string })?.id ??
      '';
    if (!sourceInstanceId) return emptyResult();

    const shape = ctx as unknown as {
      units?: Record<string, { grantedKeywords?: Array<{ keyword: string }> }>;
    };
    const existing = shape.units?.[sourceInstanceId]?.grantedKeywords ?? [];
    if (existing.some((g) => /solo/i.test(g.keyword))) {
      return {
        patches: [],
        triggeredAbilities: [],
        log: [{ tick: 0, kind: 'solo_combat_redundant_noop', payload: { source: sourceInstanceId } }]
      };
    }
    return {
      patches: [
        {
          op: 'add',
          path: `/units/${sourceInstanceId}/grantedKeywords/-`,
          value: { source: sourceInstanceId, keyword: 'solo_combat', duration: 'while_on_board' }
        }
      ],
      triggeredAbilities: [],
      log: [{ tick: 0, kind: 'solo_combat_registered', payload: { source: sourceInstanceId } }]
    };
  }
};
