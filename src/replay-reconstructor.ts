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
import {
  CardAssetInfo,
  EnrichedCardRecord,
  getCardCatalog
} from './card-catalog';
import { recordFrame } from './replay-frame-store';

const SELFPLAY_MATCH_ID = /^selfplay-(\d+)-(\d+)$/;
// Bot-vs-bot matches started via the GraphQL `startBotMatch` mutation are
// persisted under their `bot-<uuid>` matchId — see src/bot-match.ts's JSONL
// fallback. They live in a dedicated directory so the self-play dir stays
// clean.
const BOT_MATCH_ID = /^bot-[0-9a-f-]{36}$/i;

const DEFAULT_JSONL_DIR = '/Users/miszion/workplace/nexus-data/riftbound-games';
const DEFAULT_BOT_MATCHES_DIR = path.resolve(
  __dirname,
  '..',
  'data',
  'bot-matches'
);

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

// ---------------------------------------------------------------------------
// Asset enrichment for replay frames.
//
// The self-play harness builds battlefield/synthetic Card objects without the
// `assets` field (see self-play.ts `assembleDeck` battlefields and
// `buildSyntheticBattlefield`/`buildRuneDeck`). Once those go through
// `serializeGameState`, the resulting snapshots have `assets: null`, so the
// replay UI can't render dotgg.gg card art.
//
// Rather than restructure the engine/harness, we take one enrich pass per
// frame here: for any Card-ish snapshot with a missing/empty `assets`, look it
// up in the catalog by cardId/slug/name and copy the catalog's assets onto
// the snapshot in-place. This keeps the fix surgical and referenced — we do
// not duplicate card data, we just point at it.
// ---------------------------------------------------------------------------

interface CatalogAssetIndex {
  byId: Map<string, CardAssetInfo>;
  bySlug: Map<string, CardAssetInfo>;
  byName: Map<string, CardAssetInfo>;
}

let catalogAssetIndex: CatalogAssetIndex | null = null;

const getCatalogAssetIndex = (): CatalogAssetIndex | null => {
  if (catalogAssetIndex) return catalogAssetIndex;
  let catalog: EnrichedCardRecord[];
  try {
    catalog = getCardCatalog();
  } catch {
    return null;
  }
  const byId = new Map<string, CardAssetInfo>();
  const bySlug = new Map<string, CardAssetInfo>();
  const byName = new Map<string, CardAssetInfo>();
  for (const record of catalog) {
    if (!record.assets) continue;
    if (record.id) byId.set(record.id.toLowerCase(), record.assets);
    if (record.slug) bySlug.set(record.slug.toLowerCase(), record.assets);
    if (record.name) byName.set(record.name.trim().toLowerCase(), record.assets);
  }
  catalogAssetIndex = { byId, bySlug, byName };
  return catalogAssetIndex;
};

const hasAssets = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const remote = (value as { remote?: unknown }).remote;
  return typeof remote === 'string' && remote.length > 0;
};

const lookupAssets = (
  index: CatalogAssetIndex,
  cardId?: string | null,
  slug?: string | null,
  name?: string | null
): CardAssetInfo | null => {
  if (cardId) {
    const hit = index.byId.get(cardId.toLowerCase());
    if (hit) return hit;
  }
  if (slug) {
    const hit = index.bySlug.get(slug.toLowerCase());
    if (hit) return hit;
  }
  if (name) {
    const hit = index.byName.get(name.trim().toLowerCase());
    if (hit) return hit;
  }
  return null;
};

/**
 * Populate `card.assets` from the catalog when the snapshot lacks a usable
 * remote URL. Mutates in place and returns the same reference for chaining.
 */
const enrichCardWithCatalog = (
  card: Record<string, any> | null | undefined,
  index: CatalogAssetIndex
): void => {
  if (!card || typeof card !== 'object') return;
  if (hasAssets(card.assets)) return;
  const cardId = (card.cardId ?? card.id) as string | undefined;
  const assets = lookupAssets(index, cardId, card.slug, card.name);
  if (assets) {
    card.assets = assets;
  }
};

const enrichCardList = (
  cards: unknown,
  index: CatalogAssetIndex
): void => {
  if (!Array.isArray(cards)) return;
  for (const card of cards) {
    enrichCardWithCatalog(card as Record<string, any>, index);
  }
};

