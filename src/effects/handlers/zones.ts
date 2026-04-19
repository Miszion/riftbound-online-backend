import type { BoardCard } from '../../game-engine';
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
import { deterministicIdSuffix } from './_rng';

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
  isToken?: boolean;
  zone?: string;
  state?: Record<string, unknown>;
  attachments?: { attachedTo?: string; topMostAttachments?: string[] };
  [k: string]: unknown;
}

interface PatchCtxShape {
  zones?: {
    board?: {
      bases?: Record<string, { presentUnits?: string[]; presentGear?: string[] } & Record<string, unknown>>;
      battlefields?: Record<
        string,
        { presentUnits?: string[]; attachedGear?: string[] } & Record<string, unknown>
      >;
    };
    hands?: Record<string, PatchCtxUnit[]>;
    trashes?: Record<string, PatchCtxUnit[]>;
    banishments?: Record<string, PatchCtxUnit[]>;
    mainDecks?: Record<string, PatchCtxUnit[]>;
  };
  units?: Record<string, PatchCtxUnit>;
  temporaryMods?: Array<{ appliedTo?: string; [k: string]: unknown }>;
  turnPlayerId?: string;
}

/**
 * Find a unit in the test-shape EngineCtx. Returns the shape's discovered
 * location (base/battlefield), plus the full instance record if available
 * via ctx.units.
 */
function locateUnit(
  ctx: EngineCtx,
  instanceId: string
): {
  unit: PatchCtxUnit | null;
  location:
    | { kind: 'base'; player: string }
    | { kind: 'battlefield'; battlefieldId: string }
    | null;
  indexInArray: number;
} {
  const shape = ctx as unknown as PatchCtxShape;
  const units = shape.units ?? {};
  const direct = units[instanceId] ?? null;
  const bases = shape.zones?.board?.bases ?? {};
  for (const [playerId, base] of Object.entries(bases)) {
    const idx = base?.presentUnits?.indexOf(instanceId) ?? -1;
    if (idx >= 0) {
      return { unit: direct, location: { kind: 'base', player: playerId }, indexInArray: idx };
    }
  }
  const battlefields = shape.zones?.board?.battlefields ?? {};
  for (const [bfId, bf] of Object.entries(battlefields)) {
    const idx = bf?.presentUnits?.indexOf(instanceId) ?? -1;
    if (idx >= 0) {
      return {
        unit: direct,
        location: { kind: 'battlefield', battlefieldId: bfId },
        indexInArray: idx
      };
    }
  }
  return { unit: direct, location: null, indexInArray: -1 };
}

function findCardInArray(arr: PatchCtxUnit[] | undefined, instanceId: string): number {
  if (!arr) return -1;
  return arr.findIndex((c) => c?.instanceId === instanceId);
}

// ---------------------------------------------------------------------------
// remove_permanent: kill / banish / return_to_hand
// ---------------------------------------------------------------------------

interface RemovePermanentOp {
  type: 'remove_permanent';
  target?: string;
  mode?: 'kill' | 'banish' | 'return_to_hand';
}

