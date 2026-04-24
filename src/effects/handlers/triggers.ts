import type { EngineCtx, OpHandler, OpResult } from '../types';
import {
  registerTriggerOpSubscription,
  TRIGGER_OP_TO_KIND,
  TriggerRegistry
} from '../triggers';

/**
 * Trigger registration handlers. Per Phase 1 spec section 1 and the task
 * brief, these ops are NOT imperative state mutations; they subscribe a
 * source's triggered ability into the TriggerRegistry so it can fire when
 * the matching event occurs.
 *
 * The registry lives on the engine (attached via EngineAdapter by the
 * RiftboundGameEngine). If no registry is available (unit test, or engine
 * not yet upgraded), the handler falls back to a rule-usage breadcrumb so
 * behavior matches the legacy marker path.
 */

interface AdapterWithTriggers {
  getTriggerRegistry?: () => TriggerRegistry;
}

function withRegistry(
  ctx: EngineCtx,
  source: { id?: string; instanceId?: string } | undefined,
  opType: keyof typeof TRIGGER_OP_TO_KIND,
  sourceIdForLog: string
): OpResult {
  const adapter = ctx.engine as unknown as AdapterWithTriggers | undefined;
  const registry = adapter?.getTriggerRegistry?.();
  if (registry) {
    registerTriggerOpSubscription(ctx, source, registry, opType);
    return {
      patches: [],
      triggeredAbilities: [],
      log: [{ tick: 0, kind: `trigger_register_${opType}`, payload: { source: sourceIdForLog } }]
    };
  }
  // Adapter path missing (standalone/test ctx). Still return a log entry so
  // the dispatcher contract is observable by callers.
  if (ctx.engine?.logRuleUsage && source) {
    ctx.engine.logRuleUsage(source as never, `trigger-marker-${opType}-${sourceIdForLog}`);
  }
  return {
    patches: [],
    triggeredAbilities: [],
    log: [{ tick: 0, kind: `trigger_register_${opType}`, payload: { source: sourceIdForLog } }]
  };
}

export const onPlayTriggerHandler: OpHandler<{ type: 'on_play_trigger' }> = {
  op: 'on_play_trigger',
  execute(ctx, _op, source) {
    return withRegistry(ctx, source, 'on_play_trigger', source?.id ?? source?.instanceId ?? '');
  }
};

export const equipTriggerHandler: OpHandler<{ type: 'equip_trigger' }> = {
  op: 'equip_trigger',
  execute(ctx, _op, source) {
    return withRegistry(ctx, source, 'equip_trigger', source?.id ?? source?.instanceId ?? '');
  }
};

export const conquerTriggerHandler: OpHandler<{ type: 'conquer_trigger' }> = {
  op: 'conquer_trigger',
  execute(ctx, _op, source) {
    return withRegistry(ctx, source, 'conquer_trigger', source?.id ?? source?.instanceId ?? '');
  }
};

export const combatTriggerHandler: OpHandler<{ type: 'combat_trigger' }> = {
  op: 'combat_trigger',
  execute(ctx, _op, source) {
    return withRegistry(ctx, source, 'combat_trigger', source?.id ?? source?.instanceId ?? '');
  }
};

export const deathTriggerHandler: OpHandler<{ type: 'death_trigger' }> = {
  op: 'death_trigger',
  execute(ctx, _op, source) {
    return withRegistry(ctx, source, 'death_trigger', source?.id ?? source?.instanceId ?? '');
  }
};

/**
 * Long-tail trigger registrations. These mirror the Phase-2 shape:
 * install a registry subscription (or log a marker) and return zero
 * patches, zero trigger fires. The event kinds these ride on are
 * orthogonal to the Phase-2 set.
 */

function genericTriggerRegister(
  ctx: EngineCtx,
  source: { id?: string; instanceId?: string } | undefined,
  opType: string,
  eventKind: string
): OpResult {
  const adapter = ctx.engine as unknown as AdapterWithTriggers | undefined;
  const registry = adapter?.getTriggerRegistry?.();
  const sourceIdForLog = source?.id ?? source?.instanceId ?? '';
  const controller = ctx.caster?.playerId;
  const instanceId = source?.instanceId ?? source?.id;

  if (registry && instanceId && controller) {
    registry.subscribe({
      kind: eventKind,
      sourceInstanceId: instanceId,
      sourceController: controller,
      match: (event) => ({
        triggerType: eventKind,
        sourceInstanceId: instanceId,
        sourceController: controller,
        eventSnapshot: event
      })
    });
  } else if (ctx.engine?.logRuleUsage && source) {
    ctx.engine.logRuleUsage(source as never, `trigger-marker-${opType}-${sourceIdForLog}`);
  }
  return {
    patches: [],
    triggeredAbilities: [],
    log: [{ tick: 0, kind: `trigger_register_${opType}`, payload: { source: sourceIdForLog } }]
  };
}

export const holdTriggerHandler: OpHandler<{ type: 'hold_trigger' }> = {
  op: 'hold_trigger',
  execute(ctx, _op, source) {
    return genericTriggerRegister(ctx, source, 'hold_trigger', 'on_hold');
  }
};

export const phaseTriggerHandler: OpHandler<{ type: 'phase_trigger' }> = {
  op: 'phase_trigger',
  execute(ctx, _op, source) {
    const op = _op as unknown as { phase?: string };
    const eventKind = op.phase ? `phase_${op.phase}` : 'phase_change';
    return genericTriggerRegister(ctx, source, 'phase_trigger', eventKind);
  }
};

/**
 * interact_legend - Reactive observer for Legend interactions. Spec
 * section 1 does not enumerate a canonical event for this, but the data
 * shape is consistent: register an observer keyed on Legend-related
 * events (target-a-legend, legend-enters, etc). We install a generic
 * on_legend_interact subscription so matcher details can be layered in
 * by later phases without changing the registration call site.
 */
export const interactLegendHandler: OpHandler<{ type: 'interact_legend' }> = {
  op: 'interact_legend',
  execute(ctx, _op, source) {
    return genericTriggerRegister(ctx, source, 'interact_legend', 'on_legend_interact');
  }
};
