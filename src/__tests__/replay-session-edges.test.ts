/**
 * Edge-case coverage for the replay-session pipeline.
 *
 * Complements replay-session.test.ts by poking the corner cases that the
 * happy-path suite doesn't exercise:
 *   1. A match with exactly 1 frame still emits, then ends cleanly.
 *   2. The per-match frame cap (MAX_FRAMES_PER_MATCH=500) drops oldest
 *      frames rather than throwing, and startReplaySession snapshots the
 *      already-trimmed list.
 *   3. A late subscriber to `gameStateChanged(sessionId)` that joins AFTER
 *      the session has finished receives NOTHING on its own channel
 *      (confirms there is no "replay the last frame to new subscribers"
 *      mechanism — relevant UX caveat for GameBoard mount timing).
 *
 * These tests drive the pubsub layer directly, mirroring the approach in
 * replay-session.test.ts. No HTTP/WS server is booted.
 */

process.env.ALLOW_LOCAL_BYPASS = 'true';
process.env.MATCHMAKING_QUEUE_WORKER = 'false';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.DISABLE_CORS = 'true';

import {
  recordFrame,
  getFrameCount,
  MAX_FRAMES_PER_MATCH,
  __resetReplayFrameStore
} from '../replay-frame-store';
import {
  startReplaySession,
  controlReplaySession,
  getReplaySession,
  getReplaySessionLastFrame,
  stopAllReplaySessions
} from '../replay-session';
import { pubSub, SubscriptionEvents } from '../graphql/pubsub';
import { queryResolvers, subscriptionResolvers } from '../graphql/resolvers';

const makeFrame = (matchId: string, turnNumber: number) => ({
  matchId,
  turnNumber,
  currentPhase: 'main',
  status: 'in_progress',
  winner: null,
  endReason: null
});