const enrichRuneList = (
  runes: unknown,
  index: CatalogAssetIndex
): void => {
  if (!Array.isArray(runes)) return;
  for (const rune of runes) {
    if (!rune || typeof rune !== 'object') continue;
    const r = rune as Record<string, any>;
    if (!hasAssets(r.assets)) {
      const assets = lookupAssets(
        index,
        r.runeId ?? r.id,
        r.slug,
        r.name
      );
      if (assets) r.assets = assets;
    }
    if (r.cardSnapshot) enrichCardWithCatalog(r.cardSnapshot, index);
  }
};

/**
 * Walk every card-bearing zone in a serialized frame and fill in `assets`
 * from the catalog when missing. Mutates the frame in place; callers pass
 * the reference they already hold.
 */
const enrichFrameWithCatalog = (frame: unknown): void => {
  if (!frame || typeof frame !== 'object') return;
  const index = getCatalogAssetIndex();
  if (!index) return;
  const f = frame as Record<string, any>;

  if (Array.isArray(f.players)) {
    for (const player of f.players) {
      if (!player || typeof player !== 'object') continue;
      const p = player as Record<string, any>;
      enrichCardList(p.hand, index);
      enrichCardList(p.graveyard, index);
      enrichCardList(p.exile, index);
      if (p.board && typeof p.board === 'object') {
        enrichCardList(p.board.creatures, index);
        enrichCardList(p.board.artifacts, index);
        enrichCardList(p.board.enchantments, index);
      }
      enrichRuneList(p.channeledRunes, index);
      enrichRuneList(p.runeDeck, index);
      enrichCardWithCatalog(p.championLegend, index);
      enrichCardWithCatalog(p.championLeader, index);
    }
  }

  if (Array.isArray(f.battlefields)) {
    for (const battlefield of f.battlefields) {
      if (!battlefield || typeof battlefield !== 'object') continue;
      const bf = battlefield as Record<string, any>;
      enrichCardWithCatalog(bf.card, index);
      if (Array.isArray(bf.hiddenCards)) {
        for (const hc of bf.hiddenCards) {
          if (hc && typeof hc === 'object') {
            enrichCardWithCatalog((hc as Record<string, any>).card, index);
          }
        }
      }
    }
  }

  if (f.pendingSpellResolution && typeof f.pendingSpellResolution === 'object') {
    enrichCardWithCatalog(
      (f.pendingSpellResolution as Record<string, any>).spell,
      index
    );
  }

  if (f.reactionChain && typeof f.reactionChain === 'object') {
    const items = (f.reactionChain as Record<string, any>).items;
    if (Array.isArray(items)) {
      for (const item of items) {
        if (item && typeof item === 'object') {
          enrichCardWithCatalog((item as Record<string, any>).card, index);
        }
      }
    }
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
    // Sort by mtime descending so re-runs of the same matchId pick the most
    // recent JSONL. This keeps `matchReplay` aligned with `recentMatches`
    // (which also sorts by mtime) when multiple files share a seed.
    entries = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .map((e) => e.f);
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
          enrichFrameWithCatalog(frame);
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
  catalogAssetIndex = null;
};

// ---------------------------------------------------------------------------
// JSONL -> MatchReplay adapter
//
// `matchReplay` GraphQL resolver reads DynamoDB; bot self-play matches only
// exist as JSONL on disk. This adapter rebuilds the same PascalCase shape the
// resolver's mapper expects so `mapMatchReplayItem` can consume it unchanged.
// ---------------------------------------------------------------------------

type EventLine = {
  matchId?: string;
  eventIndex?: number;
  timestamp?: string;
  turn?: number;
  phase?: string;
  activePlayer?: 'P1' | 'P2';
  actor?: 'P1' | 'P2' | 'system';
  action?: { kind?: string; [k: string]: any } | null;
  cardPlayed?: { id?: string; name?: string; [k: string]: any } | null;
  target?: string | null;
  vp?: { P1?: number; P2?: number };
  result?: string;
  [k: string]: any;
};

const readJsonlLines = (filePath: string): EventLine[] => {
  const text = fs.readFileSync(filePath, 'utf8');
  const events: EventLine[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // ignore malformed line, keep going
    }
  }
  return events;
};

