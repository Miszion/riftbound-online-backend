import type {
  EngineCtx,
  LogEntry,
  OpHandler,
  OpResult,
  Patch,
  ValidationResult
} from '../types';
import { emptyResult } from '../types';

/**
 * Cost modifier handlers. Per spec section 10, cost modifiers are read-
 * through by the canPlay / payCost pipelines. These ops install a
 * descriptor into the cost-modifier registry; the cost-apply layer
 * iterates descriptors when computing the effective cost of a candidate
 * play. Multiple installs stack (spec section 10, rule 371).
 */

interface CostModOp {
  type: string;
  source?: string;
  target?: string;
  scope?: string;
  kind?: string;
  amount?: number;
  filter?: Record<string, unknown>;
  targetPredicate?: Record<string, unknown>;
}

function resolveSourceId(
  op: CostModOp,
  source: unknown
): string {
  return (
    op.source ??
    (source as { instanceId?: string })?.instanceId ??
    (source as { id?: string })?.id ??
    ''
  );
}

function validateAmount(op: CostModOp): ValidationResult {
  // Cost modifiers require positive magnitude. Zero or negative installs
  // are rejected at validate so the caller sees a clean ok=false signal.
  if (typeof op.amount === 'number' && op.amount <= 0) {
    return { ok: false, reason: 'cost_modifier_amount_must_be_positive' };
  }
  return { ok: true };
}

interface CostModifierRecord {
  source: string;
  registeredBy: string;
  kind?: string;
  scope?: string;
}

interface PatchCtxShape {
  temporaryMods?: unknown[];
}

function hasDuplicate(
  ctx: EngineCtx,
  sourceInstanceId: string,
  registeredBy: string,
  kind: string | undefined,
  scope: string
): boolean {
  const shape = ctx as unknown as PatchCtxShape;
  const mods = shape.temporaryMods;
  if (!Array.isArray(mods)) return false;
  return mods.some((raw) => {
    const m = raw as CostModifierRecord & { kind?: string };
    // temporaryMods carries entries from many handlers; filter to the
    // cost-modifier shape (has registeredBy field).
    if (!m || m.registeredBy !== registeredBy) return false;
    return (
      m.source === sourceInstanceId &&
      (m.kind ?? '') === (kind ?? '') &&
      (m.scope ?? '') === scope
    );
  });
}

function registerCostModifier(
  ctx: EngineCtx,
  opKind: 'cost_reduction' | 'cost_increase' | 'targeting_discount',
  op: CostModOp,
  source: unknown,
  defaultScope: string
): OpResult {
  const sourceInstanceId = resolveSourceId(op, source);
  if (!sourceInstanceId) return emptyResult();

  const scope = op.scope ?? defaultScope;
  const amount = typeof op.amount === 'number' ? op.amount : 1;
  const kind = op.kind;
  const predicate = op.targetPredicate ?? op.filter;

  // Dedup by (source, registeredBy, kind, scope) to prevent repeated
  // trigger fires from double-registering. Each call still emits a log
  // entry so replay is deterministic and audits count every attempt.
  if (hasDuplicate(ctx, sourceInstanceId, opKind, kind, scope)) {
    return {
      patches: [],
      triggeredAbilities: [],
      log: [
        {
          tick: 0,
          kind: `${opKind}_redundant_noop`,
          payload: { source: sourceInstanceId, scope, kind }
        }
      ]
    };
  }

  // Entries land in temporaryMods (initialized array on the test ctx) so
  // downstream layers can enumerate cost modifiers alongside might /
  // aura / shield entries without a bespoke top-level array.
  const patches: Patch[] = [
    {
      op: 'add',
      path: '/temporaryMods/-',
      value: {
        registeredBy: opKind,
        source: sourceInstanceId,
        amount,
        scope,
        kind,
        predicate
      }
    }
  ];
  const log: LogEntry[] = [
    {
      tick: 0,
      kind: `${opKind}_registered`,
      payload: { source: sourceInstanceId, amount, scope, kind, predicate }
    }
  ];
  return { patches, triggeredAbilities: [], log };
}

export const costReductionHandler: OpHandler<{ type: 'cost_reduction' }> = {
  op: 'cost_reduction',
  validate(_ctx, _op) {
    return validateAmount(_op as CostModOp);
  },
  execute(ctx, _op, source) {
    return registerCostModifier(
      ctx,'cost_reduction', _op as CostModOp, source, 'self');
  }
};

export const costIncreaseHandler: OpHandler<{ type: 'cost_increase' }> = {
  op: 'cost_increase',
  validate(_ctx, _op) {
    return validateAmount(_op as CostModOp);
  },
  execute(ctx, _op, source) {
    return registerCostModifier(
      ctx,'cost_increase', _op as CostModOp, source, 'enemy');
  }
};

/**
 * targeting_discount - "Spells that target me cost less." Stored as a
 * specialized cost_reduction descriptor keyed on a target predicate.
 */
export const targetingDiscountHandler: OpHandler<{ type: 'targeting_discount' }> = {
  op: 'targeting_discount',
  validate(_ctx, _op) {
    return validateAmount(_op as CostModOp);
  },
  execute(ctx, _op, source) {
    return registerCostModifier(
      ctx,
      'targeting_discount',
      _op as CostModOp,
      source,
      'when_targeting_source'
    );
  }
};
