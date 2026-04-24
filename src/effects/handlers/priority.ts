import logger from '../../logger';
import type { EffectOperation } from '../../card-catalog';
import type {
  EngineCtx,
  OpHandler,
  OpResult,
  Patch,
  PriorityVariant,
  ValidationResult
} from '../types';
import { emptyResult } from '../types';

/**
 * manipulate_priority - Per spec section 17 the data-layer op collapses
 * several distinct behaviors. Variants 1-3 are timing tags that should
 * have been consumed at canPlay time; receiving them as an op at resolve
 * time is a data-layer bug, so the handler no-ops with a warn log.
 *
 * Variants 4+ (take_focus / grant_priority) are the real priority mutations.
 * Patch path emits updates against ctx.priorityHolder / ctx.focusHolder.
 */

const TAG_VARIANTS: ReadonlySet<PriorityVariant> = new Set([
  'action_tagged',
  'reaction_tagged',
  'add_reaction'
]);

interface ManipulatePriorityOp {
  type: 'manipulate_priority';
  variant?: PriorityVariant;
  targetPlayer?: string;
  windowScope?: 'this_chain' | 'this_showdown' | 'this_turn';
}

interface PatchCtxShape {
  focusHolder?: string | null;
  priorityHolder?: string | null;
  turnState?: { mode?: string };
}

function inferVariant(
  explicit: PriorityVariant | undefined,
  sourceKeywords: string[] | undefined
): PriorityVariant {
  if (explicit) return explicit;
  const kws = (sourceKeywords ?? []).map((k) => k.toLowerCase());
  if (kws.includes('reaction')) return 'reaction_tagged';
  if (kws.includes('action')) return 'action_tagged';
  return 'action_tagged';
}

function hasAdapter(ctx: EngineCtx): boolean {
  return Boolean(
    ctx.engine &&
      typeof ctx.engine.openPriorityWindow === 'function' &&
      ctx.caster
  );
}

export const manipulatePriorityHandler: OpHandler<{ type: 'manipulate_priority' }> = {
  op: 'manipulate_priority',
  validate(ctx: EngineCtx, _op): ValidationResult {
    const op = _op as unknown as ManipulatePriorityOp;

    // Adapter path: legacy accepts all.
    if (hasAdapter(ctx)) return { ok: true };

    // Patch path: take_focus only valid inside a showdown (spec 17.5).
    if (op.variant === 'take_focus') {
      const shape = ctx as unknown as PatchCtxShape;
      const mode = shape.turnState?.mode ?? '';
      if (!mode.startsWith('showdown')) {
        return { ok: false, reason: 'not_in_showdown' };
      }
    }
    return { ok: true };
  },
  execute(ctx: EngineCtx, _op, source): OpResult {
    const operation = _op as unknown as EffectOperation & { variant?: PriorityVariant; targetPlayer?: string };
    const op = _op as unknown as ManipulatePriorityOp;
    const variant = inferVariant(operation.variant, (source as unknown as { keywords?: string[] })?.keywords);

    if (TAG_VARIANTS.has(variant)) {
      logger.warn('[effects] PRIORITY_TAG_DISPATCHED_AS_OP', {
        sourceCardId: (source as unknown as { id?: string })?.id,
        variant
      });
      ctx.engine?.logRuleUsage?.(source, `priority-tag-${variant}`);
      return {
        patches: [],
        triggeredAbilities: [],
        log: [{
          tick: 0,
          kind: `priority_tag_warn_${variant}`,
          payload: { sourceCardId: (source as unknown as { id?: string })?.id, variant }
        }]
      };
    }

    // Adapter path for variants 4+.
    if (hasAdapter(ctx)) {
      if (!ctx.caster) return emptyResult();
      const windowHolder = operation.targetHint === 'enemy'
        ? ctx.engine.getOtherPlayer(ctx.caster).playerId
        : ctx.caster.playerId;

      switch (variant) {
        case 'take_focus': {
          ctx.engine.setFocusPlayerId?.(windowHolder);
          const windowType = (ctx.engine.getCurrentPhase?.() ?? '').includes('combat')
            ? 'combat'
            : 'main';
          ctx.engine.openPriorityWindow?.(windowType, windowHolder, `effect-${(source as unknown as { id?: string })?.id}`);
          break;
        }
        case 'grant_priority': {
          const windowType = (ctx.engine.getCurrentPhase?.() ?? '').includes('combat')
            ? 'combat'
            : 'main';
          ctx.engine.openPriorityWindow?.(windowType, windowHolder, `grant-${(source as unknown as { id?: string })?.id}`);
          break;
        }
        case 'extra_action':
        case 'skip_priority_pass':
        default:
          ctx.engine.logRuleUsage?.(source, `priority-${variant}-unimplemented`);
          break;
      }
      return emptyResult();
    }

    // Patch path for variants 4+.
    const patches: Patch[] = [];
    const targetPlayer = op.targetPlayer;
    if (!targetPlayer) return emptyResult();
    if (variant === 'take_focus') {
      patches.push({ op: 'replace', path: '/focusHolder', value: targetPlayer });
      patches.push({ op: 'replace', path: '/priorityHolder', value: targetPlayer });
    } else if (variant === 'grant_priority') {
      patches.push({ op: 'replace', path: '/priorityHolder', value: targetPlayer });
    }
    return {
      patches,
      triggeredAbilities: [],
      log: [{ tick: 0, kind: `manipulate_priority_${variant}`, payload: { targetPlayer } }]
    };
  }
};