describe('replay-session edge cases', () => {
  jest.setTimeout(15_000);

  afterEach(() => {
    stopAllReplaySessions();
    __resetReplayFrameStore();
  });

  it('single-frame match: publishes the only frame, ends cleanly', async () => {
    const matchId = 'edge-single-frame';
    recordFrame(matchId, makeFrame(matchId, 0) as any);

    const info = startReplaySession({ originalMatchId: matchId, speedMs: 100 });
    expect(info.totalFrames).toBe(1);

    // `startReplaySession` now publishes frames[0] SYNCHRONOUSLY before
    // returning (P0.1 fix), so a raw pubsub subscriber created after this
    // call would miss the event. Exercise the resolver path instead, which
    // uses `withInitialFrame` to seed late subscribers on replay sessions.
    const iter = (subscriptionResolvers.gameStateChanged.subscribe(
      null,
      { matchId: info.sessionId }
    ) as unknown) as AsyncIterator<{ gameStateChanged: any }>;
    const timer = setTimeout(() => iter.return?.(undefined).catch(() => undefined), 1_500);
    const { value } = await iter.next();
    clearTimeout(timer);
    iter.return?.(undefined).catch(() => undefined);

    expect(value?.gameStateChanged?.matchId).toBe(matchId);

    // Wait a tick so the scheduleNext end-of-frames branch runs. On
    // single-frame matches `startReplaySession` now finishes the session
    // eagerly (no tick needed), so this is a belt-and-suspenders check.
    await new Promise((r) => setTimeout(r, 200));
    const after = getReplaySession(info.sessionId);
    expect(after?.status).toBe('ended');
    expect(after?.playing).toBe(false);
  });

  it('per-match cap: recording >500 frames keeps only the most recent 500, replay snapshots the trimmed list', () => {
    const matchId = 'edge-frame-cap';
    const OVER = MAX_FRAMES_PER_MATCH + 10;
    for (let i = 0; i < OVER; i++) {
      recordFrame(matchId, makeFrame(matchId, i) as any);
    }
    expect(getFrameCount(matchId)).toBe(MAX_FRAMES_PER_MATCH);

    const info = startReplaySession({ originalMatchId: matchId, speedMs: 5_000 });
    expect(info.totalFrames).toBe(MAX_FRAMES_PER_MATCH);

    // Pause immediately so no frames emit during teardown.
    controlReplaySession(info.sessionId, { action: 'PAUSE' });
  });

  it('P0.1 fix: immediate subscriber on a fresh session receives frames[0] on the first tick (<50ms)', async () => {
    // Regression: GameBoard mounted before startReplaySession returns. The
    // session must publish frames[0] synchronously so this subscriber sees
    // a frame even on single-frame matches, without waiting for speedMs.
    const matchId = 'edge-immediate-sub';
    for (let i = 0; i < 3; i++) {
      recordFrame(matchId, makeFrame(matchId, i) as any);
    }

    // Precompute the sessionId by intercepting startReplaySession's return
    // value; subscribe AFTER start but race the publish with a 50ms budget.
    // We use speedMs=5000 so the SECOND frame cannot arrive inside the
    // window — only the synchronous frames[0] emit can satisfy the test.
    const info = startReplaySession({ originalMatchId: matchId, speedMs: 5_000 });

    // Subscribing here — i.e. after the synchronous publish — confirms the
    // sticky `lastEmittedFrame` path, since the raw pubsub event already
    // fired. The resolver wraps this with `withInitialFrame` for replay ids.
    const iter = (subscriptionResolvers.gameStateChanged.subscribe(
      null,
      { matchId: info.sessionId }
    ) as unknown) as AsyncIterator<{ gameStateChanged: any }>;

    const start = Date.now();
    const timer = setTimeout(() => iter.return?.(undefined).catch(() => undefined), 500);
    const { value } = await iter.next();
    const elapsed = Date.now() - start;
    clearTimeout(timer);
    iter.return?.(undefined).catch(() => undefined);

    expect(value?.gameStateChanged?.matchId).toBe(matchId);
    expect(elapsed).toBeLessThan(50);

    controlReplaySession(info.sessionId, { action: 'STOP' });
  });

  it('P0.1 fix: late subscriber after session ends STILL receives the final frame via withInitialFrame', async () => {
    // Regression: the old raw-pubsub test below documents that pubsub alone
    // drops late subscribers. This test asserts the resolver-level fix: the
    // gameStateChanged resolver seeds replay subscribers with the sticky
    // last frame so GameBoard has something to render on late mounts.
    const matchId = 'edge-late-sub-fix';
    for (let i = 0; i < 3; i++) {
      recordFrame(matchId, makeFrame(matchId, i) as any);
    }
    const info = startReplaySession({ originalMatchId: matchId, speedMs: 100 });

    // Wait for all 3 frames to emit and the session to end.
    await new Promise((r) => setTimeout(r, 900));
    const ended = getReplaySession(info.sessionId);
    expect(ended?.status).toBe('ended');

    // Sticky pointer must be populated.
    const lastFrame = getReplaySessionLastFrame(info.sessionId);
    expect(lastFrame).not.toBeNull();

    // Subscribe via the RESOLVER path (not raw pubsub) to exercise the
    // withInitialFrame wrapper. First value MUST be the final frame.
    const iter = (subscriptionResolvers.gameStateChanged.subscribe(
      null,
      { matchId: info.sessionId }
    ) as unknown) as AsyncIterator<{ gameStateChanged: any }>;

    const timer = setTimeout(() => iter.return?.(undefined).catch(() => undefined), 500);
    const { value } = await iter.next();
    clearTimeout(timer);
    iter.return?.(undefined).catch(() => undefined);

    expect(value?.gameStateChanged).not.toBeNull();
    expect(value?.gameStateChanged?.matchId).toBe(matchId);
    expect(value?.gameStateChanged?.turnNumber).toBe(2); // last recorded frame
  });

  it('P0.2 fix: match(replay-<sessionId>) resolver returns a non-null view with matchId === sessionId', async () => {
    // Regression: the replay sessionId is not a DB match row, so the match
    // resolver previously threw "Match not found". It must now synthesize
    // the view from the session's last-emitted frame and override matchId
    // so GameBoard's `useMatch` hook receives the replay sessionId, not the
    // underlying bot match row id.
    const matchId = 'edge-match-resolver';
    for (let i = 0; i < 2; i++) {
      recordFrame(matchId, makeFrame(matchId, i) as any);
    }
    const info = startReplaySession({ originalMatchId: matchId, speedMs: 5_000 });

    const view = await (queryResolvers as any).match(
      null,
      { matchId: info.sessionId },
      { authToken: null }
    );

    expect(view).not.toBeNull();
    // `matchId` must be the replay sessionId, not the original bot match id,
    // so the frontend can keep keying off the replay id end-to-end.
    expect(view.matchId).toBe(info.sessionId);

    controlReplaySession(info.sessionId, { action: 'STOP' });
  });

  it('late subscriber after session ends gets NO frames on its own channel (documents UX gap)', async () => {
    const matchId = 'edge-late-subscriber';
    for (let i = 0; i < 3; i++) {
      recordFrame(matchId, makeFrame(matchId, i) as any);
    }
    const info = startReplaySession({ originalMatchId: matchId, speedMs: 100 });

    // Wait long enough for all 3 frames to emit and the session to `end`.
    await new Promise((r) => setTimeout(r, 800));
    const ended = getReplaySession(info.sessionId);
    expect(ended?.status).toBe('ended');

    // Subscribe AFTER end, confirm nothing arrives in 500ms.
    const iter = pubSub.asyncIterator<{ gameStateChanged: any }>([
      `${SubscriptionEvents.GAME_STATE_CHANGED}:${info.sessionId}`
    ]);
    let got: any = null;
    const timer = setTimeout(() => iter.return?.().catch(() => undefined), 500);
    const { value, done } = await iter.next();
    clearTimeout(timer);
    iter.return?.().catch(() => undefined);
    if (!done) got = value?.gameStateChanged ?? null;
    expect(got).toBeNull();
  });
});