export const removePermanentHandler: OpHandler<{ type: 'remove_permanent' }> = {
  op: 'remove_permanent',
  execute(ctx: EngineCtx, _op, source): OpResult {
    const op = _op as unknown as RemovePermanentOp;

    // Patch-only path (no adapter).
    if (!ctx.engine?.damageCreature) {
      const patches: Patch[] = [];
      const triggered: TriggerFire[] = [];
      const log: LogEntry[] = [];
      const targetId = op.target;
      if (!targetId) return emptyResult();

      const { unit, location, indexInArray } = locateUnit(ctx, targetId);
      if (!location) {
        return emptyResult();
      }

      const owner = unit?.owner ?? (location.kind === 'base' ? location.player : 'p1');
      const controller = unit?.controller ?? owner;
      const isToken = unit?.isToken === true;

      // Step 1: remove from current presence array.
      const presencePath =
        location.kind === 'base'
          ? `/zones/board/bases/${location.player}/presentUnits/${indexInArray}`
          : `/zones/board/battlefields/${location.battlefieldId}/presentUnits/${indexInArray}`;
      patches.push({ op: 'remove', path: presencePath });

      // Step 2: add to destination zone (unless token + kill/banish: ceases to exist).
      const mode = op.mode ?? 'kill';
      const destinationInstance: PatchCtxUnit = unit
        ? { ...unit, zone: mode === 'kill' ? 'trash' : mode === 'banish' ? 'banishment' : 'hand' }
        : { instanceId: targetId, owner, controller };

      if (isToken && (mode === 'kill' || mode === 'banish')) {
        // Rule 183.1: tokens cease to exist on leaving the Board.
        log.push({ tick: 0, kind: 'token_deleted', payload: { target: targetId, mode } });
      } else if (mode === 'kill') {
        patches.push({
          op: 'add',
          path: `/zones/trashes/${owner}/-`,
          value: destinationInstance
        });
      } else if (mode === 'banish') {
        patches.push({
          op: 'add',
          path: `/zones/banishments/${owner}/-`,
          value: destinationInstance
        });
      } else if (mode === 'return_to_hand') {
        patches.push({
          op: 'add',
          path: `/zones/hands/${owner}/-`,
          value: destinationInstance
        });
      }

      // Step 3: clear temporary mods attributed to this unit (rule 110:
      // crossing a non-board boundary drops temp mods).
      const shape = ctx as unknown as PatchCtxShape;
      const mods = shape.temporaryMods ?? [];
      const toRemove: number[] = [];
      for (let i = 0; i < mods.length; i += 1) {
        if (mods[i]?.appliedTo === targetId) toRemove.push(i);
      }
      // Remove highest indices first so later indices stay valid.
      toRemove.sort((a, b) => b - a);
      for (const idx of toRemove) {
        patches.push({ op: 'remove', path: `/temporaryMods/${idx}` });
      }

      // Step 4: fire triggers per mode.
      const sourceInstanceId =
        (source as unknown as { instanceId?: string; id?: string })?.instanceId ??
        (source as unknown as { id?: string })?.id ??
        targetId;
      if (mode === 'kill') {
        triggered.push({
          triggerType: 'on_kill',
          sourceInstanceId,
          sourceController: controller,
          eventSnapshot: {
            kind: 'on_kill',
            payload: {
              killedInstanceId: targetId,
              lastKnownLocation: location,
              lastKnownController: controller
            }
          }
        });
        log.push({ tick: 0, kind: 'remove_permanent_kill', payload: { target: targetId } });
      } else if (mode === 'banish') {
        log.push({ tick: 0, kind: 'banish_applied', payload: { target: targetId } });
      } else {
        log.push({ tick: 0, kind: 'return_to_hand_applied', payload: { target: targetId } });
      }

      return { patches, triggeredAbilities: triggered, log };
    }

    // Adapter path: legacy behavior (damage-to-toughness routes through
    // the kill/deathknell pipeline).
    const targets = resolveBoardTargets(ctx);
    if (targets.length === 0 && ctx.operationContext?.boardTarget) {
      // Re-validate the fallback boardTarget via findCardInstance so a
      // stale reference to a unit that was already destroyed (for example
      // by a preceding op in the same operation list that killed a token,
      // or by a chained trigger) no longer reaches damageCreature ->
      // destroyUnit -> getPlayerByCard, which throws
      // "Card instance <id> not found". This is the phase-5c bot-match
      // regression gate's surfaced failure mode.
      const fallback = ctx.operationContext.boardTarget;
      const stillOnBoard = ctx.engine?.findCardInstance?.(fallback.instanceId);
      if (stillOnBoard) {
        targets.push(stillOnBoard);
      }
    }
    for (const target of targets) {
      // SFD-186 (Spinning Axe) is itself a Gear whose operation list ends
      // up reaching remove_permanent with the gear as the fallback
      // boardTarget. damageCreature rejects non-creature targets with a
      // throw; skip gear so sibling attach/equip ops still resolve. Units
      // still route through the damage-to-toughness pipeline as before.
      if (target.type !== CardType.CREATURE) continue;
      // Re-validate per-target: a prior iteration's damageCreature call
      // can chain into deathknell triggers that in turn kill later targets
      // in this same loop. Once the unit has left the board,
      // damageCreature -> destroyUnit -> getPlayerByCard throws. Skip
      // targets that are no longer findable so the operation list resolves
      // cleanly.
      if (!ctx.engine?.findCardInstance?.(target.instanceId)) continue;
      ctx.engine.damageCreature(target, target.currentToughness, source);
    }
    return emptyResult();
  }
};

