import type { EffectOperation } from '../../card-catalog';
import type {
  EngineCtx,
  LogEntry,
  OpHandler,
  OpResult,
  Patch
} from '../types';
import { emptyResult } from '../types';
import { deterministicIdSuffix } from './_rng';

interface CreateTokenOp {
  type: 'create_token';
  player?: string;
  templateId?: string;
  count?: number;
  location?:
    | { kind: 'base'; player: string }
    | { kind: 'battlefield'; battlefieldId: string };
  enteredExhausted?: boolean;
}

// Module-level counter for deterministic-enough unique IDs in the patch-only
// path. Production path uses the engine's own id generator. Suffix comes
// from ctx.rng (Phase 5d) so rerunning with the same seed produces the same
// sequence of ids.
let tokenCounter = 0;
function nextTokenId(ctx: EngineCtx): string {
  tokenCounter += 1;
  return `token-${tokenCounter}-${Date.now()}-${deterministicIdSuffix(ctx, 'token')}`;
}

/**
 * create_token - Spawns a token per the card's TokenSpec (rules 176-184).
 * Delegates to the legacy spawn path in production; emits an add-per-token
 * patch sequence when the engine adapter is absent (test / standalone).
 */
export const createTokenHandler: OpHandler<{ type: 'create_token' }> = {
  op: 'create_token',
  execute(ctx: EngineCtx, _op, source): OpResult {
    const op = _op as unknown as CreateTokenOp;

    // Engine adapter path.
    if (ctx.engine?.getTokenSpec) {
      const operation = _op as unknown as EffectOperation;
      const tokenSpec = ctx.engine.getTokenSpec(operation, source) as
        | { variableCount?: boolean; flexiblePlacement?: boolean }
        | null;
      if (!tokenSpec) {
        ctx.engine.logRuleUsage?.(source, 'create_token-manual');
        return emptyResult();
      }
      if (tokenSpec.variableCount || tokenSpec.flexiblePlacement) {
        ctx.engine.logRuleUsage?.(source, 'create_token-manual');
        return emptyResult();
      }
      ctx.engine.spawnTokenUnits?.(ctx.caster, tokenSpec, ctx.operationContext as never);
      return emptyResult();
    }

    // Patch-only path.
    const patches: Patch[] = [];
    const log: LogEntry[] = [];
    const player = op.player ?? 'p1';
    const count = Math.max(1, op.count ?? 1);
    const templateId = op.templateId ?? 'token-template';
    const location = op.location ?? { kind: 'base', player };

    for (let i = 0; i < count; i += 1) {
      const instanceId = nextTokenId(ctx);
      const tokenInstance: Record<string, unknown> = {
        instanceId,
        cardId: null,
        templateId,
        isToken: true,
        owner: player,
        controller: player,
        zone: 'board',
        location,
        cardType: 'Unit',
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
      patches.push({
        op: 'add',
        path: `/units/${instanceId}`,
        value: tokenInstance
      });
      log.push({ tick: 0, kind: 'token_created', payload: { instanceId, templateId, player, location } });
    }

    return { patches, triggeredAbilities: [], log };
  }
};
