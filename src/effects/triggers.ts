import logger from '../logger';
import type { EngineCtx, TriggerFire, PlayerId } from './types';

/**
 * TriggerRegistry - Phase 1 spec section 1.
 *
 * For Phase 2b we capture trigger subscriptions and fan out fires with
 * APNAP ordering. The actual Chain push is owned by the outer engine
 * (spec 12.1), so `fire` returns the ordered TriggerFire list rather than
 * enqueuing onto the Chain itself.
 */

export type TriggerKind =
  | 'on_play'
  | 'on_play_other_spell'
  | 'on_play_other_unit'
  | 'on_conquer'
  | 'on_hold'
  | 'on_move'
  | 'on_kill'
  | 'on_unit_dies_other'
  | 'on_damage_dealt'
  | 'on_damage_taken'
  | 'on_channel'
  | 'on_draw'
  | 'on_attack'
  | 'on_defend'
  | 'equip_attach'
  | string;

export interface TriggerSubscription {
  kind: TriggerKind;
  sourceInstanceId: string;
  sourceController: PlayerId;
  /**
   * Predicate invoked when an event of `kind` fires. Return a TriggerFire
   * to enqueue, or null to ignore. The predicate must snapshot any context
   * it needs from the event - see spec 1.2 "snapshot rules".
   *
   * Optional: when omitted, the registry uses a default matcher that fires
   * on any event whose `kind` matches the subscription's `kind` and
   * snapshots the full event payload.
   */
  match?: (event: { kind: string; payload: Record<string, unknown> }) => TriggerFire | null;
}

export interface TriggerRegisterInput {
  // Canonical spec field (contract test shape).
  triggerType?: string;
  // Legacy internal field.
  kind?: TriggerKind;
  sourceInstanceId: string;
  sourceController: PlayerId;
  match?: TriggerSubscription['match'];
  predicate?: (event: { kind: string; payload: Record<string, unknown> }) => boolean;
}

// Map spec TriggerType -> event.kind the subscription wakes up on.
const SPEC_TRIGGER_TYPE_TO_EVENT_KIND: Record<string, string> = {
  at_start_of_combat: 'at_start_of_combat',
  equip_trigger: 'attach_event',
  on_conquer: 'on_conquer',
  on_kill: 'on_kill',
  on_play: 'on_play',
  on_play_other_spell: 'on_play_other_spell',
  on_play_other_unit: 'on_play_other_unit',
  on_hold: 'on_hold',
  on_move: 'on_move',
  on_damage_dealt: 'on_damage_dealt',
  on_damage_taken: 'on_damage_taken',
  on_channel: 'on_channel',
  on_buff: 'on_buff',
  on_draw: 'on_draw',
  on_recycle: 'on_recycle',
  at_end_of_combat: 'at_end_of_combat',
  on_move_other: 'on_move_other',
  on_unit_dies_other: 'on_unit_dies_other',
  reflexive: 'reflexive'
};

export class TriggerRegistry {
  // Keyed on event.kind; a single subscription shows up under its event-kind.
  private readonly subs = new Map<string, TriggerSubscription[]>();
  // Controller index maintained for APNAP ordering when `fire` receives a
  // ctx but no explicit turnOrder.
  private readonly insertionOrder: TriggerSubscription[] = [];

  /**
   * Legacy internal API: subscribe with a `match` function.
   */
  subscribe(sub: TriggerSubscription): void {
    const list = this.subs.get(sub.kind) ?? [];
    list.push(sub);
    this.subs.set(sub.kind, list);
    this.insertionOrder.push(sub);
  }

  /**
   * Spec-shaped API (contract tests): register with either `triggerType`
   * (canonical) or `kind` (legacy). A default matcher is installed when
   * `match` is not provided; it snapshots the event and fires whenever
   * the event kind matches.
   */
  register(input: TriggerRegisterInput): void {
    const specKind = input.triggerType ?? input.kind;
    if (!specKind) return;
    const eventKind = SPEC_TRIGGER_TYPE_TO_EVENT_KIND[specKind] ?? specKind;
    const sub: TriggerSubscription = {
      kind: eventKind,
      sourceInstanceId: input.sourceInstanceId,
      sourceController: input.sourceController,
      match: input.match ?? ((event) => {
        if (event.kind !== eventKind) return null;
        if (input.predicate && !input.predicate(event)) return null;
        return {
          triggerType: specKind,
          sourceInstanceId: input.sourceInstanceId,
          sourceController: input.sourceController,
          eventSnapshot: { kind: event.kind, payload: { ...event.payload } }
        };
      })
    };
    this.subscribe(sub);
  }