const deriveWinner = (events: EventLine[]): { winner: string | null; loser: string | null } => {
  const last = events[events.length - 1];
  const resultField = typeof last?.result === 'string' ? last.result : '';
  const p1Wins = /P1[_ -]?win/i.test(resultField);
  const p2Wins = /P2[_ -]?win/i.test(resultField);
  if (p1Wins) return { winner: 'playerA', loser: 'playerB' };
  if (p2Wins) return { winner: 'playerB', loser: 'playerA' };
  const vpA = last?.vp?.P1 ?? 0;
  const vpB = last?.vp?.P2 ?? 0;
  if (vpA > vpB) return { winner: 'playerA', loser: 'playerB' };
  if (vpB > vpA) return { winner: 'playerB', loser: 'playerA' };
  return { winner: null, loser: null };
};

const eventToMove = (event: EventLine) => {
  const activeIdx = event.activePlayer === 'P2' ? 1 : 0;
  return {
    playerIndex: activeIdx,
    turn: event.turn ?? 0,
    phase: event.phase ?? '',
    action: event.action?.kind ?? 'unknown',
    cardId: event.cardPlayed?.id ?? null,
    targetId: event.target ?? null,
    timestamp: event.timestamp ? Date.parse(event.timestamp) : null
  };
};

/**
 * Build a DynamoDB-shaped MatchReplay AttributeMap from an on-disk JSONL file
 * so `mapMatchReplayItem` can return bot self-play matches through the same
 * `matchReplay(matchId)` resolver the UI already consumes.
 *
 * Returns null if the matchId is not self-play-shaped, the JSONL file is
 * missing, or the deterministic re-run fails to emit frames. The final
 * serialized game state is captured as `FinalState` so the spectator UI has a
 * complete board to render; moves[] comes straight from the JSONL event log.
 */
export const buildMatchReplayFromJsonl = (
  matchId: string,
  opts: { jsonlDir?: string; botMatchesDir?: string } = {}
): Record<string, any> | null => {
  // Bot-vs-bot UI matches (`bot-<uuid>`) are written by bot-match.ts's
  // finalize path as a two-line JSONL with the full final state + move
  // history baked in. No engine re-run needed — just read and map.
  if (BOT_MATCH_ID.test(matchId)) {
    return buildBotMatchReplayFromJsonl(matchId, opts.botMatchesDir);
  }
  const selfplay = SELFPLAY_MATCH_ID.exec(matchId);
  if (!selfplay) return null;

  const gameIndex = Number(selfplay[1]);
  const perGameSeed = Number(selfplay[2]);
  if (!Number.isFinite(gameIndex) || !Number.isFinite(perGameSeed)) return null;

  const jsonlPath = findJsonlForMatch(matchId, opts.jsonlDir);
  if (!jsonlPath) return null;

  let events: EventLine[];
  try {
    events = readJsonlLines(jsonlPath);
  } catch (error) {
    logger.warn('[replay-reconstructor] failed to read jsonl for match', {
      matchId,
      jsonlPath,
      error: (error as Error).message
    });
    return null;
  }
  if (events.length === 0) return null;

  const moves = events.map(eventToMove);
  const { winner, loser } = deriveWinner(events);
  const firstTs = events[0]?.timestamp ? Date.parse(events[0].timestamp) : Date.now();
  const lastTs = events[events.length - 1]?.timestamp
    ? Date.parse(events[events.length - 1].timestamp as string)
    : firstTs;
  const turns = events[events.length - 1]?.turn ?? 0;

  ensureCatalog();
  const baseSeed = deriveBaseSeed(gameIndex, perGameSeed);
  const cfg: HarnessConfig = {
    games: 1,
    seed: baseSeed,
    seedProvided: true,
    turnLimit: 100,
    actionLimit: 2000,
    strategyA: 'baseline',
    strategyB: 'heuristic',
    quiet: true,
    quick: false,
    emitJsonl: false,
    jsonlDir: opts.jsonlDir ?? DEFAULT_JSONL_DIR,
    report: ''
  };

  let lastFrame: unknown = null;
  try {
    playOneGame(
      gameIndex,
      cfg,
      baseSeed,
      catalogCache.playable,
      catalogCache.battlefieldRecords,
      () => {},
      {
        onFrame: (frame) => {
          enrichFrameWithCatalog(frame);
          lastFrame = frame;
          recordFrame(matchId, frame);
        }
      }
    );
  } catch (error) {
    logger.warn('[replay-reconstructor] playOneGame threw while building replay', {
      matchId,
      error: (error as Error).message
    });
  }

  return {
    MatchId: matchId,
    Players: ['playerA', 'playerB'],
    Winner: winner,
    Loser: loser,
    Duration: Math.max(0, Math.round((lastTs - firstTs) / 1000)),
    Turns: turns,
    Moves: moves,
    FinalState: lastFrame,
    CreatedAt: firstTs
  };
};