// ---------------------------------------------------------------------------
// recycle_card: move a card from hand/trash to bottom of deck
// ---------------------------------------------------------------------------

interface RecycleCardOp {
  type: 'recycle_card';
  target?: string;
  destination?: 'main-deck' | 'rune-deck';
}

export const recycleCardHandler: OpHandler<{ type: 'recycle_card' }> = {
  op: 'recycle_card',
  execute(ctx: EngineCtx, _op, source): OpResult {
    const op = _op as unknown as RecycleCardOp;

    // Patch-only path.
    if (!ctx.engine?.recycleTopOfGraveyard) {
      const patches: Patch[] = [];
      const triggered: TriggerFire[] = [];
      const log: LogEntry[] = [];
      const targetId = op.target;
      if (!targetId) return emptyResult();

      const shape = ctx as unknown as PatchCtxShape;
      const trashes = shape.zones?.trashes ?? {};
      const hands = shape.zones?.hands ?? {};

      let owner: string | null = null;
      let sourceZoneKey: 'trashes' | 'hands' | null = null;
      let sourceIndex = -1;
      let instance: PatchCtxUnit | null = null;

      for (const [playerId, arr] of Object.entries(trashes)) {
        const idx = findCardInArray(arr, targetId);
        if (idx >= 0) {
          owner = playerId;
          sourceZoneKey = 'trashes';
          sourceIndex = idx;
          instance = arr![idx]!;
          break;
        }
      }
      if (!owner) {
        for (const [playerId, arr] of Object.entries(hands)) {
          const idx = findCardInArray(arr, targetId);
          if (idx >= 0) {
            owner = playerId;
            sourceZoneKey = 'hands';
            sourceIndex = idx;
            instance = arr![idx]!;
            break;
          }
        }
      }

      if (!owner || !instance || sourceZoneKey === null) {
        return emptyResult();
      }

      const destKey = op.destination === 'rune-deck' ? 'runeDecks' : 'mainDecks';

      // Remove from source zone.
      patches.push({
        op: 'remove',
        path: `/zones/${sourceZoneKey}/${owner}/${sourceIndex}`
      });
      // Append to bottom of deck with updated zone marker.
      patches.push({
        op: 'add',
        path: `/zones/${destKey}/${owner}/-`,
        value: { ...instance, zone: op.destination === 'rune-deck' ? 'rune-deck' : 'main-deck' }
      });

      const sourceInstanceId =
        (source as unknown as { instanceId?: string; id?: string })?.instanceId ??
        (source as unknown as { id?: string })?.id ??
        targetId;
      triggered.push({
        triggerType: 'on_recycle',
        sourceInstanceId,
        sourceController: owner,
        eventSnapshot: {
          kind: 'on_recycle',
          payload: { target: targetId, destination: op.destination ?? 'main-deck' }
        }
      });
      log.push({ tick: 0, kind: 'recycle_card_applied', payload: { target: targetId, destination: op.destination } });

      return { patches, triggeredAbilities: triggered, log };
    }

    // Adapter path.
    const operation = _op as unknown as { magnitudeHint?: number; targetHint?: string };
    const iterations = Math.max(1, operation.magnitudeHint ?? 1);
    const targetPlayer = operation.targetHint === 'enemy'
      ? ctx.engine.getOtherPlayer(ctx.caster)
      : ctx.caster;
    ctx.engine.recycleTopOfGraveyard(targetPlayer, iterations);
    ctx.engine.logRuleUsage?.(source, 'recycle_card');
    return emptyResult();
  }
};

