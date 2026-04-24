/**
 * In-process ephemeral frame store for match replays.
 *
 * Design: every time `publishSpectatorState` fires in bot-match.ts (or any
 * similar tick path), we ALSO append the serialized snapshot here keyed by
 * matchId. A replay session later reads that list and re-publishes it via
 * `publishGameStateChange(sessionId, frame)` to drive the live spectate
 * pipeline without any schema changes on the frontend.
 *
 * IMPORTANT LIMITS / CAVEATS:
 *   - This store is in-memory only. Frames do NOT survive server restarts.
 *   - Each match is capped at {@link MAX_FRAMES_PER_MATCH} (oldest dropped).
 *   - Globally we keep the {@link MAX_MATCHES} most recently written matches
 *     via an LRU on last-write-time. Evicted matches lose all frames.
 *   - Replay is only guaranteed to be available until the process restarts
 *     OR the match is evicted by the LRU. The DynamoDB MatchReplay table is
 *     NOT touched by this module.
 */
export type SerializedFrame = ReturnType<
  typeof import('./game-state-serializer').serializeGameState
>;

export const MAX_FRAMES_PER_MATCH = 500;
export const MAX_MATCHES = 20;

interface MatchFrameRecord {
  frames: SerializedFrame[];
  lastWriteMs: number;
}

const STORE = new Map<string, MatchFrameRecord>();

const evictIfNeeded = (): void => {
  if (STORE.size <= MAX_MATCHES) return;
  // Find the LRU entry (oldest lastWriteMs) and drop it. We do this in a loop
  // in case someone raises the cap down at runtime; normally it's one pass.
  while (STORE.size > MAX_MATCHES) {
    let oldestId: string | null = null;
    let oldestTs = Number.POSITIVE_INFINITY;
    for (const [matchId, record] of STORE) {
      if (record.lastWriteMs < oldestTs) {
        oldestTs = record.lastWriteMs;
        oldestId = matchId;
      }
    }
    if (!oldestId) break;
    STORE.delete(oldestId);
  }
};

/**
 * Append a single serialized frame for the given match.
 *
 * - Frames are stored in chronological insertion order.
 * - When the per-match cap is reached, the oldest frame is dropped.
 * - Writing also bumps the match's LRU recency.
 */
export const recordFrame = (matchId: string, frame: SerializedFrame): void => {
  if (!matchId) return;
  let record = STORE.get(matchId);
  if (!record) {
    record = { frames: [], lastWriteMs: 0 };
    STORE.set(matchId, record);
  }
  record.frames.push(frame);
  if (record.frames.length > MAX_FRAMES_PER_MATCH) {
    // Drop oldest frames to stay within the cap.
    const overflow = record.frames.length - MAX_FRAMES_PER_MATCH;
    record.frames.splice(0, overflow);
  }
  record.lastWriteMs = Date.now();
  evictIfNeeded();
};

/**
 * Return a shallow copy of the recorded frames for a given matchId. Returns
 * an empty array if the match is unknown or has been evicted.
 */
export const getFrames = (matchId: string): SerializedFrame[] => {
  const record = STORE.get(matchId);
  if (!record) return [];
  return record.frames.slice();
};

/** Number of frames currently stored for a match (0 if unknown). */
export const getFrameCount = (matchId: string): number => {
  return STORE.get(matchId)?.frames.length ?? 0;
};

/** Test/diagnostic helper: list the matchIds the store currently knows about. */
export const listRecordedMatchIds = (): string[] => {
  return Array.from(STORE.keys());
};

/** Test helper: drop everything. NOT intended for production use. */
export const __resetReplayFrameStore = (): void => {
  STORE.clear();
};
