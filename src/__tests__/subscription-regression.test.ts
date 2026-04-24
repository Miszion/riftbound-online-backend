/**
 * Regression test: graphql-ws WebSocket server must be mounted on the HTTP
 * server so GraphQL subscriptions actually deliver events.
 *
 * Bug history: `useServer({ schema }, wsServer)` was omitted from server.ts
 * so the spectator page connected (the WebSocketServer was accepting raw
 * sockets) but no graphql-ws protocol handler was attached. Subscriptions
 * silently never fired while bot matches were progressing server-side.
 *
 * What this test does:
 *   1. Boots the real backend on a random free port (port 0).
 *   2. Fires the `startBotMatch` mutation over HTTP /graphql.
 *   3. Subscribes to `gameStateChanged(matchId)` over ws:// /graphql.
 *   4. Asserts that at least 3 frames arrive within 10 seconds.
 *
 * If the WS handler is not mounted, either the subscription never connects
 * or zero frames arrive, and this test fails.
 *
 * DynamoDB / auth notes:
 *   We set ALLOW_LOCAL_BYPASS=true so auth middleware short-circuits to a
 *   local user id and match-routes uses its in-memory snapshot store instead
 *   of DynamoDB. MATCHMAKING_QUEUE_WORKER=false stops the SQS poller so the
 *   test does not hit AWS. This mirrors how match-routes tests already
 *   exercise the in-memory path.
 */

process.env.ALLOW_LOCAL_BYPASS = 'true';
process.env.MATCHMAKING_QUEUE_WORKER = 'false';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.DISABLE_CORS = 'true';

import { createClient, Client as WsClient } from 'graphql-ws';
import WebSocket from 'ws';
import http from 'http';

import { createServer, CreatedServer } from '../server';
import { cancelBotMatch } from '../bot-match';

const SUBSCRIPTION_QUERY = `
  subscription GameStateChanged($matchId: ID!) {
    gameStateChanged(matchId: $matchId) {
      matchId
      turnNumber
      currentPhase
      status
    }
  }
`;

const START_BOT_MATCH_MUTATION = `
  mutation StartBotMatch($strategyA: String, $strategyB: String, $intervalMs: Int) {
    startBotMatch(strategyA: $strategyA, strategyB: $strategyB, intervalMs: $intervalMs) {
      matchId
      players
      strategies
      spectatorPath
    }
  }
`;

const httpPostJson = (url: string, body: unknown, headers: Record<string, string> = {}): Promise<any> =>
  new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': payload.length,
          'x-user-id': 'regression-tester',
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(new Error(`Non-JSON response (${res.statusCode}): ${raw.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });

describe('Regression: graphql-ws subscription delivery', () => {
  jest.setTimeout(30_000);

  let server: CreatedServer | null = null;
  let wsClient: WsClient | null = null;
  let startedMatchId: string | null = null;

  afterEach(async () => {
    if (startedMatchId) {
      try {
        cancelBotMatch(startedMatchId);
      } catch {
        // ignore
      }
      startedMatchId = null;
    }
    if (wsClient) {
      try {
        await wsClient.dispose();
      } catch {
        // ignore
      }
      wsClient = null;
    }
    if (server) {
      try {
        await server.close();
      } catch {
        // ignore
      }
      server = null;
    }
    // Give the bot driver one tick to observe the cancel flag and bail out of
    // its setTimeout loop before Jest tears down the module environment.
    await new Promise((resolve) => setTimeout(resolve, 400));
  });

  it('delivers at least 3 gameStateChanged frames via ws:// within 10 seconds of subscribing', async () => {
    server = await createServer(0);
    const { port } = server;

    // Fire the startBotMatch mutation over HTTP first so we know the matchId
    // before we subscribe. intervalMs=200 keeps frames arriving quickly.
    const mutationResult = await httpPostJson(`http://127.0.0.1:${port}/graphql`, {
      query: START_BOT_MATCH_MUTATION,
      variables: {
        strategyA: 'heuristic',
        strategyB: 'baseline',
        intervalMs: 200,
      },
    });

    expect(mutationResult.errors).toBeUndefined();
    const matchId: string | undefined = mutationResult?.data?.startBotMatch?.matchId;
    expect(typeof matchId).toBe('string');
    expect(matchId).toMatch(/^bot-/);
    startedMatchId = matchId!;

    // Connect graphql-ws client. connectionParams mirror what the spectator
    // page sends: an x-user-id header is enough because ALLOW_LOCAL_BYPASS
    // is on and the ws context resolver reads it directly.
    wsClient = createClient({
      url: `ws://127.0.0.1:${port}/graphql`,
      webSocketImpl: WebSocket,
      lazy: false,
      retryAttempts: 0,
      connectionParams: {
        'x-user-id': 'regression-tester',
      },
    });

    const frames: any[] = [];
    const firstFrameDeadlineMs = 10_000;

    // Wrap the subscription iterable in a Promise that resolves when we have
    // 3 frames OR rejects on error. The test times out if neither happens.
    const subscriptionSettled = new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(
          new Error(
            `subscription regression: received ${frames.length} gameStateChanged frames in ${firstFrameDeadlineMs}ms, expected at least 3. ` +
              'Most likely useServer({ schema }, wsServer) is not wired onto the HTTP server in src/server.ts.'
          )
        );
      }, firstFrameDeadlineMs);

      const unsubscribe = wsClient!.subscribe(
        {
          query: SUBSCRIPTION_QUERY,
          variables: { matchId },
        },
        {
          next: (payload) => {
            frames.push(payload);
            if (frames.length >= 3) {
              clearTimeout(timeoutId);
              try {
                unsubscribe();
              } catch {
                // ignore
              }
              resolve();
            }
          },
          error: (err) => {
            clearTimeout(timeoutId);
            reject(err instanceof Error ? err : new Error(JSON.stringify(err)));
          },
          complete: () => {
            // Do not resolve on complete alone; we want frames, not just a
            // clean close (an unmounted handler would emit zero frames and
            // then cleanly close if anything).
          },
        }
      );
    });

    await subscriptionSettled;

    expect(frames.length).toBeGreaterThanOrEqual(3);
    for (const frame of frames) {
      expect(frame.errors).toBeUndefined();
      expect(frame?.data?.gameStateChanged?.matchId).toBe(matchId);
    }
  });
});
