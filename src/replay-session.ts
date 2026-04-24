/**
 * Replay session driver.
 *
 * A replay session reads the ephemeral frame list for a completed (or still
 * running) match from {@link ./replay-frame-store} and re-publishes those
 * frames through the SAME live spectate pubsub channel the renderer already
 * listens to — `gameStateChanged(matchId: ID!)`. The frontend `GameBoard`
 * renderer does not need to change; it just subscribes to the returned
 * `sessionId` instead of the original matchId.
 *
 * Lifecycle:
 *   - `startReplaySession({ originalMatchId, speedMs })` captures a snapshot
 *     of the frame list, registers a session, and begins emitting frames.
 *   - `controlReplaySession(sessionId, { action, ... })` drives PLAY / PAUSE /
 *     SEEK / SET_SPEED / STOP.
 *   - When the cursor reaches the end we emit `publishMatchCompletion` with
 *     the last frame's result if any, and leave the session in `ended`
 *     state so late subscribers can still fetch status + the last frame.
 *   - Ended sessions older than {@link ENDED_SESSION_TTL_MS} are pruned.
 *
 * All timers are cleared on STOP, eviction, or `stopAllReplaySessions()`.
 */
import { randomUUID } from 'node:crypto';
import logger from './logger';
import {
  publishGameStateChange,
  publishMatchCompletion
} from './graphql/pubsub';
import {
  getFrames,
  SerializedFrame
} from './replay-frame-store';
import { reconstructFramesForMatch } from './replay-reconstructor';

export type ReplayAction = 'PLAY' | 'PAUSE' | 'SEEK' | 'SET_SPEED' | 'STOP';

export type ReplaySessionStatus = 'playing' | 'paused' | 'ended' | 'stopped';

export interface ReplaySessionInfo {
  sessionId: string;
  originalMatchId: string;
  totalFrames: number;
  cursor: number;
  playing: boolean;
  speedMs: number;
  status: ReplaySessionStatus;
}

interface ReplaySessionRecord {
  sessionId: string;
  originalMatchId: string;
  frames: SerializedFrame[];
  cursor: number;
  playing: boolean;
  speedMs: number;
  status: ReplaySessionStatus;
  timer: ReturnType<typeof setTimeout> | null;
  endedAtMs: number | null;
  /**
   * Sticky pointer at the most recently published frame on this session's
   * `gameStateChanged(sessionId)` channel. Updated on every `publishFrame`
   * path (initial sync emit, scheduled tick, SEEK).
   *
   * Consumed by the `gameStateChanged` subscription resolver for replay
   * sessions so late subscribers (who join AFTER the pubsub event fired)
   * still receive the last frame as the first value in their iterator —
   * otherwise GameBoard would mount to an empty channel on short matches.
   */
  lastEmittedFrame: SerializedFrame | null;
}

export const DEFAULT_REPLAY_SPEED_MS = 600;
export const MIN_REPLAY_SPEED_MS = 100;
export const MAX_REPLAY_SPEED_MS = 5_000;
export const MAX_CONCURRENT_SESSIONS = 20;
export const ENDED_SESSION_TTL_MS = 10 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 1000;

const REPLAY_REGISTRY = new Map<string, ReplaySessionRecord>();

const clampSpeed = (value: number | null | undefined): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_REPLAY_SPEED_MS;
  return Math.max(MIN_REPLAY_SPEED_MS, Math.min(MAX_REPLAY_SPEED_MS, Math.floor(n)));
};

const toInfo = (record: ReplaySessionRecord): ReplaySessionInfo => ({
  sessionId: record.sessionId,
  originalMatchId: record.originalMatchId,
  totalFrames: record.frames.length,
  cursor: record.cursor,
  playing: record.playing,
  speedMs: record.speedMs,
  status: record.status
});

const clearTimer = (record: ReplaySessionRecord): void => {
  if (record.timer) {
    clearTimeout(record.timer);
    record.timer = null;
  }
};

