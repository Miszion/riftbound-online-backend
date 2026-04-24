import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import logger from './logger';
import {
  CardType,
  Domain,
  GameStatus,
  MatchResult,
  PlayerDeckConfig,
  RiftboundGameEngine,
  RuneCard
} from './game-engine';
import { serializeGameState } from './game-state-serializer';
import {
  persistEngineSnapshot,
  matchSnapshotExists,
  persistMatchFinalState
} from './match-routes';
import {
  publishGameStateChange,
  publishMatchCompletion
} from './graphql/pubsub';
import { recordFrame } from './replay-frame-store';
import {
  dispatchAction,
  enumerateLegalActions,
  getBot,
  makeRng,
  pickBattlefieldRecords,
  pickPlayableCards,
  Rng,
  StrategyName
} from './self-play';
import { EnrichedCardRecord, getCardCatalog } from './card-catalog';

// ---------------------------------------------------------------------------
// Bot deck construction — draws from the full 723-card catalog.
// ---------------------------------------------------------------------------

const BOT_MAIN_DECK_SIZE = 40;
const BOT_MAX_COPIES_NON_LEGEND = 3;
const BOT_MAX_COPIES_LEGEND = 1;
const BOT_RUNE_DECK_SIZE = 12;

const DOMAIN_ENUM_LIST: Domain[] = Object.values(Domain) as Domain[];
const TITLECASE_TO_DOMAIN: Record<string, Domain> = {
  fury: Domain.FURY,
  calm: Domain.CALM,
  mind: Domain.MIND,
  body: Domain.BODY,
  chaos: Domain.CHAOS,
  order: Domain.ORDER
};

const isColorlessRecord = (card: EnrichedCardRecord): boolean => {
  const colors = card.colors ?? [];
  if (colors.length === 0) return true;
  return colors.every((c) => c.toLowerCase() === 'colorless');
};

const recordMatchesDomains = (
  card: EnrichedCardRecord,
  chosen: Set<Domain>
): boolean => {
  const colors = card.colors ?? [];
  if (colors.length === 0) return true; // truly colorless -> universal
  for (const raw of colors) {
    const key = raw.toLowerCase();
    if (key === 'colorless') return true;
    const domain = TITLECASE_TO_DOMAIN[key];
    if (domain && chosen.has(domain)) return true;
  }
  return false;
};

