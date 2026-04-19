/**
 * Effect engine type surface (Phase 2b).
 *
 * Kept small and independent of the existing `game-engine.ts` types so that
 * handlers written against this module can be unit-tested without spinning up
 * the full RiftboundGameEngine. The dispatcher adapter bridges these generic
 * shapes to the engine's in-memory model.
 */

import type {
  Card,
  BoardCard,
  BattlefieldState,
  PlayerState
} from '../game-engine';
import type { EffectOperation } from '../card-catalog';

// ---------------------------------------------------------------------------
// Primitives mirrored from the Phase 1 spec
// ---------------------------------------------------------------------------

export type PlayerId = string;
export type InstanceId = string;
export type BattlefieldId = string;
export type Domain = 'fury' | 'calm' | 'mind' | 'body' | 'chaos' | 'order';

export type Location =
  | { kind: 'battlefield'; battlefieldId: BattlefieldId }
  | { kind: 'base'; player: PlayerId };

// ---------------------------------------------------------------------------
// Op union (spec sections 13-18)
// ---------------------------------------------------------------------------

export type PriorityVariant =
  | 'action_tagged'
  | 'reaction_tagged'
  | 'add_reaction'
  | 'take_focus'
  | 'grant_priority'
  | 'extra_action'
  | 'skip_priority_pass';

export type RiftboundOp =
  | {
      type: 'control_battlefield';
      battlefieldId?: BattlefieldId;
      mode: 'gain' | 'contest' | 'lose';
      forPlayer?: PlayerId;
    }
  | {
      type: 'scoring';
      player?: PlayerId;
      battlefieldId?: BattlefieldId | null;
      reason: 'conquer' | 'hold' | 'effect';
      amount?: number;
    }
  | {
      type: 'attach_gear';
      gearInstance?: InstanceId;
      target?: InstanceId;
      reason?: 'equip_activation' | 'weaponmaster' | 'quickdraw' | 'card_effect';
      detachFromPrior?: InstanceId;
    }
  | {
      type: 'move_unit';
      unit?: InstanceId;
      to?: Location;
      reason?: 'standard_move' | 'ganking' | 'card_effect' | 'combat_cleanup';
      batchId?: string;
    }
  | {
      type: 'channel_rune';
      player?: PlayerId;
      count?: number;
      enteredExhausted?: boolean;
    }
  | {
      type: 'gain_resource';
      player?: PlayerId;
      kind?: 'energy' | 'power';
      domain?: Domain | 'universal';
      amount?: number;
      synchronous?: boolean;
    }
  | {
      type: 'manipulate_priority';
      variant?: PriorityVariant;
      targetPlayer?: PlayerId;
      windowScope?: 'this_chain' | 'this_showdown' | 'this_turn';
    }
  | {
      type: 'modify_stats';
      amount?: number;
      enemy?: boolean;
    }
  | {
      type: 'combat_bonus';
      amount?: number;
      enemy?: boolean;
    }
  | {
      type: 'draw_cards';
      player?: PlayerId;
      count?: number;
    }
  | {
      type: 'recycle_card';
      player?: PlayerId;
      count?: number;
    }
  | {
      type: 'remove_permanent';
    }
  | {
      type: 'deal_damage';
      amount?: number;
    }
  | {
      type: 'stun';
    }
  | {
      type: 'ready';
      count?: number;
    }
  | {
      type: 'create_token';
    }
  // Trigger registration ops (no state mutation; see triggers.ts)
  | { type: 'on_play_trigger' }
  | { type: 'equip_trigger' }
  | { type: 'conquer_trigger' }
  | { type: 'combat_trigger' }
  | { type: 'death_trigger' }
  // Keyword markers handled by read-through layers (combat, cost, hidden pipelines)
  | { type: 'keyword_hidden' }
  | { type: 'keyword_ganking' }
  | { type: 'keyword_accelerate' }
  | { type: 'keyword_deflect' };

export type EffectOp = RiftboundOp | { type: string; [k: string]: unknown };

// ---------------------------------------------------------------------------
// Engine context (adapter)
// ---------------------------------------------------------------------------

/**
 * EngineAdapter is the narrow surface a handler uses to drive the existing
 * `RiftboundGameEngine`. Keeping the adapter small makes handlers easy to
 * reason about and lets us swap in a fake in tests once QA catches up.
 *
 * Handlers receive this via EngineCtx.engine. The engine itself owns all
 * mutation; handlers describe intent via adapter calls + OpResult.
 */