/** Minimum gap before the SECOND frame fires, to give clients a mount window. */
const FIRST_GAP_MIN_MS = 500;

/**
 * Publish a single frame to this session's `gameStateChanged` pubsub channel
 * AND update the sticky `lastEmittedFrame` pointer so late subscribers can
 * still receive the most recent frame when they join after the pubsub event.
 */
const publishFrame = (record: ReplaySessionRecord, frame: SerializedFrame): void => {
  record.lastEmittedFrame = frame;
  try {
    publishGameStateChange(record.sessionId, frame);
  } catch (error) {
    logger.warn('[REPLAY] frame publish failed', {
      sessionId: record.sessionId,
      error
    });
  }
};

const extractMatchResult = (frame: SerializedFrame | undefined): any | null => {
  if (!frame) return null;
  // `serializeGameState` shape: we rely only on winner + status here.
  const winner = (frame as any).winner ?? null;
  const status = (frame as any).status ?? null;
  const endReason = (frame as any).endReason ?? null;
  if (!winner && !status) return null;
  return { winner, status, reason: endReason };
};

const finishSession = (record: ReplaySessionRecord): void => {
  clearTimer(record);
  record.playing = false;
  record.status = 'ended';
  record.endedAtMs = Date.now();

  const lastFrame = record.frames[record.frames.length - 1];
  const result = extractMatchResult(lastFrame);
  if (result) {
    try {
      publishMatchCompletion(record.sessionId, result);
    } catch (error) {
      logger.warn('[REPLAY] match-completion publish failed', {
        sessionId: record.sessionId,
        error
      });
    }
  }
};

/**
 * Schedule the next frame emission.
 *
 * `firstGap` (default false) bumps the delay before the NEXT tick to
 * `max(speedMs, FIRST_GAP_MIN_MS)`. This is used exactly once — right after
 * `startReplaySession` publishes frames[0] synchronously — to give the
 * GameBoard client enough time to mount its subscription before frames[1]
 * arrives. Short bot matches at default speedMs=600 can otherwise finish
 * before React mounts, producing an empty replay channel.
 */
const scheduleNext = (record: ReplaySessionRecord, firstGap = false): void => {
  clearTimer(record);
  if (!record.playing) return;
  const delay = firstGap ? Math.max(record.speedMs, FIRST_GAP_MIN_MS) : record.speedMs;
  record.timer = setTimeout(() => {
    // Re-fetch the record in case it was stopped while waiting.
    const live = REPLAY_REGISTRY.get(record.sessionId);
    if (!live || live !== record) return;
    if (record.status === 'stopped') return;

    if (record.cursor >= record.frames.length) {
      finishSession(record);
      return;
    }

    const frame = record.frames[record.cursor];
    publishFrame(record, frame);
    record.cursor += 1;

    if (record.cursor >= record.frames.length) {
      finishSession(record);
      return;
    }
    scheduleNext(record);
  }, delay);
  // Allow the process to exit even if a timer is live.
  if (typeof (record.timer as any)?.unref === 'function') {
    (record.timer as any).unref();
  }
};

const prune = (): void => {
  const now = Date.now();
  for (const [sessionId, record] of REPLAY_REGISTRY) {
    if (record.status === 'ended' || record.status === 'stopped') {
      if (record.endedAtMs && now - record.endedAtMs >= ENDED_SESSION_TTL_MS) {
        clearTimer(record);
        REPLAY_REGISTRY.delete(sessionId);
      }
    }
  }
};

const pruneTimer = setInterval(prune, PRUNE_INTERVAL_MS);
if (typeof (pruneTimer as any)?.unref === 'function') {
  (pruneTimer as any).unref();
}

