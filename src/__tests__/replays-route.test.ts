/**
 * Tests for the GET /replays/:matchId deep-link endpoint and GET /replays
 * index endpoint wired up in src/match-routes.ts.
 *
 * The route must:
 *   - Return 404 with an error body when no frames exist for the matchId
 *   - Return persisted frames from the persistent store when they exist
 *   - Honor offset and limit query params with sensible clamping
 *   - Echo matchId, source, frameCount, offset, limit so thin clients can
 *     render without a second round-trip
 *   - List every matchId present in the persistent store via GET /replays
 */

// ---------------------------------------------------------------------------
// Mocks — hoisted by Jest before imports
// ---------------------------------------------------------------------------

jest.mock('dotenv/config', () => ({}));

jest.mock('../logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }
}));

// LOCAL_BYPASS mode keeps the route off DynamoDB so the test suite does not
// need a realistic AWS mock.
process.env.ALLOW_LOCAL_BYPASS = 'true';

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

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

import { registerMatchRoutes } from '../match-routes';
import {
  bootstrap,
  persistFrame,
  __resetPersistentFrameCache,
  __setReplayFrameStoreDirForTests,
  __wipeReplayFrameStoreForTests
} from '../replay/replay-frame-store';
import { GamePhase } from '../game-engine';
import { makeMatchState, makePlayerState } from './helpers/matchState';

const makeFrame = (matchId: string, i: number) =>
  makeMatchState({
    matchId,
    turnNumber: i,
    currentPhase: GamePhase.MAIN_1,
    players: [
      makePlayerState({ playerId: `${matchId}:A`, victoryPoints: i }),
      makePlayerState({ playerId: `${matchId}:B`, victoryPoints: 0 })
    ]
  });

// registerMatchRoutes guards against duplicate registration with a module
// singleton flag, so we build the app exactly once and reset the store dir
// between tests instead.
const app: express.Express = express();
app.use(express.json());
registerMatchRoutes(app);

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'replays-route-'));
  __setReplayFrameStoreDirForTests(tmpRoot);
  bootstrap(tmpRoot);
});

afterEach(() => {
  try {
    __wipeReplayFrameStoreForTests();
  } catch {
    // ignore
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('GET /replays/:matchId', () => {
  it('returns 404 when no frames exist', async () => {
    const response = await request(app).get('/replays/bot-missing');
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ matchId: 'bot-missing' });
  });

  it('returns persisted frames when the match is in the store', async () => {
    for (let i = 0; i < 5; i++) {
      persistFrame('bot-persisted', makeFrame('bot-persisted', i));
    }
    const response = await request(app).get('/replays/bot-persisted');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      matchId: 'bot-persisted',
      source: 'persistent',
      frameCount: 5,
      offset: 0
    });
    expect(response.body.frames).toHaveLength(5);
    expect(response.body.frames[0].turnNumber).toBe(0);
    expect(response.body.frames[4].turnNumber).toBe(4);
  });

  it('honors offset and limit query parameters', async () => {
    for (let i = 0; i < 10; i++) {
      persistFrame('bot-paging', makeFrame('bot-paging', i));
    }
    const response = await request(app)
      .get('/replays/bot-paging')
      .query({ offset: 3, limit: 4 });
    expect(response.status).toBe(200);
    expect(response.body.frameCount).toBe(10);
    expect(response.body.offset).toBe(3);
    expect(response.body.limit).toBe(4);
    expect(response.body.frames).toHaveLength(4);
    expect(response.body.frames[0].turnNumber).toBe(3);
    expect(response.body.frames[3].turnNumber).toBe(6);
  });

  it('survives a simulated process restart', async () => {
    for (let i = 0; i < 3; i++) {
      persistFrame('bot-restart', makeFrame('bot-restart', i));
    }
    // Simulate restart: drop the in-memory cache. On-disk JSONL remains.
    __resetPersistentFrameCache();

    const response = await request(app).get('/replays/bot-restart');
    expect(response.status).toBe(200);
    expect(response.body.frameCount).toBe(3);
    expect(response.body.frames.map((f: any) => f.turnNumber)).toEqual([0, 1, 2]);
  });
});

describe('GET /replays (index)', () => {
  it('returns every matchId in the store', async () => {
    persistFrame('bot-a', makeFrame('bot-a', 0));
    persistFrame('bot-b', makeFrame('bot-b', 0));
    const response = await request(app).get('/replays');
    expect(response.status).toBe(200);
    expect(response.body.count).toBe(2);
    expect((response.body.matches as string[]).sort()).toEqual(['bot-a', 'bot-b']);
  });

  it('returns an empty list when nothing has been persisted', async () => {
    const response = await request(app).get('/replays');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ count: 0, matches: [] });
  });
});
