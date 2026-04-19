import type { EffectOperation } from '../../card-catalog';
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

interface ChannelRuneOp {
  type: 'channel_rune';
  player?: string;
  count?: number;
  enteredExhausted?: boolean;
  predicate?: { domain?: string };
}

interface GainResourceOp {
  type: 'gain_resource';
  player?: string;
  kind?: 'energy' | 'power';
  domain?: string;
  amount?: number;
  synchronous?: boolean;
}

interface PatchCtxCard {
  instanceId: string;
  state?: { exhausted?: boolean; [k: string]: unknown };
  zone?: string;
  [k: string]: unknown;
}

interface PatchCtxShape {
  zones?: {
    runeDecks?: Record<string, PatchCtxCard[]>;
    runesOnBoard?: Record<string, PatchCtxCard[]>;
  };
  players?: Array<{ playerId: string; runePool?: { energy: number; power: Record<string, number> } }>;
}

/**
 * channel_rune - Rule 430. Moves top N runes from the Rune Deck onto the
 * Board. Enters exhausted if `enteredExhausted` is true (rule 430.2).
 */
export const channelRuneHandler: OpHandler<{ type: 'channel_rune' }> = {
  op: 'channel_rune',
  validate(ctx: EngineCtx, _op): ValidationResult {
    const op = _op as unknown as ChannelRuneOp;
    if (ctx.engine && typeof ctx.engine.channelRunes === 'function') return { ok: true };
    const player = op.player ?? 'p1';
    const shape = ctx as unknown as PatchCtxShape;
    const deckLen = shape.zones?.runeDecks?.[player]?.length ?? 0;
    const requested = Math.max(0, op.count ?? 0);
    if (requested > deckLen) {
      return { ok: true, effectiveCount: deckLen };
    }
    return { ok: true, effectiveCount: requested };
  },
  execute(ctx: EngineCtx, _op): OpResult {
    const op = _op as unknown as ChannelRuneOp;

    // Engine adapter path (legacy).
    if (ctx.engine?.channelRunes && ctx.caster) {
      const operation = _op as unknown as EffectOperation;
      const recipient = operation.targetHint === 'enemy'
        ? ctx.engine.getOtherPlayer(ctx.caster)
        : ctx.caster;
      const amount = Math.max(1, operation.magnitudeHint ?? 1);
      const enterTapped =
        typeof operation.metadata === 'object' && operation.metadata
          ? Boolean((operation.metadata as { enterTapped?: boolean }).enterTapped)
          : false;
      ctx.engine.channelRunes(recipient, amount, { tapped: enterTapped });
      ctx.engine.logRuneChange?.(recipient, amount, {
        direction: 'channel',
        exhausted: enterTapped,
        context: ctx.operationContext as never
      });
      return emptyResult();
    }

    // Patch-only path.
    const patches: Patch[] = [];
    const triggered: TriggerFire[] = [];
    const log: LogEntry[] = [];
    const player = op.player ?? 'p1';
    const requested = Math.max(0, op.count ?? 0);
    const shape = ctx as unknown as PatchCtxShape;
    const deck = shape.zones?.runeDecks?.[player] ?? [];
    const n = Math.min(requested, deck.length);
    if (n === 0) return { patches, triggeredAbilities: triggered, log };

    const runesToMove = deck.slice(0, n).map((r) => ({
      ...r,
      zone: 'board',
      state: { ...(r.state ?? {}), exhausted: Boolean(op.enteredExhausted) }
    }));

    // Remove from deck.
    for (let i = 0; i < n; i += 1) {
      patches.push({ op: 'remove', path: `/zones/runeDecks/${player}/0` });
    }
    // Add to runesOnBoard.
    for (const rune of runesToMove) {
      patches.push({
        op: 'add',
        path: `/zones/runesOnBoard/${player}/-`,
        value: rune
      });
    }

    // Fire on_channel per rune.
    for (const rune of runesToMove) {
      triggered.push({
        triggerType: 'on_channel',
        sourceInstanceId: rune.instanceId,
        sourceController: player,
        eventSnapshot: {
          kind: 'on_channel',
          payload: { player, instanceId: rune.instanceId, enteredExhausted: Boolean(op.enteredExhausted) }
        }
      });
    }
    log.push({ tick: 0, kind: 'channel_rune_applied', payload: { player, count: n } });
    return { patches, triggeredAbilities: triggered, log };
  }
};

