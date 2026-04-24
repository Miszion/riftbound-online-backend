/**
 * Unit tests for the persistent replay-frame store.
 *
 * Covers the contract the bot-vs-bot spec expects from src/replay/replay-frame-store.ts:
 *   - bootstrap() creates the directory on a fresh FS
 *   - persistFrame() assigns monotonic frame indices and appends to disk
 *   - readFrames() returns frames in insertion order, with offset/limit
 *   - readFrameCount() mirrors the number of appended frames
 *   - listPersistedMatches() enumerates every matchId with a file on disk
 *   - deleteMatch() clears both the in-memory cache and the file
 *   - Frames survive a simulated process restart (cache drop + fresh reads)
 *   - Malformed lines are skipped without crashing hydration
 *   - Unsafe matchIds are rejected so the store cannot escape its directory
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  bootstrap,
  persistFrame,
  readFrames,
  readFrameCount,
  listPersistedMatches,
  deleteMatch,
  getStoreDir,
  __resetPersistentFrameCache,
  __setReplayFrameStoreDirForTests,
  __wipeReplayFrameStoreForTests
} from '../replay/replay-frame-store';

jest.mock('../logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }
}));

const makeFrame = (matchId: string, i: number): any => ({
  matchId,
  turnNumber: i,
  currentPhase: i % 2 === 0 ? 'main_1' : 'end',
  players: [
    { id: `${matchId}:A`, score: i },
    { id: `${matchId}:B`, score: 0 }
  ]
});

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-frames-'));
  __setReplayFrameStoreDirForTests(tmpRoot);
  bootstrap(tmpRoot);
});

afterEach(() => {
  try {
    __wipeReplayFrameStoreForTests();
  } catch {
    // fall through - tmp cleanup below still runs
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('persistent replay-frame store - bootstrap', () => {
  it('creates the storage directory when it does not exist', () => {
    const nested = path.join(tmpRoot, 'child-dir-that-does-not-exist');
    expect(fs.existsSync(nested)).toBe(false);
    bootstrap(nested);
    expect(fs.existsSync(nested)).toBe(true);
    expect(getStoreDir()).toBe(nested);
  });

  it('is idempotent when the directory already exists', () => {
    expect(() => bootstrap(tmpRoot)).not.toThrow();
    expect(fs.existsSync(tmpRoot)).toBe(true);
  });
});

describe('persistent replay-frame store - persistFrame and readFrames', () => {
  it('assigns monotonic frame indices starting at 0', () => {
    expect(persistFrame('bot-m1', makeFrame('bot-m1', 0))).toBe(0);
    expect(persistFrame('bot-m1', makeFrame('bot-m1', 1))).toBe(1);
    expect(persistFrame('bot-m1', makeFrame('bot-m1', 2))).toBe(2);
    expect(readFrameCount('bot-m1')).toBe(3);
  });

  it('returns frames in insertion order', () => {
    for (let i = 0; i < 5; i++) {
      persistFrame('bot-order', makeFrame('bot-order', i));
    }
    const frames = readFrames('bot-order');
    expect(frames).toHaveLength(5);
    frames.forEach((frame, i) => {
      expect((frame as any).turnNumber).toBe(i);
    });
  });

  it('supports offset and limit slicing', () => {
    for (let i = 0; i < 10; i++) {
      persistFrame('bot-paging', makeFrame('bot-paging', i));
    }
    const window = readFrames('bot-paging', 3, 4);
    expect(window).toHaveLength(4);
    expect((window[0] as any).turnNumber).toBe(3);
    expect((window[3] as any).turnNumber).toBe(6);
  });

  it('returns an empty array for unknown matchIds', () => {
    expect(readFrames('bot-never-existed')).toEqual([]);
    expect(readFrameCount('bot-never-existed')).toBe(0);
  });

  it('persists to disk as newline-delimited JSON', () => {
    persistFrame('bot-disk', makeFrame('bot-disk', 0));
    persistFrame('bot-disk', makeFrame('bot-disk', 1));
    const filePath = path.join(getStoreDir(), 'bot-disk.jsonl');
    const text = fs.readFileSync(filePath, 'utf8');
    const lines = text.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first).toMatchObject({
      matchId: 'bot-disk',
      frameIndex: 0,
      state: expect.objectContaining({ turnNumber: 0 })
    });
    expect(typeof first.timestamp).toBe('number');
  });
});

describe('persistent replay-frame store - listPersistedMatches', () => {
  it('enumerates every matchId with a frame file', () => {
    persistFrame('bot-a', makeFrame('bot-a', 0));
    persistFrame('bot-b', makeFrame('bot-b', 0));
    persistFrame('bot-c', makeFrame('bot-c', 0));
    const matches = listPersistedMatches().sort();
    expect(matches).toEqual(['bot-a', 'bot-b', 'bot-c']);
  });

  it('returns an empty list when nothing has been persisted', () => {
    expect(listPersistedMatches()).toEqual([]);
  });
});

describe('persistent replay-frame store - restart survives', () => {
  it('returns persisted frames after an in-memory cache drop', () => {
    for (let i = 0; i < 4; i++) {
      persistFrame('bot-restart', makeFrame('bot-restart', i));
    }

    // Simulate process restart: drop the cache but leave the files on disk.
    __resetPersistentFrameCache();

    expect(readFrameCount('bot-restart')).toBe(4);
    const frames = readFrames('bot-restart');
    expect(frames).toHaveLength(4);
    frames.forEach((frame, i) => {
      expect((frame as any).turnNumber).toBe(i);
    });
  });

  it('rehydrates matches that were never touched by this process', () => {
    // Write directly to disk bypassing the module, then reset the cache.
    const matchId = 'bot-external-write';
    const filePath = path.join(getStoreDir(), `${matchId}.jsonl`);
    const lines = [0, 1, 2].map((i) =>
      JSON.stringify({
        matchId,
        frameIndex: i,
        timestamp: 1_700_000_000_000 + i,
        state: makeFrame(matchId, i)
      })
    );
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
    __resetPersistentFrameCache();

    expect(readFrameCount(matchId)).toBe(3);
    const frames = readFrames(matchId);
    expect(frames).toHaveLength(3);
    expect((frames[2] as any).turnNumber).toBe(2);
  });
});

describe('persistent replay-frame store - deleteMatch', () => {
  it('removes the file and clears the cache', () => {
    persistFrame('bot-del', makeFrame('bot-del', 0));
    persistFrame('bot-del', makeFrame('bot-del', 1));
    expect(readFrameCount('bot-del')).toBe(2);

    const removed = deleteMatch('bot-del');
    expect(removed).toBe(true);
    expect(fs.existsSync(path.join(getStoreDir(), 'bot-del.jsonl'))).toBe(false);
    expect(readFrameCount('bot-del')).toBe(0);
    expect(listPersistedMatches()).not.toContain('bot-del');
  });

  it('returns false when the match is not on disk', () => {
    expect(deleteMatch('bot-never')).toBe(false);
  });
});

describe('persistent replay-frame store - resilience', () => {
  it('stops at a malformed line but keeps earlier frames', () => {
    const matchId = 'bot-corrupt';
    const filePath = path.join(getStoreDir(), `${matchId}.jsonl`);
    const goodLines = [0, 1].map((i) =>
      JSON.stringify({
        matchId,
        frameIndex: i,
        timestamp: 1_700_000_000_000 + i,
        state: makeFrame(matchId, i)
      })
    );
    // Third line is not valid JSON. Hydration logs a warning and skips it; the
    // fourth line is out-of-sequence from the store's perspective (index 2
    // expected, index 3 given) so hydration stops - but the two valid leading
    // frames must still be readable.
    const corrupt = 'NOT JSON';
    const outOfOrder = JSON.stringify({
      matchId,
      frameIndex: 3,
      timestamp: 1_700_000_000_003,
      state: makeFrame(matchId, 3)
    });
    fs.writeFileSync(
      filePath,
      [...goodLines, corrupt, outOfOrder].join('\n') + '\n',
      'utf8'
    );
    __resetPersistentFrameCache();

    const frames = readFrames(matchId);
    expect(frames).toHaveLength(2);
    expect((frames[0] as any).turnNumber).toBe(0);
    expect((frames[1] as any).turnNumber).toBe(1);
  });

  it('rejects unsafe matchIds without touching disk', () => {
    const result = persistFrame('../escape-attempt', makeFrame('x', 0));
    expect(result).toBe(-1);
    expect(readFrames('../escape-attempt')).toEqual([]);
    expect(readFrameCount('../escape-attempt')).toBe(0);
    // Nothing should have been created outside the store directory.
    const parent = path.resolve(getStoreDir(), '..');
    expect(fs.existsSync(path.join(parent, 'escape-attempt.jsonl'))).toBe(false);
  });
});
