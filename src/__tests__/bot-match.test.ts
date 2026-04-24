/**
 * bot-match.ts — real-engine integration tests for the bot-vs-bot live flow.
 *
 * Coverage targets (see /Users/miszion/workplace/nexus-data/plans/riftbound-online/
 * bot-v-bot-flow-spec-2026-04-24.md, tasks BE-1, BE-2, BE-3, BE-5):
 *   - BE-3: startBotMatch returns spectatorPath = `/spectate/<matchId>`
 *   - BE-5: startBotMatch result exposes the full strategies catalogue
 *   - BE-1: per-move serialized snapshots accumulate in the in-memory frame buffer
 *   - BE-2: listMatchFrames pages through the buffer and returns null for unknown ids
 *
 * No engine mocks. The driver is allowed to step the real RiftboundGameEngine via
 * dispatchAction (the same entry point the human HTTP path uses — see
 * src/match-routes.ts action handlers and src/self-play.ts:dispatchAction).
 */

// ---------------------------------------------------------------------------
// Mocks — DynamoDB and pubsub only. The engine is real.
// ---------------------------------------------------------------------------

jest.mock('dotenv/config', () => ({}));

jest.mock('../logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }
}));

// LOCAL_BYPASS=true makes match-routes.ts:saveGameState write to an in-memory
// Map and makes appendMatchFrames a no-op. This is the same mode the local dev
// server uses; it lets the test exercise the real bot driver without AWS.
process.env.ALLOW_LOCAL_BYPASS = 'true';

// AWS SDK still gets imported by match-routes.ts at module load. Provide a
// minimal mock so DocumentClient construction doesn't blow up in CI.
jest.mock('aws-sdk', () => {
  const noop = jest.fn().mockResolvedValue({});
  const queryEmpty = jest.fn().mockResolvedValue({ Items: [] });
  const getEmpty = jest.fn().mockResolvedValue({ Item: null });
  const clientInstance = {
    get: jest.fn().mockReturnValue({ promise: getEmpty }),
    put: jest.fn().mockReturnValue({ promise: noop }),
    query: jest.fn().mockReturnValue({ promise: queryEmpty }),
    update: jest.fn().mockReturnValue({ promise: noop }),
    batchWrite: jest.fn().mockReturnValue({ promise: noop }),
    delete: jest.fn().mockReturnValue({ promise: noop }),
    scan: jest.fn().mockReturnValue({ promise: queryEmpty })
  };
  const DocumentClient = jest.fn().mockImplementation(() => clientInstance);
  const SQS = jest.fn().mockImplementation(() => ({
    sendMessage: jest.fn().mockReturnValue({ promise: noop })
  }));
  return {
    __esModule: true,
    default: { DynamoDB: { DocumentClient }, SQS },
    DynamoDB: { DocumentClient },
    SQS
  };
});

// Spy on pubsub publishes so the driver doesn't try to wire actual subscribers.
jest.mock('../graphql/pubsub', () => ({
  publishGameStateChange: jest.fn(),
  publishPlayerGameStateChange: jest.fn(),
  publishMatchCompletion: jest.fn()
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  startBotMatch,
  listMatchFrames,
  listActiveBotMatches,
  cancelBotMatch,
  cancelAllBotMatches,
  getAvailableStrategies
} from '../bot-match';
import { publishGameStateChange } from '../graphql/pubsub';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  cancelAllBotMatches();
});

// ===========================================================================
// BE-3: spectatorPath uses /spectate/<matchId>
// ===========================================================================

describe('startBotMatch — spectatorPath (BE-3)', () => {
  it('returns a path-style spectator URL keyed on matchId', async () => {
    const result = await startBotMatch({
      strategyA: 'random',
      strategyB: 'random',
      // Long interval so the driver does not advance turns inside this assertion;
      // we only care about the post-init return value here.
      intervalMs: 5_000
    });
    expect(result.matchId).toMatch(/^bot-/);
    expect(result.spectatorPath).toBe(`/spectate/${encodeURIComponent(result.matchId)}`);
  });
});

// ===========================================================================
// BE-5: availableStrategies surfaced on the result
// ===========================================================================