/**
 * gain_resource - Rule 429 Add action. Patch path increments the player's
 * runePool directly. Typed power variants require a domain.
 */
export const gainResourceHandler: OpHandler<{ type: 'gain_resource' }> = {
  op: 'gain_resource',
  validate(ctx: EngineCtx, _op): ValidationResult {
    const op = _op as unknown as GainResourceOp;

    // Adapter path: preserve legacy validate (always ok).
    if (ctx.engine && typeof ctx.engine.channelRunes === 'function') return { ok: true };

    if (op.kind === 'power' && !op.domain) {
      return { ok: false, reason: 'power_requires_domain' };
    }
    return { ok: true };
  },
  execute(ctx: EngineCtx, _op): OpResult {
    const op = _op as unknown as GainResourceOp;

    // Engine adapter path (legacy).
    if (ctx.engine?.channelRunes && ctx.caster) {
      const operation = _op as unknown as EffectOperation;
      const recipient = operation.targetHint === 'enemy'
        ? ctx.engine.getOtherPlayer(ctx.caster)
        : ctx.caster;
      const amount = operation.magnitudeHint ?? 1;
      if (amount > 0) {
        const normalized = Math.max(1, Math.round(amount));
        ctx.engine.channelRunes?.(recipient, normalized);
        ctx.engine.logRuneChange?.(recipient, normalized, {
          direction: 'channel',
          exhausted: false,
          context: ctx.operationContext as never
        });
      } else if (amount < 0) {
        const normalized = Math.max(1, Math.round(Math.abs(amount)));
        ctx.engine.exhaustRunes?.(recipient, normalized);
        ctx.engine.logRuneChange?.(recipient, normalized, {
          direction: 'exhaust',
          context: ctx.operationContext as never
        });
      }
      return emptyResult();
    }

    // Patch-only path.
    const patches: Patch[] = [];
    const log: LogEntry[] = [];
    const player = op.player ?? 'p1';
    const amount = op.amount ?? 0;
    if (amount === 0) return emptyResult();

    const shape = ctx as unknown as PatchCtxShape;
    const idx = (shape.players ?? []).findIndex((p) => p.playerId === player);
    if (idx < 0) return emptyResult();
    const playerState = shape.players![idx]!;

    if (op.kind === 'power') {
      const domain = op.domain ?? 'universal';
      const current = playerState.runePool?.power?.[domain] ?? 0;
      patches.push({
        op: 'replace',
        path: `/players/${idx}/runePool/power/${domain}`,
        value: current + amount
      });
    } else {
      const current = playerState.runePool?.energy ?? 0;
      patches.push({
        op: 'replace',
        path: `/players/${idx}/runePool/energy`,
        value: current + amount
      });
    }
    log.push({ tick: 0, kind: 'gain_resource_applied', payload: { player, kind: op.kind ?? 'energy', amount } });
    return { patches, triggeredAbilities: [], log };
  }
};

/**
 * rune_resource - Classification-only marker per spec 16.5. The catalog
 * loader strips these at boot, but if one leaks through, we no-op with a
 * diagnostic log entry.
 */
export const runeResourceHandler: OpHandler<{ type: 'rune_resource' }> = {
  op: 'rune_resource',
  execute(_ctx: EngineCtx, op: { type: 'rune_resource' }): OpResult {
    return {
      patches: [],
      triggeredAbilities: [],
      log: [
        {
          tick: 0,
          kind: 'rune_resource_classification_strip_warning',
          payload: { op }
        }
      ]
    };
  }
};
