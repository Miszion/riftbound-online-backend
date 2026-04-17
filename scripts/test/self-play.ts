/**
 * Riftbound Online - Agent-vs-Agent Self-Play Harness
 *
 * Phase 5 QA deliverable. Runs fully in-process against RiftboundGameEngine.
 * No HTTP, no GraphQL, no AWS. Instantiates the engine directly, plays N
 * games between two pluggable strategies, enforces invariants each turn,
 * captures crashes/timeouts/invariant violations, and writes a JSON report.
 *
 * CLI:
 *   npm run test:selfplay -- \
 *     [--games=10] [--seed=1234] [--turnLimit=200] \
 *     [--strategyA=random] [--strategyB=aggro] \
 *     [--quick] [--quiet] [--report=/path/to/out.json]
 *
 * Strategies: random | aggro | control
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  RiftboundGameEngine,
  GameStatus,
  GamePhase,
  CardType,
  Domain,
  Card,
  PlayerState,
  RuneCard,
  PlayerDeckConfig
} from '../../src/game-engine';
import {
  getCardCatalog,
  EnrichedCardRecord
} from '../../src/card-catalog';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StrategyName = 'random' | 'aggro' | 'control';

interface HarnessConfig {
  games: number;
  seed: number;
  seedProvided: boolean;
  turnLimit: number;
  strategyA: StrategyName;
  strategyB: StrategyName;
  quiet: boolean;
  quick: boolean;
  report: string;
}

interface Rng {
  next(): number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T | undefined;
}

interface Action {
  kind:
    | 'play_card'
    | 'move_unit'
    | 'deploy_leader'
    | 'advance_phase'
    | 'pass_priority'
    | 'concede';
  // play_card
  cardIndex?: number;
  destinationId?: string | null;
  targets?: string[];
  // move_unit / resolveCombat
  creatureInstanceId?: string;
  // debug
  label?: string;
}

interface GameRecord {
  gameId: string;
  seed: number;
  strategyA: StrategyName;
  strategyB: StrategyName;
  turns: number;
  status: 'completed' | 'crashed' | 'timeout' | 'invariant';
  winner: string | null;
  error?: string;
  errorStack?: string;
  violations: string[];
  flaggedLoop?: boolean;
}

interface CrashSample {
  gameId: string;
  seed: number;
  strategyA: StrategyName;
  strategyB: StrategyName;
  turn: number;
  error: string;
  stack?: string;
  partialState?: unknown;
}

interface Report {
  startedAt: string;
  finishedAt: string;
  config: {
    games: number;
    seed: number | 'random';
    strategyA: StrategyName;
    strategyB: StrategyName;
    turnLimit: number;
    quick: boolean;
  };
  summary: {
    gamesCompleted: number;
    gamesCrashed: number;
    gamesTimedOut: number;
    gamesInvariant: number;
    avgTurns: number;
    winsA: number;
    winsB: number;
    draws: number;
  };
  violationsByType: Record<string, number>;
  topCrashes: CrashSample[];
  infiniteLoopCandidates: string[];
  examples: {
    firstCrash: CrashSample | null;
    firstTimeout: GameRecord | null;
    firstInvariantViolation: GameRecord | null;
  };
  notes: string[];
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): HarnessConfig {
  const defaults: HarnessConfig = {
    games: 10,
    seed: Math.floor(Math.random() * 0xffffffff),
    seedProvided: false,
    turnLimit: 200,
    strategyA: 'random',
    strategyB: 'random',
    quiet: false,
    quick: false,
    report: '/Users/miszion/workplace/nexus-data/research/riftbound-selfplay-result.json'
  };

  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const body = raw.slice(2);
    const eq = body.indexOf('=');
    const key = eq === -1 ? body : body.slice(0, eq);
    const val = eq === -1 ? 'true' : body.slice(eq + 1);

    switch (key) {
      case 'games':
        defaults.games = Math.max(1, parseInt(val, 10) || defaults.games);
        break;
      case 'seed':
        defaults.seed = parseInt(val, 10) >>> 0;
        defaults.seedProvided = true;
        break;
      case 'turnLimit':
        defaults.turnLimit = Math.max(1, parseInt(val, 10) || defaults.turnLimit);
        break;
      case 'strategyA':
        defaults.strategyA = normalizeStrategy(val);
        break;
      case 'strategyB':
        defaults.strategyB = normalizeStrategy(val);
        break;
      case 'quick':
        defaults.quick = val === 'true' || val === '1' || val === '';
        break;
      case 'quiet':
        defaults.quiet = val === 'true' || val === '1' || val === '';
        break;
      case 'report':
        defaults.report = val;
        break;
      default:
        // unknown flag, ignore
        break;
    }
  }
  return defaults;
}

function normalizeStrategy(value: string): StrategyName {
  const v = value.toLowerCase();
  if (v === 'random' || v === 'aggro' || v === 'control') return v;
  return 'random';
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32)
// ---------------------------------------------------------------------------

function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(max: number): number {
      if (max <= 0) return 0;
      return Math.floor(next() * max);
    },
    pick<T>(items: readonly T[]): T | undefined {
      if (!items.length) return undefined;
      return items[Math.floor(next() * items.length)];
    }
  };
}

function shuffleInPlace<T>(arr: T[], rng: Rng): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Deck construction from real catalog
// ---------------------------------------------------------------------------

interface DeckAssembly {
  mainDeck: string[];
  runeDeck: RuneCard[];
  battlefields: Card[];
}

const DOMAIN_LIST: Domain[] = Object.values(Domain) as Domain[];

function pickPlayableCards(catalog: EnrichedCardRecord[]): EnrichedCardRecord[] {
  // Keep only card types the engine accepts: creature, spell, artifact, enchantment
  // Exclude runes (they live in the rune deck) and battlefields (separate zone)
  const allowed = new Set(['creature', 'spell', 'artifact', 'enchantment']);
  return catalog.filter((c) => {
    const type = (c.type ?? '').toLowerCase();
    if (!allowed.has(type)) return false;
    const tags = (c.tags ?? []).map((t) => t.toLowerCase());
    if (tags.includes('battlefield')) return false;
    return true;
  });
}

function pickBattlefieldRecords(catalog: EnrichedCardRecord[]): EnrichedCardRecord[] {
  return catalog.filter((c) => {
    const tags = (c.tags ?? []).map((t) => t.toLowerCase());
    const type = (c.type ?? '').toLowerCase();
    return tags.includes('battlefield') || type === 'battlefield';
  });
}

function buildSyntheticBattlefield(index: number): Card {
  return {
    id: `synthetic-battlefield-${index}`,
    slug: `synthetic-battlefield-${index}`,
    name: `Synthetic Battlefield ${index}`,
    type: CardType.ENCHANTMENT,
    tags: ['Battlefield'],
    colors: [],
    keywords: [],
    text: 'A synthetic battlefield used by the self-play harness.',
    metadata: {}
  };
}

function buildRuneDeck(rng: Rng): RuneCard[] {
  const runes: RuneCard[] = [];
  for (let i = 0; i < 12; i++) {
    const domain = DOMAIN_LIST[i % DOMAIN_LIST.length];
    runes.push({
      id: `selfplay-rune-${i}`,
      name: `Self-Play Rune ${i}`,
      domain,
      energyValue: 1,
      powerValue: 1,
      slug: `selfplay-rune-${i}`,
      assets: null,
      isTapped: false,
      cardSnapshot: null
    });
  }
  return shuffleInPlace(runes, rng);
}

function assembleDeck(
  playable: EnrichedCardRecord[],
  battlefieldRecords: EnrichedCardRecord[],
  rng: Rng,
  gameIndex: number,
  deckSize = 40
): DeckAssembly {
  const pool = playable.slice();
  shuffleInPlace(pool, rng);
  const mainDeck: string[] = [];
  while (mainDeck.length < deckSize && pool.length > 0) {
    const pick = pool[mainDeck.length % pool.length];
    mainDeck.push(pick.id);
  }

  let battlefields: Card[] = [];
  if (battlefieldRecords.length > 0) {
    const bfPool = battlefieldRecords.slice();
    shuffleInPlace(bfPool, rng);
    battlefields = bfPool.slice(0, 1).map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      type: CardType.ENCHANTMENT,
      tags: (r.tags && r.tags.length > 0 ? r.tags : ['Battlefield']),
      colors: r.colors ?? [],
      keywords: r.keywords ?? [],
      text: r.effect ?? '',
      metadata: {}
    }));
  }
  if (battlefields.length === 0) {
    battlefields = [buildSyntheticBattlefield(gameIndex)];
  }

  return {
    mainDeck,
    runeDeck: buildRuneDeck(rng),
    battlefields
  };
}

function buildTestFallbackDeck(rng: Rng, size = 40): { mainDeck: Card[]; runeDeck: RuneCard[]; battlefields: Card[] } {
  // Used by --quick or when catalog cannot be loaded.
  const mainDeck: Card[] = Array.from({ length: size }, (_, i) => ({
    id: `selfplay-creature-${i}`,
    slug: `selfplay-creature-${i}`,
    name: `Self-Play Creature ${i}`,
    type: CardType.CREATURE,
    colors: [],
    tags: [],
    keywords: [],
    energyCost: 1 + (i % 3),
    manaCost: 1 + (i % 3),
    domain: DOMAIN_LIST[i % DOMAIN_LIST.length],
    power: 2 + (i % 3),
    toughness: 2 + (i % 3),
    text: 'Harness fallback creature.',
    metadata: {}
  }));
  shuffleInPlace(mainDeck, rng);
  return {
    mainDeck,
    runeDeck: buildRuneDeck(rng),
    battlefields: [buildSyntheticBattlefield(0)]
  };
}

// ---------------------------------------------------------------------------
// Engine setup helpers (mirrors test-helpers.ts patterns)
// ---------------------------------------------------------------------------

function buildDeckConfigForGame(
  rng: Rng,
  gameIndex: number,
  playable: EnrichedCardRecord[] | null,
  battlefieldRecords: EnrichedCardRecord[] | null,
  quick: boolean
): PlayerDeckConfig {
  if (!quick && playable && playable.length >= 10) {
    const assembly = assembleDeck(playable, battlefieldRecords ?? [], rng, gameIndex);
    return {
      mainDeck: assembly.mainDeck as unknown as Card[], // DeckCardEntry allows strings
      runeDeck: assembly.runeDeck,
      battlefields: assembly.battlefields,
      championLegend: null,
      championLeader: null
    };
  }
  const fallback = buildTestFallbackDeck(rng);
  return {
    mainDeck: fallback.mainDeck,
    runeDeck: fallback.runeDeck,
    battlefields: fallback.battlefields,
    championLegend: null,
    championLeader: null
  };
}

function advancePastSetup(
  engine: RiftboundGameEngine,
  p1: string,
  p2: string,
  rng: Rng
): void {
  // Coin flip - cycle choices until one side wins.
  let attempts = 0;
  while (engine.status === GameStatus.COIN_FLIP && attempts < 6) {
    const a = rng.int(3);
    const b = (a + 1) % 3;
    try {
      engine.submitInitiativeChoice(p1, a);
    } catch {
      // prompt may already be resolved
    }
    try {
      engine.submitInitiativeChoice(p2, b);
    } catch {
      // prompt may already be resolved
    }
    attempts++;
  }

  // Battlefield selection
  if (engine.status === GameStatus.BATTLEFIELD_SELECTION) {
    const state = engine.getGameState();
    for (const pid of [p1, p2]) {
      const prompt = state.prompts.find(
        (p) => p.type === 'battlefield' && p.playerId === pid && !p.resolved
      );
      if (prompt) {
        const data = prompt.data as { options?: Array<{ id?: string; battlefieldId?: string }> };
        const options = data?.options ?? [];
        if (options.length > 0) {
          const choice = options[0];
          const id = choice.id ?? choice.battlefieldId;
          if (id) {
            try {
              engine.selectBattlefield(pid, id);
            } catch {
              // ignore - may auto-assign
            }
          }
        }
      }
    }
  }

  // Mulligan - keep all cards
  if (engine.status === GameStatus.MULLIGAN) {
    for (const pid of [p1, p2]) {
      try {
        engine.submitMulligan(pid, []);
      } catch {
        // prompt may already be resolved
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Legal action enumeration
// ---------------------------------------------------------------------------

function enumerateLegalActions(engine: RiftboundGameEngine, playerId: string): Action[] {
  const actions: Action[] = [];
  if (engine.status !== GameStatus.IN_PROGRESS) return actions;

  const state = engine.getGameState();
  const player = state.players.find((p) => p.playerId === playerId);
  if (!player) return actions;

  const current = engine.getCurrentPlayerState();
  const isCurrent = current.playerId === playerId;

  // Priority-window responses
  const pw = state.priorityWindow;
  if (pw && pw.holder === playerId) {
    actions.push({ kind: 'pass_priority', label: 'pass_priority' });
  }

  if (!isCurrent) {
    // Opponent priority is handled above; otherwise nothing to do.
    return actions;
  }

  const phase = engine.currentPhase;

  // Phase advance is always a legal fallback during a player's turn.
  actions.push({ kind: 'advance_phase', label: `advance_${phase}` });

  // Play cards from hand during main phases.
  if (phase === GamePhase.MAIN_1 || phase === GamePhase.MAIN_2) {
    for (let i = 0; i < player.hand.length; i++) {
      const card = player.hand[i];
      if (!card) continue;
      if (!isCardAffordable(player, card)) continue;
      const type = (card.type ?? '').toLowerCase();
      if (type !== 'creature' && type !== 'spell' && type !== 'artifact' && type !== 'enchantment') {
        continue;
      }
      if (type === 'spell') {
        // Leave targets empty - many spells accept no targets or the engine
        // will defer target selection via prompt. We simply record the play.
        actions.push({
          kind: 'play_card',
          cardIndex: i,
          destinationId: null,
          targets: [],
          label: `play:${card.name ?? card.id}`
        });
      } else {
        // Permanent - try deploying to player-controlled battlefield or base.
        const battlefieldIds = state.battlefields
          .filter((bf) => bf.controller === playerId || !bf.controller)
          .map((bf) => bf.battlefieldId);
        actions.push({
          kind: 'play_card',
          cardIndex: i,
          destinationId: 'base',
          targets: [],
          label: `play_to_base:${card.name ?? card.id}`
        });
        for (const bfId of battlefieldIds) {
          actions.push({
            kind: 'play_card',
            cardIndex: i,
            destinationId: bfId,
            targets: [],
            label: `play_to_bf:${card.name ?? card.id}`
          });
        }
      }
    }

    // Deploy champion leader (if present, unplayed, and affordable).
    if (player.championLeader && !player.championLeaderDeployed) {
      if (isCardAffordable(player, player.championLeader)) {
        actions.push({ kind: 'deploy_leader', destinationId: 'base', label: 'deploy_leader' });
      }
    }
  }

  // Move units during MAIN_1 or COMBAT.
  if (phase === GamePhase.MAIN_1 || phase === GamePhase.COMBAT) {
    for (const creature of player.board.creatures) {
      if (creature.isTapped) continue;
      if (creature.summoned) continue;
      // Move to any battlefield we can reach.
      for (const bf of state.battlefields) {
        actions.push({
          kind: 'move_unit',
          creatureInstanceId: creature.instanceId,
          destinationId: bf.battlefieldId,
          label: `move:${creature.name}->${bf.name}`
        });
      }
      // Return to base only if currently deployed to a battlefield.
      if (creature.location && creature.location.zone === 'battlefield') {
        actions.push({
          kind: 'move_unit',
          creatureInstanceId: creature.instanceId,
          destinationId: 'base',
          label: `move:${creature.name}->base`
        });
      }
    }
  }

  return actions;
}

function isCardAffordable(player: PlayerState, card: Card): boolean {
  const energyCost = (card.energyCost ?? card.manaCost ?? 0) as number;
  const available =
    (player.resources?.energy ?? 0) +
    (player.channeledRunes?.filter((r) => !r.isTapped).length ?? 0);
  if (energyCost > available) return false;
  // Power cost check is best-effort - the engine re-validates on play anyway.
  return true;
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

type Strategy = (
  engine: RiftboundGameEngine,
  playerId: string,
  rng: Rng
) => Action | null;

const randomStrategy: Strategy = (engine, playerId, rng) => {
  const actions = enumerateLegalActions(engine, playerId);
  if (actions.length === 0) return null;
  return rng.pick(actions) ?? null;
};

const aggroStrategy: Strategy = (engine, playerId, rng) => {
  const actions = enumerateLegalActions(engine, playerId);
  if (actions.length === 0) return null;
  const state = engine.getGameState();
  const player = state.players.find((p) => p.playerId === playerId)!;

  // 1. Prefer deploying units to a battlefield (pressure).
  const deployBf = actions.filter(
    (a) => a.kind === 'play_card' && typeof a.destinationId === 'string' && a.destinationId !== 'base'
  );
  if (deployBf.length > 0) {
    return pickHighestEnergy(deployBf, player) ?? rng.pick(deployBf)!;
  }
  // 2. Fall back to base deploys.
  const baseDeploy = actions.filter(
    (a) => a.kind === 'play_card' && a.destinationId === 'base'
  );
  if (baseDeploy.length > 0) {
    return pickHighestEnergy(baseDeploy, player) ?? rng.pick(baseDeploy)!;
  }
  // 3. Move existing units onto battlefields.
  const moveToBf = actions.filter(
    (a) => a.kind === 'move_unit' && a.destinationId && a.destinationId !== 'base'
  );
  if (moveToBf.length > 0) return rng.pick(moveToBf)!;
  // 4. Dump remaining hand (spells).
  const playAny = actions.filter((a) => a.kind === 'play_card');
  if (playAny.length > 0) return rng.pick(playAny)!;
  // 5. Advance phase to push combat/end.
  const advance = actions.find((a) => a.kind === 'advance_phase');
  if (advance) return advance;
  return rng.pick(actions) ?? null;
};

const controlStrategy: Strategy = (engine, playerId, rng) => {
  const actions = enumerateLegalActions(engine, playerId);
  if (actions.length === 0) return null;
  const state = engine.getGameState();
  const player = state.players.find((p) => p.playerId === playerId)!;

  // 1. Prefer spells (approximates draw/removal).
  const spellPlays = actions.filter((a) => {
    if (a.kind !== 'play_card' || a.cardIndex === undefined) return false;
    const card = player.hand[a.cardIndex];
    return card && (card.type ?? '').toLowerCase() === 'spell';
  });
  if (spellPlays.length > 0) return rng.pick(spellPlays)!;

  // 2. Hold units on base (defensive).
  const baseDeploy = actions.filter(
    (a) => a.kind === 'play_card' && a.destinationId === 'base'
  );
  if (baseDeploy.length > 0 && player.board.creatures.length < 3) {
    // Only deploy a few units; avoid overcommitting.
    return rng.pick(baseDeploy)!;
  }

  // 3. Pull units back to base if they are out.
  const retreat = actions.filter(
    (a) => a.kind === 'move_unit' && a.destinationId === 'base'
  );
  if (retreat.length > 0) return rng.pick(retreat)!;

  // 4. Advance phase to pass time.
  const advance = actions.find((a) => a.kind === 'advance_phase');
  if (advance) return advance;
  return rng.pick(actions) ?? null;
};

function pickHighestEnergy(actions: Action[], player: PlayerState): Action | null {
  let best: Action | null = null;
  let bestCost = -1;
  for (const a of actions) {
    if (a.cardIndex === undefined) continue;
    const card = player.hand[a.cardIndex];
    if (!card) continue;
    const cost = (card.energyCost ?? card.manaCost ?? 0) as number;
    if (cost > bestCost) {
      bestCost = cost;
      best = a;
    }
  }
  return best;
}

function getStrategy(name: StrategyName): Strategy {
  switch (name) {
    case 'aggro':
      return aggroStrategy;
    case 'control':
      return controlStrategy;
    case 'random':
    default:
      return randomStrategy;
  }
}

// ---------------------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------------------

function executeAction(engine: RiftboundGameEngine, playerId: string, action: Action): void {
  switch (action.kind) {
    case 'play_card':
      if (action.cardIndex === undefined) throw new Error('play_card missing cardIndex');
      engine.playCard(playerId, action.cardIndex, action.targets ?? [], action.destinationId ?? null);
      return;
    case 'move_unit':
      if (!action.creatureInstanceId || !action.destinationId) {
        throw new Error('move_unit missing creature or destination');
      }
      engine.moveUnit(playerId, action.creatureInstanceId, action.destinationId);
      return;
    case 'deploy_leader':
      engine.deployChampionLeader(playerId, action.destinationId ?? null);
      return;
    case 'pass_priority':
      engine.passPriority(playerId);
      return;
    case 'advance_phase':
      engine.proceedToNextPhase();
      return;
    case 'concede':
      engine.concedeMatch(playerId);
      return;
    default:
      throw new Error(`Unknown action kind: ${(action as { kind: string }).kind}`);
  }
}

// ---------------------------------------------------------------------------
// Invariant checks
// ---------------------------------------------------------------------------

function assertInvariants(
  engine: RiftboundGameEngine,
  turnNumber: number,
  turnLimit: number,
  violations: string[]
): void {
  const state = engine.getGameState();

  // Turn bounds
  if (turnNumber > turnLimit) {
    violations.push('turn_limit_exceeded');
    throw new Error(`Turn count ${turnNumber} exceeded limit ${turnLimit}`);
  }

  for (const player of state.players) {
    if ((player.resources?.energy ?? 0) < 0) {
      violations.push('negative_energy');
      throw new Error(`Negative energy on ${player.playerId}: ${player.resources.energy}`);
    }
    if (player.victoryPoints < 0) {
      violations.push('negative_vp');
      throw new Error(`Negative VP on ${player.playerId}`);
    }
    if (player.hand.length > 50) {
      violations.push('hand_too_large');
      throw new Error(`Hand size ${player.hand.length} exceeds sanity bound on ${player.playerId}`);
    }
    // Mutually-exclusive zones: gather all instanceIds in hand/deck/board/graveyard/exile
    // and ensure no duplicates across zones.
    const zoneIds = new Map<string, string>(); // id -> zone
    const register = (zone: string, id: string | undefined): void => {
      if (!id) return;
      const prior = zoneIds.get(id);
      if (prior && prior !== zone) {
        violations.push('zone_overlap');
        throw new Error(`Card ${id} in both ${prior} and ${zone} for ${player.playerId}`);
      }
      zoneIds.set(id, zone);
    };
    for (const c of player.hand) register('hand', c.instanceId ?? c.id);
    for (const c of player.deck) register('deck', c.instanceId ?? c.id);
    for (const c of player.graveyard) register('graveyard', c.instanceId ?? c.id);
    for (const c of player.exile) register('exile', c.instanceId ?? c.id);
    for (const c of player.board.creatures) register('board_creatures', c.instanceId ?? c.id);
    for (const c of player.board.artifacts) register('board_artifacts', c.instanceId ?? c.id);
    for (const c of player.board.enchantments) register('board_enchantments', c.instanceId ?? c.id);
  }

  // Active player has priority in own main phases: the engine enforces this internally
  // when calls are made, so we just verify the current player reference is consistent.
  const cur = engine.getCurrentPlayerState();
  if (!state.players.find((p) => p.playerId === cur.playerId)) {
    violations.push('current_player_missing');
    throw new Error(`Current player ${cur.playerId} not in player list`);
  }

  // Re-serialize / re-hydrate drift check (every 10 turns to amortize cost).
  if (turnNumber % 10 === 0) {
    try {
      const snapshot = JSON.parse(JSON.stringify(state));
      const restored = RiftboundGameEngine.fromSerializedState(snapshot);
      const again = JSON.parse(JSON.stringify(restored.getGameState()));
      if (JSON.stringify(again.matchId) !== JSON.stringify(snapshot.matchId)) {
        violations.push('serialize_drift');
        throw new Error('Serialize/restore drift detected');
      }
    } catch (err) {
      // Restoration itself failing is a genuine issue.
      violations.push('serialize_throw');
      throw err;
    }
  }

  // Win condition not silently met
  const winnerSet = Boolean(state.winner);
  const statusEnded = state.status === GameStatus.WINNER_DETERMINED || state.status === GameStatus.COMPLETED;
  if (winnerSet && !statusEnded) {
    violations.push('silent_win');
    throw new Error(`Winner set but status is ${state.status}`);
  }
  for (const p of state.players) {
    if (p.victoryPoints >= p.victoryScore && !statusEnded) {
      violations.push('vp_threshold_without_end');
      throw new Error(`${p.playerId} reached VP threshold without game end`);
    }
  }
}

// ---------------------------------------------------------------------------
// Game runner
// ---------------------------------------------------------------------------

interface RunResult {
  record: GameRecord;
  crashSample?: CrashSample;
}

function playOneGame(
  gameIndex: number,
  cfg: HarnessConfig,
  baseSeed: number,
  playable: EnrichedCardRecord[] | null,
  battlefieldRecords: EnrichedCardRecord[] | null,
  log: (msg: string) => void
): RunResult {
  const seed = (baseSeed + gameIndex * 2654435761) >>> 0;
  const rng = makeRng(seed);
  const p1 = 'playerA';
  const p2 = 'playerB';
  const gameId = `selfplay-${gameIndex}-${seed}`;
  const record: GameRecord = {
    gameId,
    seed,
    strategyA: cfg.strategyA,
    strategyB: cfg.strategyB,
    turns: 0,
    status: 'completed',
    winner: null,
    violations: []
  };

  let engine: RiftboundGameEngine;
  try {
    engine = new RiftboundGameEngine(gameId, [p1, p2]);
    const deckA = buildDeckConfigForGame(rng, gameIndex, playable, battlefieldRecords, cfg.quick);
    const deckB = buildDeckConfigForGame(rng, gameIndex + 1, playable, battlefieldRecords, cfg.quick);
    engine.initializeGame({ [p1]: deckA, [p2]: deckB });
    advancePastSetup(engine, p1, p2, rng);
  } catch (err) {
    const e = err as Error;
    record.status = 'crashed';
    record.error = e.message;
    record.errorStack = e.stack;
    return {
      record,
      crashSample: {
        gameId,
        seed,
        strategyA: cfg.strategyA,
        strategyB: cfg.strategyB,
        turn: 0,
        error: e.message,
        stack: e.stack,
        partialState: null
      }
    };
  }

  if (engine.status !== GameStatus.IN_PROGRESS) {
    record.status = 'crashed';
    record.error = `Engine did not reach IN_PROGRESS (status=${engine.status})`;
    return {
      record,
      crashSample: {
        gameId,
        seed,
        strategyA: cfg.strategyA,
        strategyB: cfg.strategyB,
        turn: 0,
        error: record.error,
        partialState: safeSerialize(engine)
      }
    };
  }

  const strategyForPlayer = (pid: string): Strategy => {
    return pid === p1 ? getStrategy(cfg.strategyA) : getStrategy(cfg.strategyB);
  };

  // Loop detection
  let lastActionSignature = '';
  let sameSignatureStreak = 0;
  let iterationsWithoutTurnAdvance = 0;
  let lastTurn = engine.turnNumber;

  try {
    while (engine.status === GameStatus.IN_PROGRESS) {
      record.turns = engine.turnNumber;
      assertInvariants(engine, engine.turnNumber, cfg.turnLimit, record.violations);

      if (engine.turnNumber > cfg.turnLimit) {
        record.status = 'timeout';
        break;
      }

      // Decide whose turn it is for this step (priority window vs current player).
      const state = engine.getGameState();
      const priorityHolder = state.priorityWindow?.holder ?? null;
      const actorId = priorityHolder ?? engine.getCurrentPlayerState().playerId;
      const strat = strategyForPlayer(actorId);

      const action = strat(engine, actorId, rng) ?? { kind: 'advance_phase', label: 'fallback_advance' };
      const sig = `${actorId}|${action.kind}|${action.label ?? ''}|${engine.currentPhase}|${engine.turnNumber}`;
      if (sig === lastActionSignature) {
        sameSignatureStreak++;
      } else {
        sameSignatureStreak = 0;
        lastActionSignature = sig;
      }

      try {
        executeAction(engine, actorId, action);
      } catch (err) {
        // Swallow per-action errors: engine rejecting an illegal action should
        // not crash the harness. Fall back to phase advance next iteration.
        const e = err as Error;
        if (!cfg.quiet) log(`[${gameId}] action error: ${e.message}`);
        try {
          engine.proceedToNextPhase();
        } catch {
          // ignore
        }
      }

      // Turn / loop detection
      if (engine.turnNumber === lastTurn) {
        iterationsWithoutTurnAdvance++;
      } else {
        iterationsWithoutTurnAdvance = 0;
        lastTurn = engine.turnNumber;
      }

      if (sameSignatureStreak >= 50 || iterationsWithoutTurnAdvance >= 500) {
        record.flaggedLoop = true;
        record.status = 'timeout';
        record.violations.push('infinite_loop_suspected');
        break;
      }
    }

    // Determine winner
    const final = engine.getGameState();
    if (final.status === GameStatus.WINNER_DETERMINED) {
      record.winner = final.winner ?? null;
      if (record.status === 'completed') record.status = 'completed';
    } else if (record.status !== 'timeout') {
      record.status = 'timeout';
    }
    return { record };
  } catch (err) {
    const e = err as Error;
    const hitInvariant = record.violations.length > 0;
    record.status = hitInvariant ? 'invariant' : 'crashed';
    record.error = e.message;
    record.errorStack = e.stack;
    return {
      record,
      crashSample: {
        gameId,
        seed,
        strategyA: cfg.strategyA,
        strategyB: cfg.strategyB,
        turn: engine.turnNumber,
        error: e.message,
        stack: e.stack,
        partialState: safeSerialize(engine)
      }
    };
  }
}

function safeSerialize(engine: RiftboundGameEngine): unknown {
  try {
    return JSON.parse(JSON.stringify(engine.getGameState()));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Report aggregation
// ---------------------------------------------------------------------------

function buildReport(
  cfg: HarnessConfig,
  records: GameRecord[],
  crashes: CrashSample[],
  startedAt: Date,
  notes: string[]
): Report {
  let completed = 0;
  let crashed = 0;
  let timedOut = 0;
  let invariant = 0;
  let winsA = 0;
  let winsB = 0;
  let draws = 0;
  let totalTurns = 0;
  const violationsByType: Record<string, number> = {};
  const loopCandidates: string[] = [];
  let firstTimeout: GameRecord | null = null;
  let firstInvariant: GameRecord | null = null;

  for (const r of records) {
    totalTurns += r.turns;
    for (const v of r.violations) {
      violationsByType[v] = (violationsByType[v] ?? 0) + 1;
    }
    if (r.flaggedLoop) loopCandidates.push(r.gameId);
    switch (r.status) {
      case 'completed':
        completed++;
        if (r.winner === 'playerA') winsA++;
        else if (r.winner === 'playerB') winsB++;
        else draws++;
        break;
      case 'crashed':
        crashed++;
        break;
      case 'timeout':
        timedOut++;
        if (!firstTimeout) firstTimeout = r;
        break;
      case 'invariant':
        invariant++;
        if (!firstInvariant) firstInvariant = r;
        break;
    }
  }

  return {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    config: {
      games: cfg.games,
      seed: cfg.seedProvided ? cfg.seed : 'random',
      strategyA: cfg.strategyA,
      strategyB: cfg.strategyB,
      turnLimit: cfg.turnLimit,
      quick: cfg.quick
    },
    summary: {
      gamesCompleted: completed,
      gamesCrashed: crashed,
      gamesTimedOut: timedOut,
      gamesInvariant: invariant,
      avgTurns: records.length > 0 ? totalTurns / records.length : 0,
      winsA,
      winsB,
      draws
    },
    violationsByType,
    topCrashes: crashes.slice(0, 20),
    infiniteLoopCandidates: loopCandidates,
    examples: {
      firstCrash: crashes[0] ?? null,
      firstTimeout,
      firstInvariantViolation: firstInvariant
    },
    notes
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const cfg = parseArgs(process.argv.slice(2));
  const log = (msg: string): void => {
    if (!cfg.quiet) process.stdout.write(msg + '\n');
  };
  const notes: string[] = [];

  log(`[selfplay] starting ${cfg.games} games`);
  log(`[selfplay] strategyA=${cfg.strategyA} strategyB=${cfg.strategyB} seed=${cfg.seed} quick=${cfg.quick}`);

  let catalog: EnrichedCardRecord[] | null = null;
  let playable: EnrichedCardRecord[] | null = null;
  let battlefieldRecords: EnrichedCardRecord[] | null = null;
  if (!cfg.quick) {
    try {
      catalog = getCardCatalog();
      playable = pickPlayableCards(catalog);
      battlefieldRecords = pickBattlefieldRecords(catalog);
      log(`[selfplay] loaded catalog: ${catalog.length} cards, ${playable.length} playable, ${battlefieldRecords.length} battlefields`);
    } catch (err) {
      const e = err as Error;
      notes.push(`Catalog load failed: ${e.message}. Falling back to synthetic decks.`);
      log(`[selfplay] WARN catalog load failed: ${e.message} - using synthetic fallback decks`);
    }
  } else {
    notes.push('--quick used: synthetic fallback decks only');
  }

  const startedAt = new Date();
  const records: GameRecord[] = [];
  const crashes: CrashSample[] = [];

  for (let i = 0; i < cfg.games; i++) {
    const res = playOneGame(i, cfg, cfg.seed, playable, battlefieldRecords, log);
    records.push(res.record);
    if (res.crashSample) crashes.push(res.crashSample);
    if (!cfg.quiet) {
      log(`[selfplay] game ${i + 1}/${cfg.games} -> status=${res.record.status} turns=${res.record.turns} winner=${res.record.winner ?? 'none'} violations=${res.record.violations.length}`);
    }
  }

  const report = buildReport(cfg, records, crashes, startedAt, notes);

  // Ensure report directory exists
  try {
    fs.mkdirSync(path.dirname(cfg.report), { recursive: true });
    fs.writeFileSync(cfg.report, JSON.stringify(report, null, 2));
  } catch (err) {
    const e = err as Error;
    process.stderr.write(`[selfplay] ERROR writing report: ${e.message}\n`);
  }

  const s = report.summary;
  const oneLine = `[selfplay] done: ${s.gamesCompleted}/${cfg.games} completed, ${s.gamesCrashed} crashed, ${s.gamesTimedOut} timeout, ${s.gamesInvariant} invariant. winsA=${s.winsA} winsB=${s.winsB} draws=${s.draws} avgTurns=${s.avgTurns.toFixed(1)} report=${cfg.report}`;
  process.stdout.write(oneLine + '\n');
}

main();