  unsubscribeBySource(sourceInstanceId: string): void {
    for (const [kind, list] of this.subs.entries()) {
      this.subs.set(
        kind,
        list.filter((s) => s.sourceInstanceId !== sourceInstanceId)
      );
    }
  }

  /**
   * Fire an event through the registry. Returns an APNAP-ordered list of
   * TriggerFires. Ordering per spec 1.3: group by controller, starting with
   * turn player, then proceed in turn order. Within a controller's batch,
   * insertion order is preserved (engine may prompt the controller for a
   * reorder before pushing onto the Chain).
   *
   * Accepts either a PlayerId[] (legacy) or an EngineCtx-like object with
   * `turnPlayerId` + `players` (spec contract).
   */
  fire(
    event: { kind: string; payload: Record<string, unknown> },
    ctxOrOrder: PlayerId[] | { turnPlayerId?: PlayerId; players?: Array<{ playerId: PlayerId }> }
  ): TriggerFire[] {
    const list = this.subs.get(event.kind);
    if (!list || list.length === 0) {
      return [];
    }

    const matched: TriggerFire[] = [];
    for (const sub of list) {
      const matcher = sub.match;
      if (!matcher) continue;
      try {
        const fire = matcher(event);
        if (fire) {
          matched.push(fire);
        }
      } catch (err) {
        logger.warn('[effects] trigger match threw', {
          err,
          kind: event.kind,
          source: sub.sourceInstanceId
        });
      }
    }

    const turnOrder = resolveTurnOrder(ctxOrOrder);

    if (matched.length <= 1 || turnOrder.length === 0) {
      return matched;
    }

    const byController = new Map<PlayerId, TriggerFire[]>();
    for (const fire of matched) {
      const bucket = byController.get(fire.sourceController) ?? [];
      bucket.push(fire);
      byController.set(fire.sourceController, bucket);
    }

    const ordered: TriggerFire[] = [];
    for (const player of turnOrder) {
      const bucket = byController.get(player);
      if (bucket) {
        ordered.push(...bucket);
        byController.delete(player);
      }
    }
    // Any remaining (unknown turn-order) controllers append last - preserves
    // determinism without swallowing triggers from spectator/system sources.
    for (const bucket of byController.values()) {
      ordered.push(...bucket);
    }
    return ordered;
  }

  listKinds(): TriggerKind[] {
    return Array.from(this.subs.keys());
  }

  list(): Array<{ triggerType: string; sourceInstanceId: string }> {
    return this.insertionOrder.map((s) => ({
      triggerType: s.kind,
      sourceInstanceId: s.sourceInstanceId
    }));
  }
}

function resolveTurnOrder(
  input: PlayerId[] | { turnPlayerId?: PlayerId; players?: Array<{ playerId: PlayerId }> }
): PlayerId[] {
  if (Array.isArray(input)) return input;
  const turn = input?.turnPlayerId;
  const players = input?.players ?? [];
  if (!turn) return players.map((p) => p.playerId);
  const ids = players.map((p) => p.playerId);
  const rest = ids.filter((id) => id !== turn);
  return [turn, ...rest];
}

/**
 * Map between the data-layer op.type names and the canonical TriggerKind we
 * subscribe under. The spec calls out these ops as trigger registrations
 * (spec section 1.1 table + 14.4).
 */
export const TRIGGER_OP_TO_KIND: Record<string, TriggerKind> = {
  on_play_trigger: 'on_play',
  equip_trigger: 'equip_attach',
  conquer_trigger: 'on_conquer',
  combat_trigger: 'on_attack',
  death_trigger: 'on_kill'
};

/**
 * Install the trigger subscription implied by a card's trigger-marker op.
 * Body is deliberately minimal - the existing RiftboundGameEngine already
 * drives the ambient trigger pipelines (combat, death, conquer, hold,
 * on-play) directly against its internal state. This registration exists so
 * the dispatcher contract is complete and future handlers can be wired
 * through the registry without a breaking change.
 */
export function registerTriggerOpSubscription(
  ctx: EngineCtx,
  source: { id?: string; instanceId?: string } | undefined,
  registry: TriggerRegistry,
  opType: keyof typeof TRIGGER_OP_TO_KIND
): void {
  const kind = TRIGGER_OP_TO_KIND[opType];
  if (!kind) return;
  const controller = ctx.caster?.playerId;
  const instanceId = source?.instanceId ?? source?.id;
  if (!instanceId || !controller) return;
  registry.subscribe({
    kind,
    sourceInstanceId: instanceId,
    sourceController: controller,
    match: (event) => ({
      triggerType: kind,
      sourceInstanceId: instanceId,
      sourceController: controller,
      eventSnapshot: event
    })
  });
}