const shuffleRng = <T>(arr: T[], rng: Rng): T[] => {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

const pickCatalogRuneRecords = (
  catalog: EnrichedCardRecord[]
): EnrichedCardRecord[] => {
  return catalog.filter((c) => {
    const type = (c.type ?? '').toLowerCase();
    const tags = (c.tags ?? []).map((t) => t.toLowerCase());
    return type === 'rune' || tags.includes('rune');
  });
};

const catalogRuneToRuneCard = (record: EnrichedCardRecord): RuneCard => {
  const firstColor = (record.colors ?? [])[0]?.toLowerCase();
  const domain = firstColor ? TITLECASE_TO_DOMAIN[firstColor] : undefined;
  return {
    id: record.id,
    name: record.name,
    domain,
    energyValue: 1,
    powerValue: 1,
    slug: record.slug,
    assets: record.assets,
    isTapped: false,
    cardSnapshot: null
  };
};

const buildSyntheticBotRuneDeck = (rng: Rng): RuneCard[] => {
  const runes: RuneCard[] = [];
  for (let i = 0; i < BOT_RUNE_DECK_SIZE; i++) {
    const domain = DOMAIN_ENUM_LIST[i % DOMAIN_ENUM_LIST.length];
    runes.push({
      id: `bot-rune-${i}`,
      name: `Bot Rune ${i}`,
      domain,
      energyValue: 1,
      powerValue: 1,
      slug: `bot-rune-${i}`,
      assets: null,
      isTapped: false,
      cardSnapshot: null
    });
  }
  return shuffleRng(runes, rng);
};

/**
 * Build a rune deck from the real catalog so live match runes carry
 * the dotgg.gg `assets` the frontend spectate view renders. Picks 12
 * runes biased toward the chosen deck domains, padding with any runes
 * so we always hit BOT_RUNE_DECK_SIZE. Falls back to synthetic if the
 * catalog has zero runes (never in practice; the 723-card dump has 18).
 */
const buildBotRuneDeck = (
  rng: Rng,
  catalog: EnrichedCardRecord[] | null,
  chosenDomains: Set<Domain>
): RuneCard[] => {
  if (!catalog) return buildSyntheticBotRuneDeck(rng);
  const runeRecords = pickCatalogRuneRecords(catalog);
  if (runeRecords.length === 0) return buildSyntheticBotRuneDeck(rng);

  const inDomain = runeRecords.filter((r) =>
    recordMatchesDomains(r, chosenDomains)
  );
  const shuffledInDomain = shuffleRng(inDomain, rng);
  const shuffledAll = shuffleRng(runeRecords, rng);

  const runes: RuneCard[] = [];
  // Pass 1: fill from on-domain pool, allowing repeats (cycling the pool).
  let cursor = 0;
  while (runes.length < BOT_RUNE_DECK_SIZE && shuffledInDomain.length > 0) {
    const pick = shuffledInDomain[cursor % shuffledInDomain.length];
    runes.push(catalogRuneToRuneCard(pick));
    cursor += 1;
    // Stop cycling if we've gone around several times already — let
    // off-domain runes fill the rest so the deck isn't monotone.
    if (cursor >= shuffledInDomain.length * 2) break;
  }
  // Pass 2: any-rune fallback to guarantee BOT_RUNE_DECK_SIZE.
  let allCursor = 0;
  while (runes.length < BOT_RUNE_DECK_SIZE && shuffledAll.length > 0) {
    runes.push(catalogRuneToRuneCard(shuffledAll[allCursor % shuffledAll.length]));
    allCursor += 1;
  }
  if (runes.length === 0) return buildSyntheticBotRuneDeck(rng);
  return shuffleRng(runes, rng);
};

const buildSyntheticBotBattlefield = (seed: string) => ({
  id: `bot-battlefield-${seed}`,
  slug: `bot-battlefield-${seed}`,
  name: `Bot Battlefield ${seed}`,
  type: CardType.ENCHANTMENT,
  tags: ['Battlefield'],
  colors: [],
  keywords: [],
  text: 'A synthetic battlefield used when catalog load fails.',
  metadata: {}
});

/**
 * Build a legal-ish 40-card bot deck drawing from the full catalog.
 *
 * - Picks 1-2 random domains per bot; admits colorless cards universally.
 * - Enforces max 3 copies per non-legend card, max 1 copy per legend.
 * - Deck entries are card-id strings; the engine's DeckCardEntry union
 *   accepts raw ids and will hydrate them against the catalog at init.
 * - Battlefield is drawn from the catalog's battlefield records when
 *   available; falls back to a synthetic enchantment otherwise.
 * - Runes are drawn from the catalog's 18 rune records (6 domains x 3
 *   variants) so live match runes carry dotgg.gg `assets` for the
 *   frontend spectate view. Biased toward the chosen deck domains.
 *
 * On catalog load failure the whole thing falls back to a synthetic deck
 * so bot matches still start, same behavior as the previous --quick path.
 */
const buildBotDeck = (
  rng: Rng,
  seedLabel: string
): PlayerDeckConfig => {
  let catalog: EnrichedCardRecord[];
  try {
    catalog = getCardCatalog();
  } catch (error) {
    logger.warn('[BOT-MATCH] catalog load failed, using synthetic fallback deck', {
      seedLabel,
      error: (error as Error).message
    });
    const synthetic: string[] = [];
    for (let i = 0; i < BOT_MAIN_DECK_SIZE; i++) {
      synthetic.push(`synthetic-bot-card-${seedLabel}-${i}`);
    }
    return {
      mainDeck: synthetic,
      runeDeck: buildBotRuneDeck(rng, null, new Set()),
      battlefields: [buildSyntheticBotBattlefield(seedLabel)] as any,
      championLegend: null,
      championLeader: null
    };
  }

  const playable = pickPlayableCards(catalog);
  const battlefieldRecords = pickBattlefieldRecords(catalog);

  // Pick 1-2 random domains. Weighted toward two-domain (60/40) to match
  // typical riftbound constructed decks.
  const shuffledDomains = shuffleRng(DOMAIN_ENUM_LIST, rng);
  const domainCount = rng.next() < 0.6 ? 2 : 1;
  const chosen = new Set<Domain>(shuffledDomains.slice(0, domainCount));

  // Split playable pool into on-domain + colorless vs. off-domain.
  const onDomain = playable.filter(
    (c) => recordMatchesDomains(c, chosen) && !isColorlessRecord(c)
  );
  const colorless = playable.filter((c) => isColorlessRecord(c));

  // Shuffle both sub-pools and splice colorless in so ordering is randomized.
  const shuffledOnDomain = shuffleRng(onDomain, rng);
  const shuffledColorless = shuffleRng(colorless, rng);

  // Build main deck respecting copy limits.
  const copies = new Map<string, number>();
  const mainDeck: string[] = [];

  const tryAdd = (card: EnrichedCardRecord): boolean => {
    const limit =
      (card.type ?? '').toLowerCase() === 'legend'
        ? BOT_MAX_COPIES_LEGEND
        : BOT_MAX_COPIES_NON_LEGEND;
    const current = copies.get(card.id) ?? 0;
    if (current >= limit) return false;
    copies.set(card.id, current + 1);
    mainDeck.push(card.id);
    return true;
  };

  // Pass 1: seed some copies from on-domain pool (multiple passes so we
  // can stack up to the copy limit).
  for (let pass = 0; pass < BOT_MAX_COPIES_NON_LEGEND && mainDeck.length < BOT_MAIN_DECK_SIZE; pass++) {
    for (const card of shuffledOnDomain) {
      if (mainDeck.length >= BOT_MAIN_DECK_SIZE) break;
      tryAdd(card);
    }
  }

  // Pass 2: top up with colorless staples if we still haven't hit 40.
  for (let pass = 0; pass < BOT_MAX_COPIES_NON_LEGEND && mainDeck.length < BOT_MAIN_DECK_SIZE; pass++) {
    for (const card of shuffledColorless) {
      if (mainDeck.length >= BOT_MAIN_DECK_SIZE) break;
      tryAdd(card);
    }
  }

  // Pass 3: last-resort widen to any playable if the chosen domains were
  // too narrow (shouldn't happen with 723 cards and 100+ per domain, but
  // guard against data drift).
  if (mainDeck.length < BOT_MAIN_DECK_SIZE) {
    const anyCards = shuffleRng(playable, rng);
    for (let pass = 0; pass < BOT_MAX_COPIES_NON_LEGEND && mainDeck.length < BOT_MAIN_DECK_SIZE; pass++) {
      for (const card of anyCards) {
        if (mainDeck.length >= BOT_MAIN_DECK_SIZE) break;
        tryAdd(card);
      }
    }
  }

  // Battlefield: draw one from catalog, else synthetic.
  let battlefields: any[];
  if (battlefieldRecords.length > 0) {
    const shuffledBf = shuffleRng(battlefieldRecords, rng);
    const bf = shuffledBf[0];
    battlefields = [
      {
        id: bf.id,
        slug: bf.slug,
        name: bf.name,
        type: CardType.ENCHANTMENT,
        tags: bf.tags && bf.tags.length > 0 ? bf.tags : ['Battlefield'],
        colors: bf.colors ?? [],
        keywords: bf.keywords ?? [],
        text: bf.effect ?? '',
        metadata: {}
      }
    ];
  } else {
    battlefields = [buildSyntheticBotBattlefield(seedLabel)];
  }

  logger.info('[BOT-MATCH] built bot deck from full catalog', {
    seedLabel,
    catalogSize: catalog.length,
    playablePool: playable.length,
    domains: Array.from(chosen),
    mainDeckSize: mainDeck.length,
    uniqueCards: copies.size
  });

  return {
    mainDeck,
    runeDeck: buildBotRuneDeck(rng, catalog, chosen),
    battlefields,
    championLegend: null,
    championLeader: null
  };
};

const hashSeed = (s: string): number => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
};

