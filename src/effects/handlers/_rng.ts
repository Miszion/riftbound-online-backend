import type { EngineCtx } from '../types';

/**
 * Handler-local seeded RNG (Phase 5d hygiene).
 *
 * Phase 5b added an engine-level seeded `Rng` (see `game-engine.ts`), but
 * the patch-only code paths in `tokens.ts` / `zones.ts` were still calling
 * `Math.random()` for generated instance ids. Those are game-state ids, not
 * telemetry noise, so non-determinism here makes replay / determinism
 * regressions flake.
 *
 * Approach matches `draw.ts`: lift `ctx.rng = { seed, cursor }` off the
 * shape and fold both into a mulberry32 stream. The `handlerTag` scopes
 * the stream per call site so token ids and summon ids do not collide even
 * when derived from the same seed+cursor pair.
 */

interface RngShape {
  rng?: { seed?: string | number; cursor?: number };
}

function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

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

// Per-adapter monotonic cursors, keyed on the engine adapter. Each
// handler-tag pair gets its own counter so two tokens minted in the same
// dispatcher frame do not share an id.
const adapterCursors = new WeakMap<object, Map<string, number>>();

function nextAdapterCursor(ctx: EngineCtx, handlerTag: string): number {
  const key = ctx.engine as unknown as object;
  if (!key) return 0;
  let bag = adapterCursors.get(key);
  if (!bag) {
    bag = new Map<string, number>();
    adapterCursors.set(key, bag);
  }
  const current = bag.get(handlerTag) ?? 0;
  bag.set(handlerTag, current + 1);
  return current;
}

/**
 * Deterministic short suffix: 4-char base36 derived from ctx.rng seed +
 * per-adapter cursor + handlerTag. Replaces `Math.random().toString(36)`.
 */
export function deterministicIdSuffix(ctx: EngineCtx, handlerTag: string): string {
  const shape = ctx as unknown as RngShape;
  const seedInput = shape.rng?.seed;
  const seed =
    typeof seedInput === 'number'
      ? seedInput >>> 0
      : fnv1a32(String(seedInput ?? 'seed'));
  const shapeCursor = shape.rng?.cursor ?? 0;
  const localCursor = nextAdapterCursor(ctx, handlerTag);
  const mix = fnv1a32(`${handlerTag}:${seed}:${shapeCursor}:${localCursor}`);
  const r = mulberry32(mix)();
  return Math.floor(r * 0xfffffff).toString(36).slice(0, 4).padStart(4, '0');
}
