import { randomUUID } from 'node:crypto';
import logger from './logger';
import { GameStatus, RiftboundGameEngine } from './game-engine';
import { serializeGameState } from './game-state-serializer';
import { persistEngineSnapshot, matchSnapshotExists } from './match-routes';
import {
  publishGameStateChange,
  publishMatchCompletion
} from './graphql/pubsub';
import { recordFrame } from './replay-frame-store';
import {
  buildDeckConfigForGame,
  dispatchAction,
  enumerateLegalActions,
  getBot,
  makeRng,
  StrategyName
} from './self-play';

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
  const deckRng = makeRng(hashSeed(`${matchId}:deck`));
  const deckA = buildDeckConfigForGame(deckRng, 0, null, null, true);
  const deckB = buildDeckConfigForGame(deckRng, 1, null, null, true);
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
    spectatorPath: `/spectate?matchId=${encodeURIComponent(matchId)}`
  };
};

export const listActiveBotMatches = (): BotMatchSummary[] => {
  pruneFinished();
  return Array.from(REGISTRY.values())
    .map(({ cancelled: _cancelled, ...summary }) => summary)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
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