// ---------------------------------------------------------------------------
// return_to_hand: shortcut op that routes through remove_permanent semantics.
// ---------------------------------------------------------------------------

interface ReturnToHandOp {
  type: 'return_to_hand';
  target?: string;
}

/**
 * return_to_hand - Rule 438 bounce shortcut. Delegates to the same state
 * machine as remove_permanent(mode=return_to_hand) so temp mods get
 * cleared consistently.
 */
export const returnToHandHandler: OpHandler<{ type: 'return_to_hand' }> = {
  op: 'return_to_hand',
  execute(ctx: EngineCtx, _op, source): OpResult {
    const op = _op as unknown as ReturnToHandOp;
    return removePermanentHandler.execute(
      ctx,
      { type: 'remove_permanent', target: op.target, mode: 'return_to_hand' } as never,
      source as never
    );
  }
};

// ---------------------------------------------------------------------------
// return_from_graveyard: move a card from trash back to hand or board.
// ---------------------------------------------------------------------------

interface ReturnFromGraveyardOp {
  type: 'return_from_graveyard';
  target?: string;
  destination?: 'hand' | 'board';
  toLocation?:
    | { kind: 'base'; player: string }
    | { kind: 'battlefield'; battlefieldId: string };
}

export const returnFromGraveyardHandler: OpHandler<{ type: 'return_from_graveyard' }> = {
  op: 'return_from_graveyard',
  execute(ctx: EngineCtx, _op, source): OpResult {
    const op = _op as unknown as ReturnFromGraveyardOp;
    const patches: Patch[] = [];
    const triggered: TriggerFire[] = [];
    const log: LogEntry[] = [];
    const targetId = op.target;
    if (!targetId) return emptyResult();

    const shape = ctx as unknown as PatchCtxShape;
    const trashes = shape.zones?.trashes ?? {};
    let owner: string | null = null;
    let trashIdx = -1;
    let instance: PatchCtxUnit | null = null;
    for (const [playerId, arr] of Object.entries(trashes)) {
      const idx = findCardInArray(arr, targetId);
      if (idx >= 0) {
        owner = playerId;
        trashIdx = idx;
        instance = arr![idx]!;
        break;
      }
    }
    if (!owner || !instance) return emptyResult();

    patches.push({ op: 'remove', path: `/zones/trashes/${owner}/${trashIdx}` });

    const destination = op.destination ?? 'hand';
    if (destination === 'hand') {
      patches.push({
        op: 'add',
        path: `/zones/hands/${owner}/-`,
        value: { ...instance, zone: 'hand' }
      });
      log.push({ tick: 0, kind: 'return_from_graveyard_to_hand', payload: { target: targetId, owner } });
    } else {
      const loc = op.toLocation ?? { kind: 'base', player: owner };
      const boardPath =
        loc.kind === 'base'
          ? `/zones/board/bases/${loc.player}/presentUnits/-`
          : `/zones/board/battlefields/${loc.battlefieldId}/presentUnits/-`;
      patches.push({ op: 'add', path: boardPath, value: targetId });
      patches.push({
        op: 'add',
        path: `/units/${targetId}`,
        value: { ...instance, zone: 'board', location: loc }
      });
      const sourceInstanceId =
        (source as unknown as { instanceId?: string; id?: string })?.instanceId ??
        (source as unknown as { id?: string })?.id ??
        targetId;
      triggered.push({
        triggerType: 'on_play',
        sourceInstanceId,
        sourceController: owner,
        eventSnapshot: {
          kind: 'on_play',
          payload: { instanceId: targetId, fromZone: 'trash', location: loc }
        }
      });
      log.push({ tick: 0, kind: 'return_from_graveyard_to_board', payload: { target: targetId, owner, location: loc } });
    }

    return { patches, triggeredAbilities: triggered, log };
  }
};

