/**
 * BE-3: path-form spectatorPath for /spectate/[matchId] route.
 *
 * Spec: /Users/miszion/workplace/nexus-data/plans/riftbound-online/bot-v-bot-flow-spec-2026-04-24.md
 *
 * Verifies that startBotMatch returns a path-form spectatorPath
 * (`/spectate/<matchId>`), not the legacy query-string form
 * (`/spectate?matchId=<matchId>`). FE-1 will consume this to wire the
 * Next.js route `/spectate/[matchId]`.
 *
 * Harness pattern mirrors bot-match-spectator-safe.test.ts: set
 * ALLOW_LOCAL_BYPASS before import so the match snapshot stays in-memory,
 * keep the driver's idle tick short, and cancel every started match in
 * afterEach so the setTimeout loop drains and doesn't keep the event loop
 * open past the test.
 */

// Must be set before any module import — bot-match.ts reads
// ALLOW_LOCAL_BYPASS at load time.
process.env.ALLOW_LOCAL_BYPASS = 'true';

// Keep the pruner interval long enough that it doesn't churn during the test.
process.env.BOT_MATCH_PRUNE_INTERVAL_MS = '60000';

import { startBotMatch, cancelBotMatch } from '../bot-match';

describe('BE-3: startBotMatch spectatorPath uses path form', () => {
  const activeMatches: string[] = [];

  afterEach(() => {
    while (activeMatches.length) {
      const matchId = activeMatches.pop()!;
      cancelBotMatch(matchId);
    }
  });

  it('returns spectatorPath as /spectate/<matchId> (path form)', async () => {
    const result = await startBotMatch({
      strategyA: 'aggro',
      strategyB: 'control',
      // Tight tick so the background loop drains quickly once we cancel.
      intervalMs: 50
    });
    activeMatches.push(result.matchId);

    // Exact shape: path segment, not query string.
    expect(result.spectatorPath).toBe(`/spectate/${result.matchId}`);

    // Regex guard: rejects the old `?matchId=` form and any accidental
    // nesting like `/spectate/foo/bar`. MatchId charset here matches the
    // bot-match id generator (bot-<hex>) plus common safe url chars.
    expect(result.spectatorPath).toMatch(/^\/spectate\/[A-Za-z0-9_-]+$/);
  });
});
