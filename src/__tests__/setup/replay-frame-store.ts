/**
 * Jest setupFile: redirect the persistent replay-frame store to a
 * per-process tmp directory so tests that spin up bot-match flows (which
 * write a frame file per match) do not litter the repo's data/replay-frames
 * directory.
 *
 * Runs before every test file's top-level imports. The override is picked up
 * by src/replay/replay-frame-store.ts via the REPLAY_FRAME_STORE_DIR env var.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-frames-test-'));
process.env.REPLAY_FRAME_STORE_DIR = TEST_DIR;
