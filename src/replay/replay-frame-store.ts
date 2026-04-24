/**
 * Persistent replay-frame store.
 *
 * Scope: durable per-match frame history for the bot-vs-bot spectate/replay
 * pipeline (see nexus-data/plans/riftbound-online/bot-v-bot-flow-spec-2026-04-24.md
 * §3 D6 and the deferred-work doc bot-v-bot-backend-deferred-2026-04-24.md).
 *
 * Why this exists: the in-process `src/replay-frame-store.ts` holds frames in
 * RAM with LRU eviction, and the bot-match `REGISTRY` keeps its own per-match
 * buffer until the finished-TTL prunes it. Both lose frames on server
 * restart, so `/replays/:id` and `matchFrames(matchId)` can return `[]` for
 * matches that were perfectly well captured but pre-dated the restart. This
 * store writes every frame to disk as a JSONL append so a restart cannot
 * drop them.
 *
 * Storage layout: one JSONL file per matchId under {@link getStoreDir}. Each
 * line is a self-describing `StoredFrame` record:
 *
 *   { matchId, frameIndex, timestamp, state }
 *
 * Reads go through an in-memory cache hydrated on first access (avoids a
 * disk scan on every frame lookup while the process is hot).
 *
 * This module deliberately uses vanilla fs + JSONL rather than better-sqlite3.
 * The schema is trivially append-only, matches the existing `data/bot-matches`
 * fallback pattern in `src/bot-match.ts`, and keeps the dependency surface
 * unchanged (better-sqlite3 is not in package.json).
 */
import fs from 'node:fs';
import path from 'node:path';
import logger from '../logger';

export type SerializedFrame = ReturnType<
  typeof import('../game-state-serializer').serializeGameState
>;

export interface StoredFrame {
  matchId: string;
  frameIndex: number;
  timestamp: number;
  state: SerializedFrame;
}

const DEFAULT_STORE_DIR = path.resolve(__dirname, '..', '..', 'data', 'replay-frames');
const ENV_OVERRIDE_DIR = process.env.REPLAY_FRAME_STORE_DIR;

let storeDir: string = ENV_OVERRIDE_DIR && ENV_OVERRIDE_DIR.length > 0
  ? ENV_OVERRIDE_DIR
  : DEFAULT_STORE_DIR;

// Hydrated on first read per match. Cleared by __resetPersistentReplayFrameStore
// or deleteMatch. The cache never stores a partial file; either all frames
// from disk are loaded or the match is absent from the cache.
const FRAME_CACHE = new Map<string, SerializedFrame[]>();

// Matches the filename convention enforced by `matchIdToFile`. Anything outside
// this set is rejected up-front so the store cannot be tricked into opening
// `../something` or a path with slashes.
const SAFE_MATCH_ID = /^[A-Za-z0-9._-]+$/;

const isSafeMatchId = (matchId: string): boolean => {
  if (!matchId) return false;
  if (matchId.length > 256) return false;
  return SAFE_MATCH_ID.test(matchId);
};

const matchIdToFile = (matchId: string): string => {
  return path.join(storeDir, `${matchId}.jsonl`);
};

export const getStoreDir = (): string => storeDir;

/**
 * Ensure the store directory exists. Called on server startup (see server.ts)
 * so the first frame write does not race directory creation. Safe to call
 * repeatedly - fs.mkdirSync with recursive=true is idempotent.
 */
export const bootstrap = (dir?: string): void => {
  if (dir && dir.length > 0) {
    storeDir = dir;
  }
  try {
    fs.mkdirSync(storeDir, { recursive: true });
  } catch (error) {
    logger.error('[REPLAY-STORE] failed to create replay frame store directory', {
      storeDir,
      error: (error as Error).message
    });
    throw error;
  }
};

const ensureDir = (): void => {
  if (!fs.existsSync(storeDir)) {
    fs.mkdirSync(storeDir, { recursive: true });
  }
};

const hydrateFromDisk = (matchId: string): SerializedFrame[] => {
  if (!isSafeMatchId(matchId)) return [];
  const filePath = matchIdToFile(matchId);
  if (!fs.existsSync(filePath)) return [];
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    logger.warn('[REPLAY-STORE] failed to read frame file', {
      matchId,
      filePath,
      error: (error as Error).message
    });
    return [];
  }
  const frames: SerializedFrame[] = [];
  let expectedIndex = 0;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: StoredFrame;
    try {
      parsed = JSON.parse(line) as StoredFrame;
    } catch (error) {
      logger.warn('[REPLAY-STORE] skipping malformed frame line', {
        matchId,
        error: (error as Error).message
      });
      continue;
    }
    // Sanity: frameIndex must be monotonic. A gap means the file was
    // partially truncated; keep what we have and stop rather than return
    // frames out of order.
    if (parsed.frameIndex !== expectedIndex) {
      logger.warn('[REPLAY-STORE] non-monotonic frameIndex, stopping hydration', {
        matchId,
        expectedIndex,
        actualIndex: parsed.frameIndex
      });
      break;
    }
    frames.push(parsed.state);
    expectedIndex += 1;
  }
  return frames;
};