const VALID_STRATEGIES: StrategyName[] = ['baseline', 'heuristic', 'random', 'aggro', 'control'];
const DEFAULT_STRATEGY_A: StrategyName = 'heuristic';
const DEFAULT_STRATEGY_B: StrategyName = 'baseline';
const DEFAULT_INTERVAL_MS = 800;
const MIN_INTERVAL_MS = 50;
const MAX_INTERVAL_MS = 5_000;
const MAX_TURNS = 80;
const MAX_TOTAL_ACTIONS = 4_000;
const MAX_NO_PROGRESS_ROUNDS = 12;

export interface BotMatchSummary {
  matchId: string;
  status: 'initializing' | 'running' | 'completed' | 'crashed';
  turn: number;
  players: string[];
  strategies: [StrategyName, StrategyName];
  startedAt: string;
  endedAt: string | null;
  winner: string | null;
  reason: string | null;
}

interface InternalRecord extends BotMatchSummary {
  cancelled: boolean;
}

const REGISTRY = new Map<string, InternalRecord>();
const MAX_REGISTRY_SIZE = 50;
const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const FINISHED_TTL_MS = parsePositiveInt(
  process.env.BOT_MATCH_FINISHED_TTL_MS,
  10 * 60 * 1000
);
const PRUNE_INTERVAL_MS = parsePositiveInt(
  process.env.BOT_MATCH_PRUNE_INTERVAL_MS,
  60 * 1000
);