describe('startBotMatch — availableStrategies (BE-5)', () => {
  it('returns the full strategies catalogue alongside the chosen pair', async () => {
    const result = await startBotMatch({
      strategyA: 'aggro',
      strategyB: 'control',
      intervalMs: 5_000
    });
    expect(result.strategies).toEqual(['aggro', 'control']);
    expect(result.availableStrategies).toEqual([
      'baseline',
      'heuristic',
      'random',
      'aggro',
      'control'
    ]);
    // The exported helper returns a fresh copy, not the underlying constant
    // (defensive against caller mutation).
    const a = getAvailableStrategies();
    const b = getAvailableStrategies();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});

// ===========================================================================
// BE-1: per-move serialized snapshots accumulate in the registry buffer
// ===========================================================================

describe('publishSpectatorState — frame buffer (BE-1)', () => {
  it('captures the post-init frame before the driver advances', async () => {
    const result = await startBotMatch({
      strategyA: 'random',
      strategyB: 'random',
      intervalMs: 5_000 // driver tick is far enough out that we observe the init frame
    });
    const frames = listMatchFrames(result.matchId);
    expect(frames).not.toBeNull();
    // At minimum the post-init frame must be present (publishSpectatorState
    // is invoked synchronously after REGISTRY.set in startBotMatch).
    expect(frames!.length).toBeGreaterThanOrEqual(1);
    const initial = frames![0];
    expect(initial.matchId).toBe(result.matchId);
    expect(initial.players).toHaveLength(2);
    expect(initial.players[0].playerId).toBe(result.players[0]);
  });

  it('grows the buffer as the driver dispatches engine actions', async () => {
    // Ensure frames are still mock-published before assertion (defensive).
    (publishGameStateChange as jest.Mock).mockClear();
    const result = await startBotMatch({
      strategyA: 'random',
      strategyB: 'random',
      intervalMs: 50
    });
    // Let the driver run a few ticks. The driver always calls publishSpectatorState
    // at least once per loop pass; with intervalMs=50 we expect several frames.
    await sleep(400);
    const frames = listMatchFrames(result.matchId);
    expect(frames).not.toBeNull();
    expect(frames!.length).toBeGreaterThan(1);
    // Every appended frame is a serialized state object (not the raw engine).
    for (const frame of frames!) {
      expect(frame.matchId).toBe(result.matchId);
      expect(typeof frame.turnNumber).toBe('number');
    }
    // The driver also reaches publishGameStateChange — the wire format for
    // live-spectate. Same payloads that go into the buffer.
    expect(publishGameStateChange).toHaveBeenCalled();
  });
});

// ===========================================================================
// BE-2: listMatchFrames offset/limit + unknown-id behavior
// ===========================================================================

describe('listMatchFrames — paging contract (BE-2)', () => {
  it('returns null for an unknown matchId (resolver falls back to DDB)', () => {
    expect(listMatchFrames('bot-does-not-exist')).toBeNull();
  });

  it('honors offset and limit', async () => {
    const result = await startBotMatch({
      strategyA: 'random',
      strategyB: 'random',
      intervalMs: 50
    });
    await sleep(400);
    const all = listMatchFrames(result.matchId)!;
    expect(all.length).toBeGreaterThan(2);
    const window = listMatchFrames(result.matchId, 1, 2)!;
    expect(window).toHaveLength(Math.min(2, all.length - 1));
    expect(window[0]).toEqual(all[1]);
  });
});

// ===========================================================================
// activeBotMatches summary excludes the buffer (smoke check)
// ===========================================================================

describe('listActiveBotMatches', () => {
  it('returns BotMatchSummary entries that omit cancelled and frames keys', async () => {
    const result = await startBotMatch({
      strategyA: 'random',
      strategyB: 'random',
      intervalMs: 5_000
    });
    const summaries = listActiveBotMatches();
    const summary = summaries.find((s) => s.matchId === result.matchId);
    expect(summary).toBeDefined();
    // The frames buffer is internal-only and must not leak into the public list.
    expect((summary as any).frames).toBeUndefined();
    expect((summary as any).cancelled).toBeUndefined();
    cancelBotMatch(result.matchId);
  });
});