const getCachedFrames = (matchId: string): SerializedFrame[] => {
  let cached = FRAME_CACHE.get(matchId);
  if (cached) return cached;
  cached = hydrateFromDisk(matchId);
  // Always cache, even if empty — avoids repeatedly stat-ing a file that does
  // not exist for unknown matchIds on a hot read path.
  FRAME_CACHE.set(matchId, cached);
  return cached;
};

/**
 * Append a single serialized frame for the given match.
 *
 * Mirrors the in-memory `src/replay-frame-store.ts#recordFrame` API so the
 * bot-match driver can call both during the dual-write window while the
 * in-process spectate/replay-session pipeline still reads from the old store.
 */
export const persistFrame = (
  matchId: string,
  state: SerializedFrame
): number => {
  if (!isSafeMatchId(matchId)) {
    logger.warn('[REPLAY-STORE] rejecting unsafe matchId', { matchId });
    return -1;
  }
  ensureDir();
  const frames = getCachedFrames(matchId);
  const frameIndex = frames.length;
  const record: StoredFrame = {
    matchId,
    frameIndex,
    timestamp: Date.now(),
    state
  };
  const line = `${JSON.stringify(record)}\n`;
  try {
    fs.appendFileSync(matchIdToFile(matchId), line, { encoding: 'utf8' });
  } catch (error) {
    logger.error('[REPLAY-STORE] frame append failed', {
      matchId,
      frameIndex,
      error: (error as Error).message
    });
    return -1;
  }
  frames.push(state);
  return frameIndex;
};

/**
 * Return the ordered frames for a match, sliced by optional offset/limit.
 * Returns an empty array when the match is unknown on disk (never thrown so
 * this is safe to call from read-through fallbacks).
 */
export const readFrames = (
  matchId: string,
  offset = 0,
  limit?: number
): SerializedFrame[] => {
  if (!isSafeMatchId(matchId)) return [];
  const frames = getCachedFrames(matchId);
  const safeOffset = Math.max(0, Math.floor(offset));
  if (safeOffset >= frames.length) return [];
  const end =
    typeof limit === 'number' && limit > 0
      ? Math.min(frames.length, safeOffset + Math.floor(limit))
      : frames.length;
  return frames.slice(safeOffset, end);
};

export const readFrameCount = (matchId: string): number => {
  if (!isSafeMatchId(matchId)) return 0;
  return getCachedFrames(matchId).length;
};

/**
 * Enumerate every match currently persisted on disk. Sort is unspecified so
 * callers that care about ordering (newest-first lists) should sort on the
 * returned data themselves — matchId encodes nothing about ordering.
 */
export const listPersistedMatches = (): string[] => {
  ensureDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(storeDir);
  } catch (error) {
    logger.warn('[REPLAY-STORE] listPersistedMatches readdir failed', {
      storeDir,
      error: (error as Error).message
    });
    return [];
  }
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const id = entry.slice(0, -'.jsonl'.length);
    if (isSafeMatchId(id)) matches.push(id);
  }
  return matches;
};

/**
 * Remove a match's frame file and drop any cached copy. Returns true when a
 * file was actually deleted; false if the match was not on disk.
 */
export const deleteMatch = (matchId: string): boolean => {
  if (!isSafeMatchId(matchId)) return false;
  FRAME_CACHE.delete(matchId);
  const filePath = matchIdToFile(matchId);
  if (!fs.existsSync(filePath)) return false;
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    logger.warn('[REPLAY-STORE] deleteMatch failed', {
      matchId,
      error: (error as Error).message
    });
    return false;
  }
};

// ---------------------------------------------------------------------------
// Test helpers.
//
// These are not exported from any index; tests import them by explicit path
// (see src/__tests__/replay-frame-store-persistent.test.ts).
// ---------------------------------------------------------------------------

/**
 * Reset the in-memory cache (simulates a process restart) without touching
 * the on-disk state. The next read will hydrate from disk.
 */
export const __resetPersistentFrameCache = (): void => {
  FRAME_CACHE.clear();
};

/**
 * Point the store at a fresh directory (typically an os.tmpdir() child in
 * tests) and clear the cache. Callers are responsible for cleanup.
 */
export const __setReplayFrameStoreDirForTests = (dir: string): void => {
  storeDir = dir;
  FRAME_CACHE.clear();
};

/**
 * Drop every file under the current store dir plus the in-memory cache. Only
 * for tests; refuses to run if storeDir resolves outside os.tmpdir to prevent
 * accidental production wipes.
 */
export const __wipeReplayFrameStoreForTests = (): void => {
  FRAME_CACHE.clear();
  if (!fs.existsSync(storeDir)) return;
  const os = require('node:os') as typeof import('node:os');
  const tmpRoot = os.tmpdir();
  const resolved = fs.realpathSync(storeDir);
  if (!resolved.startsWith(fs.realpathSync(tmpRoot))) {
    throw new Error(
      `__wipeReplayFrameStoreForTests refuses to wipe a non-tmp directory: ${resolved}`
    );
  }
  for (const entry of fs.readdirSync(storeDir)) {
    if (!entry.endsWith('.jsonl')) continue;
    fs.unlinkSync(path.join(storeDir, entry));
  }
};