const pruneFinished = (now: number = Date.now()): number => {
  let removed = 0;
  for (const [matchId, record] of REGISTRY) {
    if (record.status !== 'completed' && record.status !== 'crashed') continue;
    if (!record.endedAt) continue;
    const endedAt = Date.parse(record.endedAt);
    if (Number.isNaN(endedAt)) continue;
    if (now - endedAt >= FINISHED_TTL_MS) {
      REGISTRY.delete(matchId);
      removed += 1;
    }
  }
  return removed;
};

const pruneTimer = setInterval(() => {
  const removed = pruneFinished();
  if (removed > 0) {
    logger.info('[BOT-MATCH] pruned finished matches', { removed, remaining: REGISTRY.size });
  }
}, PRUNE_INTERVAL_MS);
pruneTimer.unref?.();

const normaliseStrategy = (
  raw: string | null | undefined,
  fallback: StrategyName
): StrategyName => {
  if (!raw) return fallback;
  const lowered = raw.toLowerCase() as StrategyName;
  return VALID_STRATEGIES.includes(lowered) ? lowered : fallback;
};

const trimRegistry = () => {
  if (REGISTRY.size <= MAX_REGISTRY_SIZE) return;
  const entries = Array.from(REGISTRY.values()).sort(
    (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)
  );
  const removable = entries.filter((entry) => entry.status !== 'running');
  for (const entry of removable) {
    if (REGISTRY.size <= MAX_REGISTRY_SIZE) break;
    REGISTRY.delete(entry.matchId);
  }
};

const publishSpectatorState = (matchId: string, engine: RiftboundGameEngine) => {
  const snapshot = engine.getGameState();
  const serialized = serializeGameState(snapshot);
  publishGameStateChange(matchId, serialized);
  // Also persist the exact same frame into the in-process replay store so a
  // later startReplaySession() can re-drive the live spectate pipeline with
  // the same snapshots. See src/replay-frame-store.ts for limits.
  try {
    recordFrame(matchId, serialized);
  } catch (error) {
    logger.warn('[BOT-MATCH] replay frame record failed', { matchId, error });
  }
};

