/**
 * BE-4: spectator-safe playerMatch for non-participants.
 *
 * Spec: /Users/miszion/workplace/nexus-data/plans/riftbound-online/bot-v-bot-flow-spec-2026-04-24.md
 * (task 5.1 BE-4, shipping order item #1, QA-4).
 *
 * Verifies the behaviour change documented in match-routes.ts
 * buildSpectatorViewSnapshot: a caller who asks
 *   GET /matches/:matchId/player/:playerId
 * with a playerId that isn't a participant of the live bot-vs-bot match
 * receives a spectator-safe envelope (canAct=false, currentPlayer populated
 * from players[0]) instead of a 500. Participant callers continue to see
 * their normal PlayerView.
 *
 * The test spins up a real `startBotMatch` (ALLOW_LOCAL_BYPASS=true keeps the
 * snapshot in an in-memory Map so there's no DynamoDB traffic), reads the
 * HTTP route through supertest to mirror what the GraphQL `playerMatch`
 * resolver does via `fetchPlayerView`, then cancels the driver in afterEach.
 */

// Must be set before any module import — bot-match.ts and match-routes.ts
// both read ALLOW_LOCAL_BYPASS at load time.
process.env.ALLOW_LOCAL_BYPASS = 'true';

// Keep the bot driver's idle tick short so the background loop doesn't fight
// the test runner for cycles after we cancel it.
process.env.BOT_MATCH_PRUNE_INTERVAL_MS = '60000';

import express from 'express';
import request from 'supertest';

import { registerMatchRoutes } from '../match-routes';
import { startBotMatch, cancelBotMatch } from '../bot-match';

const app = express();
app.use(express.json());
registerMatchRoutes(app);

describe('BE-4: GET /matches/:matchId/player/:playerId — spectator safety', () => {
  const activeMatches: string[] = [];

  afterEach(() => {
    // Stop the driver so the per-match async loop doesn't keep ticking after
    // the test exits. cancelBotMatch is sync and idempotent.
    while (activeMatches.length) {
      const matchId = activeMatches.pop()!;
      cancelBotMatch(matchId);
    }
  });

  it('returns a spectator envelope for a non-participant caller on a live bot match', async () => {
    const { matchId, players } = await startBotMatch({
      strategyA: 'aggro',
      strategyB: 'control',
      // Keep the idle tick tight so when afterEach cancels the driver, the
      // pending setTimeout drains fast and doesn't keep the event loop open.
      intervalMs: 50
    });
    activeMatches.push(matchId);

    // Sanity: the bot-match contract guarantees a synchronous initial
    // publishSpectatorState + persistEngineSnapshot before the mutation
    // returns (bot-match.ts). The snapshot must be immediately readable.
    expect(matchId).toMatch(/^bot-/);
    expect(players).toHaveLength(2);
    expect(players[0]).toBe('bot-aggro-A');
    expect(players[1]).toBe('bot-control-B');

    const res = await request(app).get(
      `/matches/${encodeURIComponent(matchId)}/player/stranger-user-id`
    );

    expect(res.status).toBe(200);
    expect(res.body).not.toBeNull();
    expect(res.body.matchId).toBe(matchId);
    // Populated from players[0] — the first bot's public view.
    expect(res.body.currentPlayer).toBeDefined();
    expect(res.body.currentPlayer.playerId).toBe(players[0]);
    // Opponent is the other bot.
    expect(res.body.opponent).toBeDefined();
    expect(res.body.opponent.playerId).toBe(players[1]);
    // Non-participants can never act. This is the flag downstream UI
    // (GameBoard spectator mode) keys off.
    expect(res.body.gameState).toBeDefined();
    expect(res.body.gameState.canAct).toBe(false);
    expect(res.body.gameState.matchId).toBe(matchId);
  });

  it('still returns the normal participant view for a real bot player id', async () => {
    const { matchId, players } = await startBotMatch({
      strategyA: 'aggro',
      strategyB: 'control',
      // Keep the idle tick tight so when afterEach cancels the driver, the
      // pending setTimeout drains fast and doesn't keep the event loop open.
      intervalMs: 50
    });
    activeMatches.push(matchId);

    const res = await request(app).get(
      `/matches/${encodeURIComponent(matchId)}/player/${encodeURIComponent(players[0])}`
    );

    expect(res.status).toBe(200);
    expect(res.body.matchId).toBe(matchId);
    // currentPlayer is the requested bot (participant view), regardless of phase.
    expect(res.body.currentPlayer).toBeDefined();
    expect(res.body.currentPlayer.playerId).toBe(players[0]);
    expect(res.body.opponent).toBeDefined();
    expect(res.body.opponent.playerId).toBe(players[1]);
    // canAct is phase/priority dependent for a real participant; we don't
    // assert its value, only that the field is present. The spec note:
    // "canAct may be true or false depending on phase".
    expect(typeof res.body.gameState.canAct).toBe('boolean');
  });
});