/**
 * Bot-UI match JSONL reader. Shape is written by bot-match.ts as exactly two
 * lines per file: a header row keyed by `matchId` and a terminal row carrying
 * `persisted` with the full moves[] + finalState.
 *
 * Returns the same PascalCase record the DynamoDB mapper consumes so
 * `mapMatchReplayItem` can pass it through unchanged.
 */
const buildBotMatchReplayFromJsonl = (
  matchId: string,
  dir: string = DEFAULT_BOT_MATCHES_DIR
): Record<string, any> | null => {
  const filePath = path.join(dir, `${matchId}.jsonl`);
  if (!fs.existsSync(filePath)) return null;
  let events: EventLine[];
  try {
    events = readJsonlLines(filePath);
  } catch (error) {
    logger.warn('[replay-reconstructor] failed to read bot-match jsonl', {
      matchId,
      filePath,
      error: (error as Error).message
    });
    return null;
  }
  if (events.length === 0) return null;

  const terminal = events[events.length - 1] as any;
  const persisted = terminal?.persisted;
  if (!persisted || typeof persisted !== 'object') return null;

  // Enrich the baked-in final state with catalog assets so the replay UI has
  // dotgg.gg art when rendering the end-of-match snapshot.
  if (persisted.finalState) {
    enrichFrameWithCatalog(persisted.finalState);
  }

  return {
    MatchId: persisted.matchId ?? matchId,
    Players: Array.isArray(persisted.players) ? persisted.players : [],
    Winner: persisted.winner ?? null,
    Loser: persisted.loser ?? null,
    Duration: persisted.duration ?? null,
    Turns: persisted.turns ?? 0,
    Moves: Array.isArray(persisted.moves) ? persisted.moves : [],
    FinalState: persisted.finalState ?? null,
    CreatedAt: persisted.createdAt ?? null
  };
};

/**
 * Internal helper: enumerate bot-UI matches (`data/bot-matches/*.jsonl`) and
 * surface the same RecentMatchSummary shape that listBotMatchesFromJsonl
 * returns for self-play JSONL files.
 */
const listBotUiMatchesFromJsonl = (
  limit: number,
  dir: string = DEFAULT_BOT_MATCHES_DIR
): ReturnType<typeof listBotMatchesFromJsonl> => {
  if (!fs.existsSync(dir)) return [];
  let entries: Array<{ file: string; mtime: number }>;
  try {
    entries = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ file: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, Math.max(limit * 2, limit));
  } catch {
    return [];
  }

  const out: ReturnType<typeof listBotMatchesFromJsonl> = [];
  for (const { file } of entries) {
    try {
      const filePath = path.join(dir, file);
      const events = readJsonlLines(filePath);
      if (events.length === 0) continue;
      const first = events[0] as any;
      const last = events[events.length - 1] as any;
      const matchId = first?.matchId;
      if (!matchId || !BOT_MATCH_ID.test(matchId)) continue;
      const persisted = last?.persisted ?? {};
      const createdAt =
        typeof persisted.createdAt === 'number'
          ? new Date(persisted.createdAt)
          : first?.timestamp
          ? new Date(first.timestamp)
          : null;
      const endReason: string | null =
        (typeof persisted.endReason === 'string' && persisted.endReason) ||
        (typeof last?.terminal?.reason === 'string' && last.terminal.reason) ||
        null;
      const status: string | null =
        (typeof persisted.status === 'string' && persisted.status) ||
        (last ? 'completed' : null);
      out.push({
        matchId,
        players: Array.isArray(persisted.players) ? persisted.players : [],
        winner: persisted.winner ?? null,
        loser: persisted.loser ?? null,
        duration:
          typeof persisted.duration === 'number' ? persisted.duration : null,
        turns: typeof persisted.turns === 'number' ? persisted.turns : null,
        createdAt,
        endReason,
        status
      });
      if (out.length >= limit) break;
    } catch {
      // skip unreadable file
    }
  }
  return out;
};

/**
 * List bot self-play matches that exist as JSONL on disk. Used by
 * `recentMatches` so the spectate UI can surface bot matches even when
 * DynamoDB has no record of them. Merges self-play JSONL (baked harness
 * runs) with bot-UI JSONL (matches launched via startBotMatch), sorted by
 * createdAt desc.
 */