// ---------------------------------------------------------------------------
// discard_cards: move N cards from hand to trash.
// ---------------------------------------------------------------------------

interface DiscardCardsOp {
  type: 'discard_cards';
  player?: string;
  count?: number;
  targets?: string[];
}

export const discardCardsHandler: OpHandler<{ type: 'discard_cards' }> = {
  op: 'discard_cards',
  execute(ctx: EngineCtx, _op, source): OpResult {
    const op = _op as unknown as DiscardCardsOp;
    const operation = _op as unknown as {
      targetHint?: 'self' | 'enemy';
      magnitudeHint?: number;
    };

    // Engine adapter path: mutate PlayerState.hand/graveyard directly so the
    // legacy RiftboundGameEngine reflects the discard. Handlers rooted in
    // the patch-only path never mutated real engine state, which regressed
    // the discard_cards regression suites (caster and opponent-target
    // variants). The adapter path mirrors the rules-compliant semantics:
    //  - targetHint='enemy' discards from the opponent's hand
    //  - default ('self' or absent) discards from the caster's hand
    //  - magnitudeHint clamps to [1..hand.length]
    // Cards removed go to the player's graveyard in hand-order (top first)
    // unless an explicit targets list picks them by card id.
    if (ctx.engine && ctx.caster) {
      const targetPlayer =
        operation.targetHint === 'enemy'
          ? ctx.engine.getOtherPlayer(ctx.caster)
          : ctx.caster;
      const rawCount = typeof operation.magnitudeHint === 'number'
        ? operation.magnitudeHint
        : Math.max(0, op.count ?? 1);
      const count = Math.max(0, rawCount);
      if (count === 0 || targetPlayer.hand.length === 0) {
        return emptyResult();
      }

      // Prefer explicit targets (matched by id), else take from top of hand.
      const indices: number[] = [];
      if (op.targets && op.targets.length > 0) {
        for (const id of op.targets) {
          const idx = targetPlayer.hand.findIndex(
            (c) => (c as unknown as { instanceId?: string }).instanceId === id || c.id === id
          );
          if (idx >= 0 && !indices.includes(idx)) indices.push(idx);
        }
      } else {
        const n = Math.min(count, targetPlayer.hand.length);
        for (let i = 0; i < n; i += 1) indices.push(i);
      }
      if (indices.length === 0) return emptyResult();
      // Splice highest first so lower indices stay valid.
      const sortedDesc = [...indices].sort((a, b) => b - a);
      const discarded: typeof targetPlayer.hand = [];
      for (const idx of sortedDesc) {
        const [card] = targetPlayer.hand.splice(idx, 1);
        if (card) discarded.push(card);
      }
      // Graveyard gets discards in original-order for log readability.
      discarded.reverse();
      targetPlayer.graveyard.push(...discarded);
      ctx.engine.logRuleUsage?.(source as never, 'discard_cards');
      return emptyResult();
    }

    const patches: Patch[] = [];
    const triggered: TriggerFire[] = [];
    const log: LogEntry[] = [];

    const shape = ctx as unknown as PatchCtxShape;
    const player = op.player ?? ((ctx as unknown as { turnPlayerId?: string }).turnPlayerId ?? 'p1');
    const hand = shape.zones?.hands?.[player] ?? [];
    const count = Math.max(0, op.count ?? 1);
    if (count === 0 || hand.length === 0) return emptyResult();

    // Decide which indices to discard. If explicit targets, match by id;
    // otherwise take from the top of hand (leftmost).
    const indices: number[] = [];
    if (op.targets && op.targets.length > 0) {
      for (const id of op.targets) {
        const idx = hand.findIndex((c) => c.instanceId === id);
        if (idx >= 0 && !indices.includes(idx)) indices.push(idx);
      }
    } else {
      const n = Math.min(count, hand.length);
      for (let i = 0; i < n; i += 1) indices.push(i);
    }
    if (indices.length === 0) return emptyResult();

    const toMove: PatchCtxUnit[] = indices.map((i) => hand[i]!).filter(Boolean);
    // Remove highest index first so lower indices stay valid during patch apply.
    const sortedDesc = [...indices].sort((a, b) => b - a);
    for (const idx of sortedDesc) {
      patches.push({ op: 'remove', path: `/zones/hands/${player}/${idx}` });
    }
    for (const card of toMove) {
      patches.push({
        op: 'add',
        path: `/zones/trashes/${player}/-`,
        value: { ...card, zone: 'trash' }
      });
    }

    const sourceInstanceId =
      (source as unknown as { instanceId?: string; id?: string })?.instanceId ??
      (source as unknown as { id?: string })?.id ??
      '';
    for (const card of toMove) {
      triggered.push({
        triggerType: 'on_discard',
        sourceInstanceId,
        sourceController: player,
        eventSnapshot: {
          kind: 'on_discard',
          payload: { player, instanceId: card.instanceId }
        }
      });
    }
    log.push({ tick: 0, kind: 'discard_cards_applied', payload: { player, count: toMove.length } });
    return { patches, triggeredAbilities: triggered, log };
  }
};