// Dedicated directory for bot-UI match JSONL fallbacks. We intentionally keep
// these separate from the self-play harness JSONL dir so the two consumers
// (self-play fleet reports vs. live bot-vs-bot UI matches) stay isolated.
const BOT_MATCHES_JSONL_DIR = path.resolve(
  __dirname,
  '..',
  'data',
  'bot-matches'
);

const buildBotMatchJsonlRecords = (
  matchId: string,
  record: InternalRecord,
  engine: RiftboundGameEngine,
  matchResult: MatchResult | null,
  endReason: string,
  status: 'completed' | 'crashed'
): unknown[] => {
  const rawState = engine.getGameState();
  const finalState = serializeGameState(rawState);
  const moveHistory = matchResult?.moves ?? rawState.moveHistory ?? [];
  const startedAtMs = Date.parse(record.startedAt);
  const endedAtMs = record.endedAt ? Date.parse(record.endedAt) : Date.now();
  const durationSec =
    Number.isFinite(startedAtMs) && Number.isFinite(endedAtMs)
      ? Math.max(0, Math.round((endedAtMs - startedAtMs) / 1000))
      : null;

  // Map engine-winner playerId to P1/P2 labels (same convention as self-play
  // JSONL) so the existing `deriveWinner` helper in replay-reconstructor
  // returns playerA/playerB correctly without a second code path.
  const [p1, p2] = record.players;
  const winnerLabel: 'P1' | 'P2' | null =
    matchResult?.winner === p1 ? 'P1' : matchResult?.winner === p2 ? 'P2' : null;
  const loserLabel: 'P1' | 'P2' | null =
    winnerLabel === 'P1' ? 'P2' : winnerLabel === 'P2' ? 'P1' : null;
  const resultField: 'P1_wins' | 'P2_wins' | 'draw' =
    winnerLabel === 'P1' ? 'P1_wins' : winnerLabel === 'P2' ? 'P2_wins' : 'draw';

  // Header line carries the match identity, player identities, strategies,
  // and createdAt. `listBotMatchesFromJsonl` reads the first line for
  // matchId + createdAt, so this placement matters.
  const header = {
    matchId,
    timestamp: record.startedAt,
    kind: 'bot-match-header',
    players: record.players,
    strategies: record.strategies
  };

  // Terminal line carries the full payload needed by `buildMatchReplayFromJsonl`
  // to return populated `finalState` + `moves` without re-running the engine,
  // and by `listBotMatchesFromJsonl` to surface winner/turns/duration/endReason/status.
  const terminal = {
    matchId,
    timestamp: record.endedAt ?? new Date().toISOString(),
    kind: 'bot-match-terminal',
    turn: engine.turnNumber,
    result: resultField,
    winReason: endReason,
    terminal: {
      winner: winnerLabel,
      loser: loserLabel,
      reason: endReason,
      turns: engine.turnNumber,
      durationMs:
        Number.isFinite(startedAtMs) && Number.isFinite(endedAtMs)
          ? endedAtMs - startedAtMs
          : null,
      violations: []
    },
    // Persisted payload — consumed by buildMatchReplayFromJsonl.
    persisted: {
      matchId,
      players: record.players,
      winner: matchResult?.winner ?? null,
      loser: matchResult?.loser ?? null,
      turns: engine.turnNumber,
      duration: durationSec,
      createdAt: Number.isFinite(startedAtMs) ? startedAtMs : Date.now(),
      status,
      endReason,
      moves: moveHistory,
      finalState
    }
  };
  return [header, terminal];
};

const writeBotMatchJsonlFallback = (
  matchId: string,
  record: InternalRecord,
  engine: RiftboundGameEngine,
  matchResult: MatchResult | null,
  endReason: string,
  status: 'completed' | 'crashed'
): void => {
  try {
    fs.mkdirSync(BOT_MATCHES_JSONL_DIR, { recursive: true });
    const filePath = path.join(BOT_MATCHES_JSONL_DIR, `${matchId}.jsonl`);
    const lines = buildBotMatchJsonlRecords(
      matchId,
      record,
      engine,
      matchResult,
      endReason,
      status
    );
    const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    fs.writeFileSync(filePath, body, { encoding: 'utf8' });
    logger.info('[BOT-MATCH] wrote JSONL fallback for bot match', {
      matchId,
      filePath,
      moves: (lines[1] as any)?.persisted?.moves?.length ?? 0
    });
  } catch (error) {
    logger.error('[BOT-MATCH] JSONL fallback write failed', {
      matchId,
      error: (error as Error).message
    });
  }
};

