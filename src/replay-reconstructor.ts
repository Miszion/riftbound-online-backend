/**
 * Replay reconstructor for historical `selfplay-<gameIndex>-<seed>` matches.
 *
 * The live spectate + replay pipeline keeps frames in an ephemeral in-memory
 * store (see `./replay-frame-store`). Matches recorded by the self-play CLI
 * before the server process started, or evicted by LRU, have no frames
 * available. For those we reconstruct by re-running the deterministic
 * self-play harness for exactly one game and piping each emitted frame into
 * the store keyed by the original matchId.
 *
 * Why this works deterministically:
 *   - The self-play harness derives its per-game seed as
 *     `seed = (baseSeed + gameIndex * 2654435761) >>> 0`, which is a pure
 *     uint32 add. Given the per-game seed that ends up in the matchId, we
 *     invert it to the baseSeed expected by the CLI entry point.
 *   - All engine + bot RNGs are forked from that per-game seed, and the
 *     card catalog is loaded once and cached, so two runs with the same
 *     matchId produce the same action stream and the same serialized frames.
 *
 * This module is cheap: no disk I/O, no JSONL parsing required. The
 * matchId itself carries everything the harness needs to reproduce the run.
 * We keep the `findJsonlForMatch` helper only so operators can confirm a
 * matching JSONL file exists before triggering reconstruction.
 */
import fs from 'node:fs';
import path from 'node:path';
import logger from './logger';
import {
  HarnessConfig,
  pickBattlefieldRecords,
  pickPlayableCards,
  playOneGame
} from './self-play';
import { EnrichedCardRecord, getCardCatalog } from './card-catalog';
import { recordFrame } from './replay-frame-store';

const SELFPLAY_MATCH_ID = /^selfplay-(\d+)-(\d+)$/;

const DEFAULT_JSONL_DIR = '/Users/miszion/workplace/nexus-data/riftbound-games';

/**
 * Uint32 modular inversion of
 *   seed = (baseSeed + gameIndex * 2654435761) >>> 0
 * so we can pass the CLI-equivalent `baseSeed` into `playOneGame`.
 */
const deriveBaseSeed = (gameIndex: number, perGameSeed: number): number => {
  const offset = Math.imul(gameIndex, 2654435761) >>> 0;
  return (perGameSeed - offset) >>> 0;
};

interface CatalogCache {
  playable: EnrichedCardRecord[] | null;
  battlefieldRecords: EnrichedCardRecord[] | null;
  loaded: boolean;
}

const catalogCache: CatalogCache = {
  playable: null,
  battlefieldRecords: null,
  loaded: false
};

const ensureCatalog = (): void => {
  if (catalogCache.loaded) return;
  try {
    const catalog = getCardCatalog();
    catalogCache.playable = pickPlayableCards(catalog);
    catalogCache.battlefieldRecords = pickBattlefieldRecords(catalog);
    catalogCache.loaded = true;
  } catch (error) {
    // Fall through to synthetic deck fallback (playable=null triggers it
    // inside playOneGame -> buildDeckConfigForGame).
    logger.warn('[replay-reconstructor] catalog load failed, using synthetic fallback', {
      error: (error as Error).message
    });
    catalogCache.loaded = true;
  }
};

/** Return the absolute path of the first JSONL whose first line matches `matchId`, or null. */
export const findJsonlForMatch = (
  matchId: string,
  dir: string = DEFAULT_JSONL_DIR
): string | null => {
  if (!fs.existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return null;
  }
  const match = SELFPLAY_MATCH_ID.exec(matchId);
  if (match) {
    // Filename convention: `match-<tsTag>-<seed>.jsonl`. Try that first.
    const seedSuffix = `-${match[2]}.jsonl`;
    const fastHit = entries.find((f) => f.endsWith(seedSuffix));
    if (fastHit) return path.join(dir, fastHit);
  }
  for (const entry of entries) {
    try {
      const fd = fs.openSync(path.join(dir, entry), 'r');
      const buf = Buffer.alloc(2048);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const firstLine = buf.subarray(0, read).toString('utf8').split('\n')[0];
      if (!firstLine) continue;
      const parsed = JSON.parse(firstLine);
      if (parsed?.matchId === matchId) return path.join(dir, entry);
    } catch {
      // ignore malformed files
    }
  }
  return null;
};