export const listBotMatchesFromJsonl = (
  limit = 10,
  dir: string = DEFAULT_JSONL_DIR,
  botUiDir: string = DEFAULT_BOT_MATCHES_DIR
): Array<{
  matchId: string;
  players: string[];
  winner: string | null;
  loser: string | null;
  duration: number | null;
  turns: number | null;
  createdAt: Date | null;
  // End-reason + lifecycle surfaced onto RecentMatchSummary for /spectate
  // rows. Mirrors self-play.ts: `terminal.reason` is the terminator
  // (victory_points/burn_out/turn_cap/…), and `result` flips to 'draw' on
  // crashes/invariants. Null when the tail event is unreadable.
  endReason: string | null;
  status: string | null;
}> => {
  const botUiRows = listBotUiMatchesFromJsonl(limit, botUiDir);
  if (!fs.existsSync(dir)) {
    return botUiRows
      .sort(
        (a, b) =>
          (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)
      )
      .slice(0, limit);
  }
  let entries: Array<{ file: string; mtime: number }>;
  try {
    entries = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const stat = fs.statSync(path.join(dir, f));
        return { file: f, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, Math.max(limit * 2, limit));
  } catch {
    return [];
  }

  const out: ReturnType<typeof listBotMatchesFromJsonl> = [];
  for (const { file } of entries) {
    try {
      const filePath = path.join(dir, file);
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(2048);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const firstLine = buf.subarray(0, read).toString('utf8').split('\n')[0];
      if (!firstLine) continue;
      const first = JSON.parse(firstLine) as EventLine;
      const matchId = first?.matchId;
      if (!matchId || !SELFPLAY_MATCH_ID.test(matchId)) continue;

      // Read tail for result + turns without loading the entire file twice.
      const tailSize = 4096;
      const stat = fs.statSync(filePath);
      const start = Math.max(0, stat.size - tailSize);
      const tailFd = fs.openSync(filePath, 'r');
      const tailBuf = Buffer.alloc(Math.min(tailSize, stat.size));
      fs.readSync(tailFd, tailBuf, 0, tailBuf.length, start);
      fs.closeSync(tailFd);
      const tailLines = tailBuf.toString('utf8').split('\n').filter(Boolean);
      let last: EventLine | null = null;
      for (let i = tailLines.length - 1; i >= 0; i--) {
        try {
          last = JSON.parse(tailLines[i]);
          break;
        } catch {
          // keep searching earlier lines for valid JSON
        }
      }

      const { winner, loser } = deriveWinner(last ? [last] : []);
      const firstTs = first.timestamp ? Date.parse(first.timestamp) : null;
      const lastTs = last?.timestamp ? Date.parse(last.timestamp) : firstTs;
      // Self-play terminal event shape (see src/self-play.ts emit(...) at the
      // bottom of `playOneGame`): the final line carries `terminal.reason`
      // (the self-play terminator: victory_points / burn_out / turn_cap /
      // action_cap / infinite_loop / crashed / invariant) and a top-level
      // `result` of P1_wins / P2_wins / 'draw'. Map draw/crash → 'abandoned',
      // everything else → 'completed' so the listing row can show lifecycle.
      const terminal = (last as any)?.terminal;
      const endReason: string | null =
        (typeof terminal?.reason === 'string' && terminal.reason) || null;
      const resultField = typeof (last as any)?.result === 'string' ? (last as any).result : '';
      const status: string | null = last
        ? resultField === 'draw' ||
          endReason === 'crashed' ||
          endReason === 'invariant' ||
          endReason === 'infinite_loop'
          ? 'abandoned'
          : 'completed'
        : null;
      out.push({
        matchId,
        players: ['playerA', 'playerB'],
        winner,
        loser,
        duration:
          firstTs !== null && lastTs !== null
            ? Math.max(0, Math.round((lastTs - firstTs) / 1000))
            : null,
        turns: last?.turn ?? null,
        createdAt: firstTs !== null ? new Date(firstTs) : null,
        endReason,
        status
      });
      if (out.length >= limit) break;
    } catch {
      // skip unreadable/malformed file
    }
  }
  // Merge self-play rows + bot-UI rows, sorted by createdAt desc, capped.
  const combined = [...out, ...botUiRows].sort(
    (a, b) =>
      (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)
  );
  return combined.slice(0, limit);
};