const finalize = (
  matchId: string,
  status: 'completed' | 'crashed',
  reason: string,
  engine: RiftboundGameEngine | null
) => {
  const record = REGISTRY.get(matchId);
  if (!record) return;
  record.status = status;
  record.reason = reason;
  record.endedAt = new Date().toISOString();
  if (engine) {
    record.turn = engine.turnNumber;
    const result = engine.getMatchResult?.();
    if (result?.winner) {
      record.winner = result.winner;
    }
    publishSpectatorState(matchId, engine);
    if (result) {
      try {
        publishMatchCompletion(matchId, result);
      } catch (error) {
        logger.warn('[BOT-MATCH] match-completion publish failed', { matchId, error });
      }
    }
    // Persist the final state. Dynamo first (canonical store used by real
    // PvP); on failure (missing table in local dev) fall back to a JSONL on
    // disk so replay-reconstructor / matchReplay / recentMatches have
    // something to read. Done inline-async; do not block finalize return.
    const effectiveResult: MatchResult =
      result ??
      {
        matchId,
        winner: record.winner ?? record.players[0],
        loser:
          record.winner && record.winner !== record.players[0]
            ? record.players[0]
            : record.players[1],
        reason: 'timeout',
        duration: Date.now() - Date.parse(record.startedAt),
        turns: engine.turnNumber,
        moves: engine.getGameState().moveHistory ?? []
      };
    (async () => {
      try {
        await persistMatchFinalState(
          matchId,
          engine.getGameState(),
          effectiveResult,
          `bot_match_${reason}`
        );
      } catch (error) {
        logger.warn(
          '[BOT-MATCH] persistMatchFinalState failed, writing JSONL fallback',
          { matchId, error: (error as Error).message }
        );
        writeBotMatchJsonlFallback(
          matchId,
          record,
          engine,
          result ?? effectiveResult,
          reason,
          status
        );
      }
    })().catch((error) => {
      logger.error('[BOT-MATCH] finalize persistence task threw', {
        matchId,
        error: (error as Error).message
      });
    });
  }
  trimRegistry();
};