// ---------------------------------------------------------------------------
// summon_unit: materialize a unit onto the board (token-like but from a
// concrete cardId rather than a TokenSpec).
// ---------------------------------------------------------------------------

interface SummonUnitOp {
  type: 'summon_unit';
  player?: string;
  cardId?: string;
  instanceId?: string;
  location?:
    | { kind: 'base'; player: string }
    | { kind: 'battlefield'; battlefieldId: string };
  enteredExhausted?: boolean;
  might?: number;
}

let summonCounter = 0;
function nextSummonId(ctx: EngineCtx): string {
  summonCounter += 1;
  return `summon-${summonCounter}-${Date.now()}-${deterministicIdSuffix(ctx, 'summon')}`;
}

export const summonUnitHandler: OpHandler<{ type: 'summon_unit' }> = {
  op: 'summon_unit',
  execute(ctx: EngineCtx, _op, source): OpResult {
    const op = _op as unknown as SummonUnitOp;
    const patches: Patch[] = [];
    const triggered: TriggerFire[] = [];
    const log: LogEntry[] = [];

    const player = op.player ?? ctx.caster?.playerId ?? 'p1';
    const location = op.location ?? { kind: 'base' as const, player };
    const instanceId = op.instanceId ?? nextSummonId(ctx);
    const cardId = op.cardId ?? (source as unknown as { id?: string })?.id ?? null;

    const unit: Record<string, unknown> = {
      instanceId,
      cardId,
      owner: player,
      controller: player,
      zone: 'board',
      location,
      cardType: 'Unit',
      might: typeof op.might === 'number' ? op.might : 2,
      state: {
        exhausted: Boolean(op.enteredExhausted),
        damage: 0,
        hasBuffCounter: false,
        facedown: false,
        stunned: false
      },
      attachments: { topMostAttachments: [] },
      grantedKeywords: [],
      temporaryMightMod: 0
    };

    if (location.kind === 'base') {
      patches.push({
        op: 'add',
        path: `/zones/board/bases/${location.player}/presentUnits/-`,
        value: instanceId
      });
    } else {
      patches.push({
        op: 'add',
        path: `/zones/board/battlefields/${location.battlefieldId}/presentUnits/-`,
        value: instanceId
      });
    }
    patches.push({ op: 'add', path: `/units/${instanceId}`, value: unit });

    triggered.push({
      triggerType: 'on_play',
      sourceInstanceId: instanceId,
      sourceController: player,
      eventSnapshot: {
        kind: 'on_play',
        payload: { instanceId, cardId, player, location, summoned: true }
      }
    });
    log.push({ tick: 0, kind: 'summon_unit_applied', payload: { instanceId, cardId, player, location } });
    return { patches, triggeredAbilities: triggered, log };
  }
};