export interface ReconstructOptions {
  /** Self-play strategies used to regenerate the run. Defaults mirror the CLI. */
  strategyA?: HarnessConfig['strategyA'];
  strategyB?: HarnessConfig['strategyB'];
  /** Directory scanned for existence-of-JSONL confirmation. */
  jsonlDir?: string;
  /**
   * If `false`, skip the filesystem check for a matching JSONL. Useful in
   * unit tests and for matchIds we know are self-play-shaped.
   */
  requireJsonl?: boolean;
}

export interface ReconstructResult {
  ok: boolean;
  framesRecorded: number;
  reason?: string;
}

/**
 * Re-run the deterministic self-play harness for the single game encoded in
 * `matchId` and append each emitted frame to the in-memory replay store.
 *
 * Returns immediately with `ok: false` if the matchId does not match the
 * self-play convention or the on-disk JSONL confirmation fails.
 */
export const reconstructFramesForMatch = (
  matchId: string,
  opts: ReconstructOptions = {}
): ReconstructResult => {
  const match = SELFPLAY_MATCH_ID.exec(matchId);
  if (!match) {
    return { ok: false, framesRecorded: 0, reason: 'non_selfplay_matchid' };
  }
  const gameIndex = Number(match[1]);
  const perGameSeed = Number(match[2]);
  if (!Number.isFinite(gameIndex) || !Number.isFinite(perGameSeed)) {
    return { ok: false, framesRecorded: 0, reason: 'unparseable_matchid' };
  }
  const requireJsonl = opts.requireJsonl ?? true;
  if (requireJsonl) {
    const jsonlPath = findJsonlForMatch(matchId, opts.jsonlDir);
    if (!jsonlPath) {
      return { ok: false, framesRecorded: 0, reason: 'jsonl_not_found' };
    }
  }

  ensureCatalog();

  const baseSeed = deriveBaseSeed(gameIndex, perGameSeed);
  const cfg: HarnessConfig = {
    games: 1,
    seed: baseSeed,
    seedProvided: true,
    turnLimit: 100,
    actionLimit: 2000,
    strategyA: opts.strategyA ?? 'baseline',
    strategyB: opts.strategyB ?? 'heuristic',
    quiet: true,
    quick: false,
    emitJsonl: false,
    jsonlDir: opts.jsonlDir ?? DEFAULT_JSONL_DIR,
    report: ''
  };

  let framesRecorded = 0;
  try {
    playOneGame(
      gameIndex,
      cfg,
      baseSeed,
      catalogCache.playable,
      catalogCache.battlefieldRecords,
      () => {
        // quiet — we own the logger
      },
      {
        onFrame: (frame) => {
          recordFrame(matchId, frame);
          framesRecorded++;
        }
      }
    );
  } catch (error) {
    logger.error('[replay-reconstructor] playOneGame threw during reconstruction', {
      matchId,
      error: (error as Error).message
    });
    return {
      ok: framesRecorded > 0,
      framesRecorded,
      reason: framesRecorded > 0 ? 'completed_with_error' : 'playOneGame_threw'
    };
  }

  if (framesRecorded === 0) {
    return { ok: false, framesRecorded, reason: 'no_frames_emitted' };
  }
  return { ok: true, framesRecorded };
};

/** Test-only reset of the cached catalog. */
export const __resetReplayReconstructorCatalog = (): void => {
  catalogCache.playable = null;
  catalogCache.battlefieldRecords = null;
  catalogCache.loaded = false;
};