const driveMatch = async (
  matchId: string,
  engine: RiftboundGameEngine,
  players: [string, string],
  strategies: [StrategyName, StrategyName],
  intervalMs: number
) => {
  const rngA = makeRng(hashSeed(`${matchId}:A`));
  const rngB = makeRng(hashSeed(`${matchId}:B`));
  const botA = getBot(strategies[0]);
  const botB = getBot(strategies[1]);
  const [playerA, playerB] = players;

  let totalActions = 0;
  let consecutiveNoProgress = 0;
  // Defense-in-depth wall-clock stall cap. Some bot seeds hang indefinitely at
  // e.g. turn 6 / main_1 with `consecutiveNoProgress` never flipping because
  // each round dispatches advance_phase/pass_priority fallbacks that keep
  // `totalActions` incrementing without real state change. We track real
  // forward progress via (turnNumber, phase, totalActions) triple and fire 60s
  // after the last observed change. Complements — does not replace — the
  // existing `no_progress` detector.
  let lastProgressAt = Date.now();
  let lastProgressSignature = `${engine.turnNumber}:${engine.currentPhase}:0`;
  const STALL_CAP_MS = 60_000;

  while (true) {
    const record = REGISTRY.get(matchId);
    if (!record || record.cancelled) {
      logger.info('[BOT-MATCH] driver halted (cancelled or evicted)', { matchId });
      return;
    }
    record.status = 'running';
    record.turn = engine.turnNumber;

    const status = engine.status;
    if (
      status === GameStatus.WINNER_DETERMINED ||
      status === GameStatus.COMPLETED
    ) {
      finalize(matchId, 'completed', 'engine_finished', engine);
      return;
    }
    if (engine.turnNumber > MAX_TURNS) {
      finalize(matchId, 'completed', 'turn_limit_reached', engine);
      return;
    }
    if (totalActions > MAX_TOTAL_ACTIONS) {
      finalize(matchId, 'completed', 'action_limit_reached', engine);
      return;
    }
    if (Date.now() - lastProgressAt > STALL_CAP_MS) {
      logger.warn('[BOT-MATCH] wall-clock stall cap fired', {
        matchId,
        turn: engine.turnNumber,
        phase: engine.currentPhase,
        totalActions,
        sinceProgressMs: Date.now() - lastProgressAt
      });
      finalize(matchId, 'completed', 'stalled', engine);
      return;
    }

    let progressed = false;
    for (const [pid, bot, rng] of [
      [playerA, botA, rngA] as const,
      [playerB, botB, rngB] as const
    ]) {
      let legals;
      try {
        legals = enumerateLegalActions(engine, pid);
      } catch (error) {
        logger.error('[BOT-MATCH] enumerateLegalActions threw', { matchId, pid, error });
        finalize(matchId, 'crashed', `enumerate_failed: ${(error as Error).message}`, engine);
        return;
      }
      if (legals.length === 0) continue;
      const action = bot(engine, pid, rng);
      if (!action) continue;
      try {
        dispatchAction(engine, pid, action);
        totalActions += 1;
        progressed = true;
      } catch (error) {
        logger.warn('[BOT-MATCH] dispatchAction threw, attempting to skip', {
          matchId,
          pid,
          action: action?.kind,
          error: (error as Error).message
        });
        // Force forward progress so a persistently-illegal action (e.g. a
        // commence_battle on a battlefield the engine already resolved this
        // turn) can't livelock the driver. advance_phase is a no-op when the
        // bot isn't the current player, so this is safe for both sides.
        try {
          dispatchAction(engine, pid, { kind: 'advance_phase' });
          totalActions += 1;
          progressed = true;
        } catch {
          // Fall back to pass_priority if we're mid-reaction/chain and can't
          // advance the phase directly.
          try {
            dispatchAction(engine, pid, { kind: 'pass_priority' });
            totalActions += 1;
            progressed = true;
          } catch {
            // Last resort: leave progressed=false so the no-progress guard
            // finalizes the match instead of spinning.
          }
        }
      }
    }

    try {
      await persistEngineSnapshot(matchId, engine);
    } catch (error) {
      logger.warn('[BOT-MATCH] persistEngineSnapshot failed', { matchId, error });
    }
    publishSpectatorState(matchId, engine);

    if (!progressed) {
      consecutiveNoProgress += 1;
      if (consecutiveNoProgress >= MAX_NO_PROGRESS_ROUNDS) {
        finalize(matchId, 'completed', 'no_progress', engine);
        return;
      }
    } else {
      consecutiveNoProgress = 0;
    }

    // Update the wall-clock progress marker only on real forward motion —
    // turn advance or phase change or a new totalActions count. If the bot
    // is stuck spamming advance_phase at turn 6 / main_1, the signature
    // still changes for a couple of iterations (totalActions bumps) but then
    // plateaus once engine state freezes, and the 60s cap kicks in.
    const currentSignature = `${engine.turnNumber}:${engine.currentPhase}:${totalActions}`;
    if (currentSignature !== lastProgressSignature) {
      lastProgressSignature = currentSignature;
      lastProgressAt = Date.now();
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};

export interface StartBotMatchOptions {
  strategyA?: string | null;
  strategyB?: string | null;
  intervalMs?: number | null;
}

export interface StartBotMatchResult {
  matchId: string;
  players: [string, string];
  strategies: [StrategyName, StrategyName];
  spectatorPath: string;
}

export const startBotMatch = async (
  opts: StartBotMatchOptions = {}
): Promise<StartBotMatchResult> => {
  const strategies: [StrategyName, StrategyName] = [
    normaliseStrategy(opts.strategyA, DEFAULT_STRATEGY_A),
    normaliseStrategy(opts.strategyB, DEFAULT_STRATEGY_B)
  ];
  const requestedInterval = Number(opts.intervalMs);
  const intervalMs = Number.isFinite(requestedInterval)
    ? Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, requestedInterval))
    : DEFAULT_INTERVAL_MS;

  const matchId = `bot-${randomUUID()}`;
  if (await matchSnapshotExists(matchId)) {
    throw new Error('Generated matchId already exists');
  }
  const players: [string, string] = [
    `bot-${strategies[0]}-A`,
    `bot-${strategies[1]}-B`
  ];

  const engine = new RiftboundGameEngine(matchId, [
    { playerId: players[0], name: `Bot A (${strategies[0]})` },
    { playerId: players[1], name: `Bot B (${strategies[1]})` }
  ]);
  const deckRngA = makeRng(hashSeed(`${matchId}:deckA`));
  const deckRngB = makeRng(hashSeed(`${matchId}:deckB`));
  const deckA = buildBotDeck(deckRngA, `${matchId}:A`);
  const deckB = buildBotDeck(deckRngB, `${matchId}:B`);
  engine.initializeGame({ [players[0]]: deckA, [players[1]]: deckB });

  await persistEngineSnapshot(matchId, engine);
  publishSpectatorState(matchId, engine);

  const record: InternalRecord = {
    matchId,
    status: 'initializing',
    turn: engine.turnNumber,
    players,
    strategies,
    startedAt: new Date().toISOString(),
    endedAt: null,
    winner: null,
    reason: null,
    cancelled: false
  };
  REGISTRY.set(matchId, record);
  trimRegistry();

  driveMatch(matchId, engine, players, strategies, intervalMs).catch((error) => {
    logger.error('[BOT-MATCH] driver crashed at top level', { matchId, error });
    finalize(matchId, 'crashed', `unhandled: ${(error as Error).message}`, engine);
  });

  return {
    matchId,
    players,
    strategies,
    spectatorPath: `/game/${encodeURIComponent(matchId)}`
  };
};

