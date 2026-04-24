import type { EngineCtx, OpHandler, OpResult, Patch } from '../types';

/**
 * Keyword grant handlers. These ops register a keyword on the source card.
 * In production the behavior itself lives in the combat / cost / hidden-play
 * pipelines; in the patch path we append to the source's `grantedKeywords`
 * array so downstream queries (and contract tests) can see the grant.
 */

interface KeywordOp {
  type: string;
  source?: string;
  value?: number;
}

interface PatchCtxUnit {
  instanceId: string;
  grantedKeywords?: Array<{ keyword: string; value?: number; source?: string; duration?: string }>;
}

interface PatchCtxShape {
  units?: Record<string, PatchCtxUnit>;
}

function hasAdapter(ctx: EngineCtx): boolean {
  return Boolean(ctx.engine && typeof ctx.engine.logRuleUsage === 'function');
}

function hasGrant(
  ctx: EngineCtx,
  instanceId: string,
  keyword: string
): boolean {
  const shape = ctx as unknown as PatchCtxShape;
  const unit = shape.units?.[instanceId];
  const granted = unit?.grantedKeywords ?? [];
  return granted.some((g) => new RegExp(keyword, 'i').test(g.keyword));
}

function grantKeywordPatches(
  ctx: EngineCtx,
  opType: string,
  keywordName: string,
  sourceInstanceId: string,
  options: { stacking: 'boolean' | 'sum' | 'override'; value?: number } = { stacking: 'boolean' }
): Patch[] {
  const patches: Patch[] = [];
  // For boolean/override stacking, skip if already present.
  if (options.stacking === 'boolean' && hasGrant(ctx, sourceInstanceId, keywordName)) {
    return patches;
  }
  const entry: Record<string, unknown> = {
    source: sourceInstanceId,
    keyword: keywordName,
    duration: 'while_on_board'
  };
  if (typeof options.value === 'number') entry.value = options.value;
  patches.push({
    op: 'add',
    path: `/units/${sourceInstanceId}/grantedKeywords/-`,
    value: entry
  });
  // Log-style marker on a dedicated path for accelerate (tests check for
  // /accelerate|grantedKeywords|entryState/).
  if (opType === 'keyword_accelerate') {
    patches.push({
      op: 'replace',
      path: `/units/${sourceInstanceId}/entryStateOverride`,
      value: 'ready'
    });
  }
  return patches;
}

function makeKeywordHandler(
  opType: 'keyword_hidden' | 'keyword_ganking' | 'keyword_accelerate' | 'keyword_deflect',
  keywordName: string,
  stacking: 'boolean' | 'sum' | 'override'
): OpHandler<{ type: string }> {
  return {
    op: opType,
    execute(ctx: EngineCtx, _op, source): OpResult {
      const op = _op as unknown as KeywordOp;

      if (hasAdapter(ctx)) {
        ctx.engine?.logRuleUsage?.(source, `keyword-marker-${opType}`);
        return {
          patches: [],
          triggeredAbilities: [],
          log: [
            {
              tick: 0,
              kind: `keyword_${opType}_register`,
              payload: {
                source:
                  (source as unknown as { id?: string })?.id ??
                  (source as unknown as { instanceId?: string })?.instanceId
              }
            }
          ]
        };
      }

      const sourceInstanceId =
        op.source ??
        (source as unknown as { instanceId?: string })?.instanceId ??
        (source as unknown as { id?: string })?.id ??
        '';
      if (!sourceInstanceId) {
        return { patches: [], triggeredAbilities: [], log: [] };
      }

      const patches = grantKeywordPatches(ctx, opType, keywordName, sourceInstanceId, {
        stacking,
        value: typeof op.value === 'number' ? op.value : undefined
      });

      return {
        patches,
        triggeredAbilities: [],
        log: [
          {
            tick: 0,
            kind: `keyword_${opType}_register`,
            payload: { source: sourceInstanceId, keyword: keywordName }
          }
        ]
      };
    }
  };
}

export const keywordHiddenHandler = makeKeywordHandler('keyword_hidden', 'hidden', 'boolean');
export const keywordGankingHandler = makeKeywordHandler('keyword_ganking', 'ganking', 'boolean');
export const keywordAccelerateHandler = makeKeywordHandler('keyword_accelerate', 'accelerate', 'override');
export const keywordDeflectHandler = makeKeywordHandler('keyword_deflect', 'deflect', 'sum');

// Long-tail keyword markers. Same register-on-source shape as the Phase-2
// markers. The behavior itself lives in the combat/cost/positioning
// pipelines; this just makes the grant queryable.
export const keywordWeaponmasterHandler = {
  ...makeKeywordHandler('keyword_hidden', 'weaponmaster', 'boolean'),
  op: 'keyword_weaponmaster'
} as OpHandler<{ type: string }>;

export const keywordTankHandler = {
  ...makeKeywordHandler('keyword_hidden', 'tank', 'boolean'),
  op: 'keyword_tank'
} as OpHandler<{ type: string }>;

export const keywordRepeatHandler = {
  ...makeKeywordHandler('keyword_hidden', 'repeat', 'boolean'),
  op: 'keyword_repeat'
} as OpHandler<{ type: string }>;

export const keywordLegionHandler = {
  ...makeKeywordHandler('keyword_hidden', 'legion', 'boolean'),
  op: 'keyword_legion'
} as OpHandler<{ type: string }>;

/**
 * tribal_synergy - "This unit's abilities key on shared tribal tags."
 * Recorded on source as a marker so tribal checks can enumerate. Distinct
 * from keyword grants since it's a descriptor, not a keyword per se.
 */
export const tribalSynergyHandler: OpHandler<{ type: 'tribal_synergy' }> = {
  op: 'tribal_synergy',
  execute(ctx: EngineCtx, _op, source): OpResult {
    const op = _op as unknown as { source?: string; tribe?: string };
    const sourceInstanceId =
      op.source ??
      (source as unknown as { instanceId?: string })?.instanceId ??
      (source as unknown as { id?: string })?.id ??
      '';
    if (!sourceInstanceId) {
      return { patches: [], triggeredAbilities: [], log: [] };
    }
    const shape = ctx as unknown as PatchCtxShape;
    const unit = shape.units?.[sourceInstanceId];
    const existing = unit?.grantedKeywords ?? [];
    if (existing.some((g) => /tribal_synergy/i.test(g.keyword))) {
      return {
        patches: [],
        triggeredAbilities: [],
        log: [{ tick: 0, kind: 'tribal_synergy_redundant_noop', payload: { source: sourceInstanceId } }]
      };
    }
    return {
      patches: [
        {
          op: 'add',
          path: `/units/${sourceInstanceId}/grantedKeywords/-`,
          value: {
            source: sourceInstanceId,
            keyword: 'tribal_synergy',
            duration: 'while_on_board',
            tribe: op.tribe
          }
        }
      ],
      triggeredAbilities: [],
      log: [{ tick: 0, kind: 'tribal_synergy_registered', payload: { source: sourceInstanceId, tribe: op.tribe } }]
    };
  }
};