const enforceConcurrencyCap = (): void => {
  if (REPLAY_REGISTRY.size < MAX_CONCURRENT_SESSIONS) return;
  // Prefer to drop ended/stopped sessions first (LRU by endedAt), then
  // finally fall back to stopping the oldest active session if we're still
  // at the cap.
  const candidates = Array.from(REPLAY_REGISTRY.values())
    .filter((r) => r.status === 'ended' || r.status === 'stopped')
    .sort((a, b) => (a.endedAtMs ?? 0) - (b.endedAtMs ?? 0));
  while (REPLAY_REGISTRY.size >= MAX_CONCURRENT_SESSIONS && candidates.length > 0) {
    const victim = candidates.shift()!;
    clearTimer(victim);
    REPLAY_REGISTRY.delete(victim.sessionId);
  }
  if (REPLAY_REGISTRY.size >= MAX_CONCURRENT_SESSIONS) {
    throw new Error('Replay session cap reached');
  }
};

export interface StartReplaySessionOptions {
  originalMatchId: string;
  speedMs?: number | null;
}

export const startReplaySession = (
  opts: StartReplaySessionOptions
): ReplaySessionInfo => {
  const { originalMatchId } = opts;
  if (!originalMatchId) {
    throw new Error('originalMatchId is required');
  }
  let frames = getFrames(originalMatchId);
  if (frames.length === 0) {
    const outcome = reconstructFramesForMatch(originalMatchId);
    if (outcome.ok) {
      logger.info('[REPLAY] reconstructed frames from self-play harness', {
        originalMatchId,
        framesRecorded: outcome.framesRecorded
      });
      frames = getFrames(originalMatchId);
    } else {
      logger.info('[REPLAY] frame reconstruction skipped', {
        originalMatchId,
        reason: outcome.reason
      });
    }
  }
  if (frames.length === 0) {
    throw new Error(`No replay frames available for match ${originalMatchId}`);
  }

  enforceConcurrencyCap();

  const sessionId = `replay-${randomUUID()}`;
  const speedMs = clampSpeed(opts.speedMs ?? DEFAULT_REPLAY_SPEED_MS);
  const record: ReplaySessionRecord = {
    sessionId,
    originalMatchId,
    frames,
    cursor: 0,
    playing: true,
    speedMs,
    status: 'playing',
    timer: null,
    endedAtMs: null,
    lastEmittedFrame: null
  };
  REPLAY_REGISTRY.set(sessionId, record);

  // Emit frames[0] SYNCHRONOUSLY before returning so any subscriber who
  // already has a live asyncIterator on `gameStateChanged(sessionId)`
  // receives a frame immediately. Late subscribers will not get this event
  // over pubsub; they receive the sticky `lastEmittedFrame` via the
  // `withInitialFrame` wrapper in the subscription resolver.
  publishFrame(record, frames[0]);
  record.cursor = 1;

  // If we've already consumed every frame (single-frame matches), finish
  // cleanly instead of scheduling a tick to nothing.
  if (record.cursor >= record.frames.length) {
    finishSession(record);
    return toInfo(record);
  }

  // Use a longer initial gap before frames[1] so GameBoard has time to mount
  // its subscription — see `scheduleNext` doc. Normal cadence resumes from
  // frames[2] onwards.
  scheduleNext(record, true);
  return toInfo(record);
};

export interface ControlReplayOptions {
  action: ReplayAction;
  speedMs?: number | null;
  cursor?: number | null;
}