export const listActiveBotMatches = (): BotMatchSummary[] => {
  pruneFinished();
  return Array.from(REGISTRY.values())
    .map(({ cancelled: _cancelled, ...summary }) => summary)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
};

// Snapshot lookup of a single in-memory bot match record. Used by
// Query.matchStatus to report on in-progress matches. Returns null when the
// matchId is not currently tracked (never started, or already pruned).
export const getActiveBotMatch = (matchId: string): BotMatchSummary | null => {
  const record = REGISTRY.get(matchId);
  if (!record) return null;
  const { cancelled: _cancelled, ...summary } = record;
  return summary;
};

export const cancelBotMatch = (matchId: string): boolean => {
  const record = REGISTRY.get(matchId);
  if (!record) return false;
  record.cancelled = true;
  if (record.status === 'running' || record.status === 'initializing') {
    record.status = 'completed';
    record.reason = 'cancelled';
    record.endedAt = new Date().toISOString();
  }
  return true;
};

export const cancelAllBotMatches = (): number => {
  let count = 0;
  for (const record of REGISTRY.values()) {
    if (record.status === 'running' || record.status === 'initializing') {
      record.cancelled = true;
      record.status = 'completed';
      record.reason = 'cancelled';
      record.endedAt = new Date().toISOString();
      count += 1;
    }
  }
  // Tear down any in-flight replay sessions too — they share this graceful
  // shutdown entry point so their setTimeout drivers stop cleanly.
  try {
    // Lazy require to avoid a cyclic import at module-load time.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { stopAllReplaySessions } = require('./replay-session') as typeof import('./replay-session');
    stopAllReplaySessions();
  } catch (error) {
    logger.warn('[BOT-MATCH] stopAllReplaySessions failed', { error });
  }
  return count;
};
