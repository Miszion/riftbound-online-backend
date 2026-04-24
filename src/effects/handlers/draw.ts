import type { EffectOperation } from '../../card-catalog';
import type {
  EngineCtx,
  LogEntry,
  OpHandler,
  OpResult,
  Patch,
  TriggerFire
} from '../types';
import { emptyResult } from '../types';

interface DrawCardsOp {
  type: 'draw_cards';
  player?: string;
  count?: number;
}

interface PatchCtxCard {
  instanceId: string;
  owner?: string;
  zone?: string;
  [k: string]: unknown;
}

interface PatchCtxShape {
  zones?: {
    mainDecks?: Record<string, PatchCtxCard[]>;
    hands?: Record<string, PatchCtxCard[]>;
    trashes?: Record<string, PatchCtxCard[]>;
  };
  players?: Array<{ playerId: string; points?: number }>;
  turnPlayerId?: string;
  rng?: { seed: string; cursor: number };
}

/**
 * Deterministic PRNG (mulberry32) seeded from string. Shared usage sites
 * keep the same mix so a given seed always yields the same sequence.
 */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(seed: string, cursor: number): number {
  let h = 2166136261 >>> 0;
  const mixed = `${seed}:${cursor}`;
  for (let i = 0; i < mixed.length; i += 1) {
    h = Math.imul(h ^ mixed.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }
  return copy;
}

function findOpponent(ctx: EngineCtx, player: string): string {
  const shape = ctx as unknown as PatchCtxShape;
  const players = shape.players ?? [];
  const other = players.find((p) => p.playerId !== player);
  return other?.playerId ?? (player === 'p1' ? 'p2' : 'p1');
}

/**
 * draw_cards - Rule 413. Patch-path implementation supports the standard
 * draw as well as Burn Out (rule 431) when the deck can't satisfy the count.
 */
export const drawCardsHandler: OpHandler<{ type: 'draw_cards' }> = {
  op: 'draw_cards',
  execute(ctx: EngineCtx, _op, source): OpResult {
    const op = _op as unknown as DrawCardsOp;

    // Engine adapter path: legacy behavior.
    if (ctx.engine?.drawCards && ctx.caster) {
      const operation = _op as unknown as EffectOperation;
      const targetPlayer = operation.targetHint === 'enemy'
        ? ctx.engine.getOtherPlayer(ctx.caster)
        : ctx.caster;
      const count = Math.max(1, operation.magnitudeHint ?? op.count ?? 1);
      ctx.engine.drawCards(targetPlayer, count, true);
      ctx.engine.logRuleUsage?.(source, 'draw_cards');
      return emptyResult();
    }

    // Patch-only path.
    const patches: Patch[] = [];
    const triggered: TriggerFire[] = [];
    const log: LogEntry[] = [];
    const player = op.player ?? (ctx as unknown as PatchCtxShape).turnPlayerId ?? 'p1';
    const count = Math.max(1, op.count ?? 1);

    const shape = ctx as unknown as PatchCtxShape;
    const deck = shape.zones?.mainDecks?.[player] ?? [];
    const trash = shape.zones?.trashes?.[player] ?? [];

    // Simulate drawing against a mutable working copy so we can express the
    // final state as patches. Applying patches against the original ctx
    // reproduces this sequence exactly.
    let workingDeck = deck.slice();
    const drawnIntoHand: PatchCtxCard[] = [];
    let burnOutFired = false;
    let cursor = shape.rng?.cursor ?? 0;

    for (let i = 0; i < count; i += 1) {
      if (workingDeck.length === 0) {
        // Burn Out. Rule 431: when a player cannot draw, opponent gains a
        // point, then trash is shuffled into the deck, and drawing resumes.
        burnOutFired = true;
        if (trash.length > 0) {
          const rng = mulberry32(hashSeed(shape.rng?.seed ?? 'seed', cursor));
          cursor += 1;
          const shuffled = shuffle(
            trash.map((c) => ({ ...c, zone: 'main-deck' })),
            rng
          );
          workingDeck = shuffled;
        }
        log.push({ tick: 0, kind: 'burn_out_triggered', payload: { player } });
        // If still empty after recycle, we can't draw more: stop.
        if (workingDeck.length === 0) break;
      }
      const drawn = workingDeck.shift()!;
      drawnIntoHand.push({ ...drawn, zone: 'hand' });
    }

    // Emit patches: replace decks/hand/trash wholesale when burn out happened
    // (simplest correct semantics for the test's structuredClone applier).
    if (burnOutFired) {
      // Replace the trash with empty.
      patches.push({ op: 'replace', path: `/zones/trashes/${player}`, value: [] });
      // Replace the deck with the working deck.
      patches.push({ op: 'replace', path: `/zones/mainDecks/${player}`, value: workingDeck });
      // Replace hand with appended contents.
      const currentHand = shape.zones?.hands?.[player] ?? [];
      patches.push({
        op: 'replace',
        path: `/zones/hands/${player}`,
        value: [...currentHand, ...drawnIntoHand]
      });
      // Award opponent a point per Burn Out event.
      const opponent = findOpponent(ctx, player);
      const opponentIdx = (shape.players ?? []).findIndex((p) => p.playerId === opponent);
      if (opponentIdx >= 0) {
        const current = shape.players![opponentIdx]!.points ?? 0;
        patches.push({
          op: 'replace',
          path: `/players/${opponentIdx}/points`,
          value: current + 1
        });
      }
      // Advance rng cursor.
      patches.push({ op: 'replace', path: '/rng/cursor', value: cursor });
    } else {
      // Normal path: remove N from the top of deck, append to hand.
      for (let i = 0; i < drawnIntoHand.length; i += 1) {
        patches.push({ op: 'remove', path: `/zones/mainDecks/${player}/0` });
      }
      for (const card of drawnIntoHand) {
        patches.push({ op: 'add', path: `/zones/hands/${player}/-`, value: card });
      }
    }

    // Fire on_draw per card drawn.
    const sourceInstanceId =
      (source as unknown as { instanceId?: string; id?: string })?.instanceId ??
      (source as unknown as { id?: string })?.id ??
      '';
    for (const card of drawnIntoHand) {
      triggered.push({
        triggerType: 'on_draw',
        sourceInstanceId,
        sourceController: player,
        eventSnapshot: {
          kind: 'on_draw',
          payload: { player, instanceId: card.instanceId }
        }
      });
    }

    log.push({ tick: 0, kind: 'draw_cards_applied', payload: { player, count: drawnIntoHand.length } });

    return { patches, triggeredAbilities: triggered, log };
  }
};
