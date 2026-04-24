import logger from '../logger';
import type { EffectOperation } from '../card-catalog';
import type {
  EffectOp,
  EngineCtx,
  OpResult,
  ValidationResult
} from './types';
import { emptyResult } from './types';
import { OpHandlerRegistry } from './registry';
import { recordOp, type DispatcherStats } from './instrumentation';

/**
 * Spec-shaped signature (section 12.1):
 *
 *   runOp(ctx, op, source, registry?) -> OpResult
 *
 * `source` is a first-class argument (formerly pulled from
 * `ctx.operationContext.source`, which is not always populated in
 * standalone/test contexts). `registry` is optional infrastructure; the
 * dispatcher resolves it in this order:
 *   1. explicit `registry` parameter
 *   2. `ctx.registry` if present on the ctx
 *   3. the cached default registry (built lazily on first call)
 *
 * Contract:
 *  - Unknown op types soft-fail (warn + empty OpResult with a "unknown_op"
 *    warning log entry). The engine keeps processing. Per the Tech Lead:
 *    "unimplemented ops fail soft."
 *  - validate() may rewrite the op via `substituteOp`. We honor that before
 *    execute(). This is how `move_unit` on a gear target converts into a
 *    no-op rejection (spec 4.4, 15.5).
 *  - ReplacementRegistry is intentionally out of scope for Phase 2b: the
 *    existing engine's replacement logic still runs around the dispatcher.
 *    The hook lives here so the future wiring is a one-line change.
 */

// Imported lazily to avoid a module-level cycle (index.ts -> dispatcher.ts
// and dispatcher.ts -> index.ts via buildDefaultRegistry would otherwise
// deadlock at load time).
let cachedDefaultRegistry: OpHandlerRegistry | null = null;
function getDefaultRegistry(): OpHandlerRegistry {
  if (cachedDefaultRegistry) return cachedDefaultRegistry;
  // require() inside the function dodges the cycle.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { buildDefaultRegistry } = require('./index') as {
    buildDefaultRegistry: () => OpHandlerRegistry;
  };
  cachedDefaultRegistry = buildDefaultRegistry();
  return cachedDefaultRegistry;
}

interface CtxWithRegistry {
  registry?: OpHandlerRegistry;
  statsRecorder?: DispatcherStats;
}

function resolveRegistry(
  ctx: EngineCtx,
  explicit?: OpHandlerRegistry
): OpHandlerRegistry {
  if (explicit) return explicit;
  const fromCtx = (ctx as unknown as CtxWithRegistry).registry;
  if (fromCtx) return fromCtx;
  return getDefaultRegistry();
}

function resolveStatsRecorder(ctx: EngineCtx): DispatcherStats | undefined {
  return (ctx as unknown as CtxWithRegistry).statsRecorder;
}

function sourceIdForLog(source: unknown): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const s = source as { id?: string; instanceId?: string };
  return s.id ?? s.instanceId;
}

/**
 * runOp - single-op dispatch entry point (spec section 12.1).
 *
 * Signature matches spec exactly in positions 1-3. `registry` is an optional
 * convenience for engine code paths that already hold a registry reference.
 */
export function runOp(
  ctx: EngineCtx,
  op: EffectOp,
  // The spec types `source` as CardInstance. Our in-engine adapter passes
  // the concrete Card/BoardCard; both satisfy the subset used by handlers
  // (id, instanceId, name). We intentionally widen here so contract tests
  // that build a CardInstance-shaped object do not need to satisfy the
  // fuller Card type.
  source: unknown,
  registry?: OpHandlerRegistry
): OpResult {
  const reg = resolveRegistry(ctx, registry);
  const stats = resolveStatsRecorder(ctx);
  const handler = reg.get(op.type);

  if (!handler) {
    const logPayload = { opType: op.type, sourceCardId: sourceIdForLog(source) };
    logger.warn('[effects] no handler registered for op', logPayload);
    if (stats) recordOp(stats, op.type, 'unknown');
    return {
      patches: [],
      triggeredAbilities: [],
      log: [{ tick: 0, kind: 'unknown_op', payload: logPayload }]
    };
  }

  // Record handled dispatch once we know a handler exists. Validation
  // rewrites (substituteOp) route through a nested `runOp` call that will
  // itself record the substituted op, so we do not double-count here.
  if (stats) recordOp(stats, op.type, 'handled');

  if (handler.validate) {
    let validation: ValidationResult;
    try {
      validation = handler.validate(ctx, op as never, source as never);
    } catch (err) {
      logger.warn('[effects] handler.validate threw', {
        err,
        opType: op.type,
        sourceCardId: sourceIdForLog(source)
      });
      return emptyResult();
    }

    if (!validation.ok && !validation.substituteOp) {
      logger.info('[effects] op rejected by handler validate', {
        opType: op.type,
        reason: validation.reason,
        sourceCardId: sourceIdForLog(source)
      });
      return emptyResult();
    }

    if (validation.substituteOp) {
      return runOp(ctx, validation.substituteOp, source, reg);
    }
  }

  try {
    return handler.execute(ctx, op as never, source as never);
  } catch (err) {
    logger.error('[effects] handler.execute threw', {
      err,
      opType: op.type,
      sourceCardId: sourceIdForLog(source)
    });
    return emptyResult();
  }
}

/**
 * Sequence variant - runs a list of ops in order. Mirrors the spec signature
 * so the engine can thread `source` through a batch.
 *
 * Returns the accumulated OpResult; the caller can merge logs/triggers into
 * its outer context. The legacy engine call site passes EffectOperation[]
 * (the catalog shape); handlers accept EffectOp (a superset), hence the
 * widening cast at the call site.
 */
export function runOpSequence(
  ctx: EngineCtx,
  operations: EffectOperation[] | EffectOp[],
  source: unknown,
  registry?: OpHandlerRegistry,
  startIndex = 0,
  onDefer?: (index: number) => void
): OpResult {
  const reg = resolveRegistry(ctx, registry);
  const merged: OpResult = emptyResult();
  for (let i = startIndex; i < operations.length; i++) {
    const operation = operations[i];
    const result = runOp(ctx, operation as unknown as EffectOp, source, reg);
    merged.patches.push(...result.patches);
    merged.triggeredAbilities.push(...result.triggeredAbilities);
    merged.log.push(...result.log);
    if (result.defer) {
      merged.defer = true;
      if (onDefer) onDefer(i);
      return merged;
    }
  }
  return merged;
}