export const controlReplaySession = (
  sessionId: string,
  opts: ControlReplayOptions
): ReplaySessionInfo => {
  const record = REPLAY_REGISTRY.get(sessionId);
  if (!record) {
    throw new Error(`Unknown replay session: ${sessionId}`);
  }

  const { action } = opts;
  switch (action) {
    case 'PLAY': {
      if (record.status === 'stopped') {
        throw new Error('Cannot resume a stopped session');
      }
      if (record.cursor >= record.frames.length) {
        // Already at end; report ended state.
        record.status = 'ended';
        record.playing = false;
        return toInfo(record);
      }
      record.playing = true;
      record.status = 'playing';
      scheduleNext(record);
      return toInfo(record);
    }
    case 'PAUSE': {
      if (record.status === 'stopped') return toInfo(record);
      record.playing = false;
      if (record.status !== 'ended') record.status = 'paused';
      clearTimer(record);
      return toInfo(record);
    }
    case 'SEEK': {
      if (record.status === 'stopped') {
        throw new Error('Cannot seek a stopped session');
      }
      const raw = Number(opts.cursor);
      if (!Number.isFinite(raw)) {
        throw new Error('SEEK requires a numeric cursor');
      }
      const clamped = Math.max(0, Math.min(record.frames.length - 1, Math.floor(raw)));
      record.cursor = clamped;
      // Immediately publish the frame at the new cursor so subscribers render
      // the seek target without waiting for the next tick. `publishFrame`
      // also keeps the sticky `lastEmittedFrame` in sync.
      const frame = record.frames[clamped];
      if (frame) {
        publishFrame(record, frame);
        record.cursor = clamped + 1;
      }
      // If we were ended, bring back into paused state so PLAY can resume.
      if (record.status === 'ended' && record.cursor < record.frames.length) {
        record.status = 'paused';
        record.endedAtMs = null;
      }
      if (record.playing && record.status !== 'ended') {
        scheduleNext(record);
      }
      return toInfo(record);
    }
    case 'SET_SPEED': {
      if (record.status === 'stopped') {
        throw new Error('Cannot change speed of a stopped session');
      }
      record.speedMs = clampSpeed(opts.speedMs ?? record.speedMs);
      if (record.playing && record.status !== 'ended') {
        scheduleNext(record);
      }
      return toInfo(record);
    }
    case 'STOP': {
      clearTimer(record);
      record.playing = false;
      record.status = 'stopped';
      record.endedAtMs = Date.now();
      REPLAY_REGISTRY.delete(sessionId);
      return toInfo(record);
    }
    default: {
      throw new Error(`Unknown replay action: ${String(action)}`);
    }
  }
};

export const getReplaySession = (sessionId: string): ReplaySessionInfo | null => {
  const record = REPLAY_REGISTRY.get(sessionId);
  if (!record) return null;
  return toInfo(record);
};

/**
 * Return the most recent frame published on this session's `gameStateChanged`
 * channel, or `null` if the session is unknown or nothing has been emitted
 * yet. Used by the subscription resolver to seed late subscribers so
 * GameBoard never mounts to an empty channel on short/replayed matches.
 */
export const getReplaySessionLastFrame = (
  sessionId: string
): SerializedFrame | null => {
  const record = REPLAY_REGISTRY.get(sessionId);
  if (!record) return null;
  return record.lastEmittedFrame;
};

/**
 * Return a best-effort view of the replay session state for the synthesized
 * `match(replay-*)` / `playerMatch(replay-*, playerId)` resolvers. Callers
 * receive the sticky `lastEmittedFrame` when available, otherwise fall back
 * to `frames[cursor]` or `frames[0]`. Returns `null` for unknown sessions.
 */
export const getReplaySessionViewFrame = (
  sessionId: string
): SerializedFrame | null => {
  const record = REPLAY_REGISTRY.get(sessionId);
  if (!record) return null;
  if (record.lastEmittedFrame) return record.lastEmittedFrame;
  if (record.cursor >= 0 && record.cursor < record.frames.length) {
    return record.frames[record.cursor] ?? null;
  }
  return record.frames[0] ?? null;
};

/**
 * Clear every timer and drop every session record. Intended for graceful
 * shutdown and for test teardown so Jest does not keep the event loop alive.
 */
export const stopAllReplaySessions = (): number => {
  let count = 0;
  for (const [sessionId, record] of REPLAY_REGISTRY) {
    clearTimer(record);
    REPLAY_REGISTRY.delete(sessionId);
    count += 1;
  }
  return count;
};

export const __listReplaySessions = (): ReplaySessionInfo[] => {
  return Array.from(REPLAY_REGISTRY.values()).map(toInfo);
};