export interface EngineAdapter {
  getOtherPlayer(player: PlayerState): PlayerState;
  drawCards(player: PlayerState, count: number, required: boolean): void;
  recycleTopOfGraveyard(player: PlayerState, count: number): number;
  applyTemporaryEffect(
    instanceId: string,
    effect: {
      id: string;
      affectedCards?: string[];
      duration: number;
      effect: {
        type:
          | 'damage_boost'
          | 'toughness_boost'
          | 'grant_ability'
          | 'prevent_damage'
          | 'draw_card';
        value?: number;
      };
    }
  ): void;
  damageCreature(target: BoardCard, amount: number, source?: Card): void;
  ensureDamageableTarget(target: BoardCard | undefined, source: Card): BoardCard;
  findCardInstance(instanceId: string): BoardCard | undefined;
  channelRunes(player: PlayerState, amount: number, opts?: { tapped?: boolean }): number;
  exhaustRunes(player: PlayerState, amount: number): void;
  logRuneChange(
    player: PlayerState,
    amount: number,
    opts: {
      direction: 'channel' | 'exhaust';
      exhausted?: boolean;
      context: EngineCtx['operationContext'];
    }
  ): void;
  logRuleUsage(card: Card | undefined, reason: string): void;
  applyBattlefieldControl(
    player: PlayerState,
    battlefield: BattlefieldState,
    reason:
      | 'combat'
      | 'objective'
      | 'support'
      | 'decking'
      | 'concede'
      | 'timeout'
      | 'hold'
      | 'burn_out',
    options?: { points?: number; sourceCardId?: string; initiatedAttack?: boolean }
  ): void;
  resolveBattlefieldTargetForControl(
    player: PlayerState,
    target?: BattlefieldState
  ): BattlefieldState | undefined;
  getTokenSpec(operation: EffectOperation, source: Card): unknown;
  spawnTokenUnits(
    player: PlayerState,
    tokenSpec: unknown,
    context: EngineCtx['operationContext']
  ): void;
  getPlayerByCard(instanceId: string): PlayerState;
  moveUnitToBattlefield(
    owner: PlayerState,
    unit: BoardCard,
    battlefield: BattlefieldState
  ): void;
  moveUnitToBase(owner: PlayerState, unit: BoardCard): void;
  openPriorityWindow(
    type: 'main' | 'reaction' | 'showdown' | 'combat',
    holder: string,
    event: string
  ): void;
  getCurrentPhase(): string;
  setFocusPlayerId(playerId: string | null): void;
  addDuelLogEntry(entry: {
    playerId?: string | null;
    message: string;
    tone: 'info' | 'success' | 'warning' | 'error';
  }): void;
  resolvePlayerName(playerId: string): string | null;
}

/**
 * EngineCtx passed into every handler. For Phase 2b we funnel the existing
 * call shape through here unchanged; a later phase will decouple fully per
 * spec section 12.
 */
export interface EngineCtx {
  engine: EngineAdapter;
  caster: PlayerState;
  operationContext: OperationContext;
}

export interface OperationContext {
  source: Card;
  boardTarget?: BoardCard;
  playerTarget?: PlayerState;
  battlefieldTarget?: BattlefieldState;
  abilityName?: string | null;
  triggerType?: string | null;
  targets?: string[] | null;
}

// ---------------------------------------------------------------------------
// Handler contract (spec section 12)
// ---------------------------------------------------------------------------

export interface ValidationResult {
  ok: boolean;
  reason?: string;
  substituteOp?: EffectOp;
  /**
   * Per spec 315.3.b.1: when a request cannot be fully satisfied, validate
   * may clamp to the effective value. Consumers should use this when
   * present instead of the requested count on the op.
   */
  effectiveCount?: number;
}

export interface Patch {
  op: 'add' | 'remove' | 'replace';
  path: string;
  value?: unknown;
}

export interface LogEntry {
  tick: number;
  kind: string;
  payload: unknown;
}

export interface TriggerFire {
  triggerType: string;
  sourceInstanceId: string;
  sourceController: PlayerId;
  eventSnapshot: { kind: string; payload: Record<string, unknown> };
}

export interface OpResult {
  patches: Patch[];
  triggeredAbilities: TriggerFire[];
  log: LogEntry[];
  // Optional short-circuit for handlers that defer (e.g. target selection
  // prompt the engine already manages). When true, the dispatcher stops the
  // current operation-stream loop and lets the engine resume later.
  defer?: boolean;
}

export interface OpHandler<TOp extends { type: string } = EffectOp> {
  op: TOp['type'];
  validate?(ctx: EngineCtx, op: TOp, source: Card): ValidationResult;
  execute(ctx: EngineCtx, op: TOp, source: Card): OpResult;
}

// ---------------------------------------------------------------------------
// Small helpers used by handlers
// ---------------------------------------------------------------------------

export const emptyResult = (): OpResult => ({
  patches: [],
  triggeredAbilities: [],
  log: []
});

export const logOnlyResult = (kind: string, payload: unknown): OpResult => ({
  patches: [],
  triggeredAbilities: [],
  log: [{ tick: 0, kind, payload }]
});
