/**
 * Phase 4: dispatcher observability.
 *
 * A `DispatcherStats` recorder is an OPT-IN observer that the dispatcher
 * checks on every `runOp` invocation. Handlers are never consulted or
 * branched on - the recorder just counts (handled vs unknown) per op type.
 *
 * Design goals:
 *  - Zero-cost when absent. Default `EngineCtx` objects do not carry a
 *    `statsRecorder` and the dispatcher's fast path is an untouched
 *    `if (!ctx.statsRecorder) skip` guard. The 150 Phase 2/3 unit tests
 *    never set it, so they are unaffected.
 *  - Never mutate handler behavior. Outcome is reported AFTER handler
 *    selection; if we were to throw inside the recorder we would corrupt
 *    the result, so `recordOp` is a no-throw function that swallows its
 *    own failures.
 *  - Structurally identical to the QA spec in the Phase 4 brief so
 *    integration tests can import the factory without re-declaring types.
 *
 * The recorder is deliberately a plain object, not a class, so serializing
 * a run summary to the test log is trivial and the tests can mutate fields
 * directly for fixture setup.
 */

export interface DispatcherStats {
  /** Total invocations of runOp observed by this recorder. */
  totalOps: number;
  /** Invocations that resolved to a registered handler. */
  handledOps: number;
  /** Invocations that fell through to the unknown-op warn path. */
  unknownOps: number;
  /** Per-op-type counters. Useful for comparing observed vs CSV static weights. */
  byOpType: Map<string, { handled: number; unknown: number }>;
  /** Distinct op types that fell through. Kept as a Set for cardinality assertions. */
  unknownOpTypes: Set<string>;
}

export type OpOutcome = 'handled' | 'unknown';

export function createStatsRecorder(): DispatcherStats {
  return {
    totalOps: 0,
    handledOps: 0,
    unknownOps: 0,
    byOpType: new Map(),
    unknownOpTypes: new Set()
  };
}

/**
 * Record a single dispatcher invocation. Called from `runOp` when and only
 * when `ctx.statsRecorder` is present. Kept side-effect-free on the op
 * itself; only mutates the recorder fields.
 *
 * Swallows any throw to uphold the "observer never mutates handler behavior"
 * contract. In practice the only way this can throw is Map.set running out
 * of memory, at which point the match is already dead.
 */
export function recordOp(
  stats: DispatcherStats,
  opType: string,
  outcome: OpOutcome
): void {
  try {
    stats.totalOps += 1;
    if (outcome === 'handled') {
      stats.handledOps += 1;
    } else {
      stats.unknownOps += 1;
      stats.unknownOpTypes.add(opType);
    }
    const bucket = stats.byOpType.get(opType);
    if (bucket) {
      if (outcome === 'handled') bucket.handled += 1;
      else bucket.unknown += 1;
    } else {
      stats.byOpType.set(opType, {
        handled: outcome === 'handled' ? 1 : 0,
        unknown: outcome === 'unknown' ? 1 : 0
      });
    }
  } catch {
    /* never let the observer corrupt the dispatch result */
  }
}

/**
 * Human-readable one-liner for test logs (matches the Phase 4 brief format).
 *   [phase-4] totalOps=X handled=Y unknown=Z (Z/X%) unknownTypes=[...]
 */
export function formatStatsSummary(stats: DispatcherStats): string {
  const pct =
    stats.totalOps === 0
      ? '0.0'
      : ((stats.unknownOps / stats.totalOps) * 100).toFixed(1);
  const types = Array.from(stats.unknownOpTypes).sort().join(',');
  return `[phase-4] totalOps=${stats.totalOps} handled=${stats.handledOps} unknown=${stats.unknownOps} (${pct}%) unknownTypes=[${types}]`;
}

/**
 * Return the top-N op types by handled count, descending. Ties broken by
 * op-type name ascending for determinism across seeds.
 */
export function topHandledOps(
  stats: DispatcherStats,
  n: number
): Array<{ opType: string; handled: number }> {
  const entries: Array<{ opType: string; handled: number }> = [];
  for (const [opType, bucket] of stats.byOpType) {
    if (bucket.handled > 0) entries.push({ opType, handled: bucket.handled });
  }
  entries.sort((a, b) => {
    if (b.handled !== a.handled) return b.handled - a.handled;
    return a.opType.localeCompare(b.opType);
  });
  return entries.slice(0, n);
}
