/**
 * Riftbound Online - Bot-vs-Bot Self-Play Harness (Phase 2B)
 *
 * Implements the policy spec at
 * /Users/miszion/workplace/nexus-data/research/riftbound-bots-spec.md.
 *
 * Two bots, BaselineBot (uniform random over legal actions) and HeuristicBot
 * (deterministic priority tiers), play full matches against each other
 * in-process against RiftboundGameEngine. A legality gate runs before every
 * dispatch; per-match JSONL event logs are emitted.
 *
 * CLI:
 *   npm run self-play -- --matches 10 --seed 42
 *   npm run test:selfplay -- --games=10 --strategyA=baseline --strategyB=heuristic
 *
 * Flags (all optional; defaults target acceptance §8):
 *   --matches=N           number of matches (alias: --games)
 *   --seed=S              base seed (default: 42)
 *   --strategyA=baseline|heuristic|random|aggro|control   bot for playerA
 *   --strategyB=baseline|heuristic|random|aggro|control   bot for playerB
 *   --turnLimit=100       hard turn cap per match
 *   --actionLimit=2000    hard action cap per match
 *   --emitJsonl=true      emit per-match JSONL logs
 *   --jsonlDir=PATH       directory for JSONL files
 *                         (default: /Users/miszion/workplace/nexus-data/riftbound-games)
 *   --quick               use synthetic fallback decks
 *   --quiet               suppress per-game stdout lines
 *   --report=PATH         summary JSON path
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
  PlayerDeckConfig,
  GameState
} from './game-engine';
import {
  getCardCatalog,
  EnrichedCardRecord
} from './card-catalog';

// ---------------------------------------------------------------------------
// Canonical BotAction union (spec §1.3)
// ---------------------------------------------------------------------------

type BotAction =
  | { kind: 'submit_initiative'; choice: 0 | 1 | 2 }
  | { kind: 'select_battlefield'; battlefieldId: string }
  | { kind: 'mulligan'; indices: number[] }
  | { kind: 'play_card'; cardIndex: number; destinationId: string | null; targets: string[] }
  | { kind: 'deploy_leader'; destinationId: string | null }
  | { kind: 'activate_legend' }
  | { kind: 'hide_card'; cardIndex: number; battlefieldId: string }
  | { kind: 'move_unit'; creatureInstanceId: string; destinationId: string }
  | { kind: 'commence_battle'; battlefieldId: string }
  | { kind: 'pass_priority' }
  | { kind: 'respond_chain'; pass: boolean }
  | { kind: 'resolve_prompt_discard'; promptId: string; instanceIds: string[] }
  | { kind: 'resolve_prompt_target'; promptId: string; selectionIds: string[] }
  | { kind: 'advance_phase' }
  | { kind: 'concede' };

type StrategyName = 'random' | 'aggro' | 'control' | 'baseline' | 'heuristic';

// ---------------------------------------------------------------------------
// Config + records
// ---------------------------------------------------------------------------

interface HarnessConfig {
  games: number;
  seed: number;
  seedProvided: boolean;
  turnLimit: number;
  actionLimit: number;
  strategyA: StrategyName;
  strategyB: StrategyName;
  quiet: boolean;
  quick: boolean;
  emitJsonl: boolean;
  jsonlDir: string;
  report: string;
}

interface Rng {
  next(): number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T | undefined;
}

interface GameRecord {
  gameId: string;
  seed: number;
  strategyA: StrategyName;
  strategyB: StrategyName;
  turns: number;
  status: 'completed' | 'crashed' | 'timeout' | 'invariant' | 'action_cap';
  winner: string | null;
  terminator: string;
  error?: string;
  errorStack?: string;
  violations: string[];
  flaggedLoop?: boolean;
  jsonlPath?: string;
  deviations?: string[];
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
    actionLimit: number;
    quick: boolean;
  };
  summary: {
    gamesCompleted: number;
    gamesCrashed: number;
    gamesTimedOut: number;
    gamesInvariant: number;
    gamesActionCap: number;
    avgTurns: number;
    winsA: number;
    winsB: number;
    draws: number;
    drawsByTurnCap: number;
  };
  violationsByType: Record<string, number>;
  topCrashes: CrashSample[];
  infiniteLoopCandidates: string[];
  matches: Array<{
    gameId: string;
    seed: number;
    winner: string | null;
    turns: number;
    status: GameRecord['status'];
    terminator: string;
    jsonlPath?: string;
  }>;
  deviations: string[];
  notes: string[];
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): HarnessConfig {
  const defaults: HarnessConfig = {
    games: 10,
    seed: 42,
    seedProvided: false,
    turnLimit: 100,
    actionLimit: 2000,
    strategyA: 'baseline',
    strategyB: 'heuristic',
    quiet: false,
    quick: false,
    emitJsonl: true,
    jsonlDir: '/Users/miszion/workplace/nexus-data/riftbound-games',
    report: '/Users/miszion/workplace/nexus-data/research/riftbound-selfplay-result.json'
  };

  // Support both "--key=value" and "--key value" (spec example uses spaces).
  const tokens: Array<[string, string]> = [];
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const body = raw.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      tokens.push([body.slice(0, eq), body.slice(eq + 1)]);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        tokens.push([body, next]);
        i++;
      } else {
        tokens.push([body, 'true']);
      }
    }
  }

  for (const [key, val] of tokens) {
    switch (key) {
      case 'matches':
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
      case 'actionLimit':
        defaults.actionLimit = Math.max(1, parseInt(val, 10) || defaults.actionLimit);
        break;
      case 'strategyA':
        defaults.strategyA = normalizeStrategy(val);
        break;
      case 'strategyB':
        defaults.strategyB = normalizeStrategy(val);
        break;
      case 'quick':
        defaults.quick = parseBool(val);
        break;
      case 'quiet':
        defaults.quiet = parseBool(val);
        break;
      case 'emitJsonl':
        defaults.emitJsonl = parseBool(val);
        break;
      case 'jsonlDir':
        defaults.jsonlDir = val;
        break;
      case 'report':
        defaults.report = val;
        break;
      default:
        break;
    }
  }
  return defaults;
}

function parseBool(v: string): boolean {
  return v === 'true' || v === '1' || v === '' || v === 'yes';
}

function normalizeStrategy(value: string): StrategyName {
  const v = value.toLowerCase();
  if (v === 'random' || v === 'aggro' || v === 'control' || v === 'baseline' || v === 'heuristic') {
    return v;
  }
  return 'baseline';
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) + fork helper (spec §2.3)
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

function forkRng(parentSeed: number, salt: number): Rng {
  return makeRng((parentSeed ^ salt) >>> 0);
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
// Deck construction
// ---------------------------------------------------------------------------

interface DeckAssembly {
  mainDeck: string[];
  runeDeck: RuneCard[];
  battlefields: Card[];
}

const DOMAIN_LIST: Domain[] = Object.values(Domain) as Domain[];

function pickPlayableCards(catalog: EnrichedCardRecord[]): EnrichedCardRecord[] {
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
      tags: r.tags && r.tags.length > 0 ? r.tags : ['Battlefield'],
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

function buildTestFallbackDeck(
  rng: Rng,
  size = 40
): { mainDeck: Card[]; runeDeck: RuneCard[]; battlefields: Card[] } {
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
      mainDeck: assembly.mainDeck as unknown as Card[],
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

// ---------------------------------------------------------------------------
// Engine helpers
// ---------------------------------------------------------------------------

function labelForPlayer(pid: string, p1: string, p2: string): 'P1' | 'P2' {
  if (pid === p1) return 'P1';
  if (pid === p2) return 'P2';
  return 'P1';
}

// ---------------------------------------------------------------------------
// Legal-action enumeration (spec §1)
// ---------------------------------------------------------------------------

/**
 * Resolve targets for a `play_card` action on a spell. Returns either:
 *   - { ok: true, targets } with a legal target list the engine will accept, or
 *   - { ok: false } signalling that the caller should SKIP this card (no legal
 *     targets exist, so playing it is guaranteed to be rejected — that was the
 *     `infinite_loop_suspected` bug).
 *
 * Non-spells and zero-target spells get `{ ok: true, targets: [] }`.
 */
function resolveSpellTargets(
  engine: RiftboundGameEngine,
  playerId: string,
  cardIndex: number,
  card: Card,
  player: PlayerState
): { ok: true; targets: string[] } | { ok: false } {
  const type = (card.type ?? '').toLowerCase();
  if (type !== 'spell') return { ok: true, targets: [] };
  try {
    const profile = engine.getSpellTargetingProfile(card);
    const min = profile?.minTargets ?? 0;
    const requiresSelection = profile?.requiresSelection ?? false;
    const scope = profile?.scope ?? 'none';

    // Some spells have operations like `deal_damage` / `remove_permanent` /
    // `stun` / `modify_stats` that REQUIRE a unit target at resolution time,
    // even though the catalog's `targeting.mode` says 'none' / 'self'
    // (regex-based classifier misses phrases like "stun an attacking unit").
    // Treat those as implicitly requiring one unit target.
    const ops = ((card as any).effectProfile?.operations ?? []) as Array<{
      type?: string;
      targetHint?: string;
    }>;
    const UNIT_TARGETING_OPS = new Set([
      'deal_damage',
      'remove_permanent',
      'modify_stats',
      'stun',
      'ready',
      'return_to_hand',
      'return_from_graveyard',
      'combat_bonus',
      'transform'
    ]);
    const opNeedsUnit = ops.some(
      (op) => op.type && UNIT_TARGETING_OPS.has(op.type) && op.targetHint !== 'self'
    );

    const needsTarget = min > 0 || requiresSelection || opNeedsUnit;
    if (!needsTarget) return { ok: true, targets: [] };
    const want = Math.max(min, 1);
    const cands = engine.getLegalTargets(playerId, cardIndex) ?? [];
    if (cands.length >= want) {
      return { ok: true, targets: cands.slice(0, want).map((c) => c.targetId) };
    }
    // Fallback for unit-targeting ops (deal_damage, stun, etc.) when the
    // catalog's targeting profile doesn't enumerate candidates — scan the
    // board directly. This covers misclassified cards (scope='none' with
    // hint='battlefield', scope='enemy_units' with minTargets=0, etc.) which
    // would otherwise throw "requires a unit target" at resolution time.
    if (opNeedsUnit) {
      const opponent = engine
        .getGameState()
        .players.find((p) => p.playerId !== playerId);
      const allUnits: string[] = [];
      // Prefer enemy first (most ops target enemies), then friendly.
      if (opponent) {
        for (const u of opponent.board.creatures) {
          const id = u.instanceId ?? u.id;
          if (id) allUnits.push(id);
        }
      }
      for (const u of player.board.creatures) {
        const id = u.instanceId ?? u.id;
        if (id) allUnits.push(id);
      }
      if (allUnits.length >= want) {
        return { ok: true, targets: allUnits.slice(0, want) };
      }
      // No units anywhere → can't cast this spell right now.
      return { ok: false };
    }
    // getLegalTargets returns [] for graveyard/deck/hand ("caller-managed
    // search"). Pull ids directly from the player's zones.
    const idsFromZone = (cards: readonly Card[], excludeIndex?: number): string[] =>
      cards
        .filter((_, j) => excludeIndex === undefined || j !== excludeIndex)
        .map((c) => (c as any).instanceId || c.id)
        .filter(Boolean) as string[];
    if (scope === 'graveyard') {
      const ids = idsFromZone(player.graveyard);
      if (ids.length >= want) return { ok: true, targets: ids.slice(0, want) };
      return min > 0 ? { ok: false } : { ok: true, targets: [] };
    }
    if (scope === 'deck') {
      const ids = idsFromZone(player.deck);
      if (ids.length >= want) return { ok: true, targets: ids.slice(0, want) };
      return min > 0 ? { ok: false } : { ok: true, targets: [] };
    }
    if (scope === 'hand') {
      const ids = idsFromZone(player.hand, cardIndex);
      if (ids.length >= want) return { ok: true, targets: ids.slice(0, want) };
      return min > 0 ? { ok: false } : { ok: true, targets: [] };
    }
    if (min > 0) return { ok: false };
    return { ok: true, targets: [] };
  } catch {
    // Predicate threw — skip so we don't propose a guaranteed-reject action.
    return { ok: false };
  }
}

function enumerateLegalActions(engine: RiftboundGameEngine, playerId: string): BotAction[] {
  const actions: BotAction[] = [];
  const status = engine.status;
  const state = engine.getGameState();
  const player = state.players.find((p) => p.playerId === playerId);
  if (!player) return actions;

  // Setup sub-phases (spec §1.1)
  if (status === GameStatus.COIN_FLIP) {
    const prompt = state.prompts.find(
      (p) => p.type === 'coin_flip' && p.playerId === playerId && !p.resolved
    );
    if (prompt) {
      for (const choice of [0, 1, 2] as const) {
        actions.push({ kind: 'submit_initiative', choice });
      }
    }
    return actions;
  }
  if (status === GameStatus.BATTLEFIELD_SELECTION) {
    const prompt = state.prompts.find(
      (p) => p.type === 'battlefield' && p.playerId === playerId && !p.resolved
    );
    if (prompt) {
      const data = prompt.data as { options?: Array<{ id?: string; battlefieldId?: string }> };
      for (const opt of data?.options ?? []) {
        const id = opt.id ?? opt.battlefieldId;
        if (id) actions.push({ kind: 'select_battlefield', battlefieldId: id });
      }
    }
    return actions;
  }
  if (status === GameStatus.MULLIGAN) {
    const prompt = state.prompts.find(
      (p) => p.type === 'mulligan' && p.playerId === playerId && !p.resolved
    );
    if (prompt) {
      actions.push({ kind: 'mulligan', indices: [] });
    }
    return actions;
  }
  if (status !== GameStatus.IN_PROGRESS) return actions;

  // Prompt-driven responses
  const discardPrompt = state.prompts.find(
    (p) => p.type === 'discard' && p.playerId === playerId && !p.resolved
  );
  if (discardPrompt) {
    const data = discardPrompt.data as { discardCount?: number };
    const want = Math.max(0, Math.min(player.hand.length, data?.discardCount ?? 1));
    const ids = player.hand
      .slice(0, want)
      .map((c) => (c as any).instanceId || c.id)
      .filter(Boolean) as string[];
    actions.push({
      kind: 'resolve_prompt_discard',
      promptId: discardPrompt.id,
      instanceIds: ids
    });
    return actions;
  }
  const targetPrompt = state.prompts.find(
    (p) => p.type === 'target' && p.playerId === playerId && !p.resolved
  );
  if (targetPrompt) {
    const data = targetPrompt.data as {
      candidates?: Array<{ id?: string; targetId?: string }>;
      minTargets?: number;
    };
    const want = Math.max(0, data?.minTargets ?? 1);
    const ids = (data?.candidates ?? [])
      .map((c) => c.id ?? c.targetId)
      .filter(Boolean)
      .slice(0, want) as string[];
    actions.push({
      kind: 'resolve_prompt_target',
      promptId: targetPrompt.id,
      selectionIds: ids
    });
    return actions;
  }

  // Reaction / priority windows
  const rx = engine.needsReaction(playerId);
  const chain = state.reactionChain;
  if (rx.required && rx.windowType === 'trigger') {
    actions.push({ kind: 'respond_chain', pass: true });
    for (let i = 0; i < player.hand.length; i++) {
      if (!engine.canPlayCard(playerId, i).ok) continue;
      const card = player.hand[i];
      const resolved = resolveSpellTargets(engine, playerId, i, card, player);
      if (!resolved.ok) continue;
      actions.push({
        kind: 'play_card',
        cardIndex: i,
        destinationId: null,
        targets: resolved.targets
      });
    }
    return actions;
  }
  if (rx.required && rx.windowType === 'combat') {
    actions.push({ kind: 'pass_priority' });
    for (let i = 0; i < player.hand.length; i++) {
      if (!engine.canPlayCard(playerId, i).ok) continue;
      const card = player.hand[i];
      const resolved = resolveSpellTargets(engine, playerId, i, card, player);
      if (!resolved.ok) continue;
      actions.push({
        kind: 'play_card',
        cardIndex: i,
        destinationId: null,
        targets: resolved.targets
      });
    }
    return actions;
  }
  if (rx.required && rx.windowType === 'priority') {
    actions.push({ kind: 'pass_priority' });
    // fall through to main actions below
  }
  if (chain && chain.currentReactorId === playerId && chain.awaitingResponse) {
    actions.push({ kind: 'respond_chain', pass: true });
  }

  // Own-turn main actions
  const current = engine.getCurrentPlayerState();
  if (current.playerId !== playerId) {
    return actions; // opponent's turn, no priority window for me
  }
  const phase = engine.currentPhase;

  // advance_phase is always legal fallback on own turn (engine no-ops if blocked)
  actions.push({ kind: 'advance_phase' });

  if (phase === GamePhase.MAIN_1 || phase === GamePhase.MAIN_2) {
    // play_card for each hand card that passes canPlayCard
    for (let i = 0; i < player.hand.length; i++) {
      const res = engine.canPlayCard(playerId, i);
      if (!res.ok) continue;
      const card = player.hand[i];
      const type = (card.type ?? '').toLowerCase();
      if (type === 'spell') {
        const resolved = resolveSpellTargets(engine, playerId, i, card, player);
        if (!resolved.ok) continue;
        actions.push({
          kind: 'play_card',
          cardIndex: i,
          destinationId: null,
          targets: resolved.targets
        });
      } else {
        // Permanent: emit base deploy + per-owned-battlefield deploy
        actions.push({
          kind: 'play_card',
          cardIndex: i,
          destinationId: 'base',
          targets: []
        });
        const ownedBattlefields = state.battlefields.filter(
          (bf) => bf.controller === playerId
        );
        for (const bf of ownedBattlefields) {
          actions.push({
            kind: 'play_card',
            cardIndex: i,
            destinationId: bf.battlefieldId,
            targets: []
          });
        }
      }
    }

    // deploy_leader (uses new predicate)
    const leaderRes = engine.canDeployChampionLeader(playerId);
    if (leaderRes.ok) {
      actions.push({ kind: 'deploy_leader', destinationId: 'base' });
      for (const bf of state.battlefields) {
        if (bf.controller === playerId) {
          actions.push({ kind: 'deploy_leader', destinationId: bf.battlefieldId });
        }
      }
    }

    // activate_legend
    const legend = player.championLegend;
    if (legend && (legend as any).canActivate === true) {
      actions.push({ kind: 'activate_legend' });
    }
  }

  // move_unit during MAIN_1 / COMBAT. Skip destinations where the unit
  // already lives — the engine rejects "move to same location" which would
  // otherwise make the legality gate disagree with engine behaviour.
  if (phase === GamePhase.MAIN_1 || phase === GamePhase.COMBAT) {
    for (const creature of player.board.creatures) {
      if (creature.isTapped) continue;
      if ((creature as any).summoned) continue;
      const curZone = (creature.location as any)?.zone;
      const curBf = (creature.location as any)?.battlefieldId ?? null;
      for (const bf of state.battlefields) {
        if (curZone === 'battlefield' && curBf === bf.battlefieldId) continue;
        actions.push({
          kind: 'move_unit',
          creatureInstanceId: creature.instanceId,
          destinationId: bf.battlefieldId
        });
      }
      if (curZone === 'battlefield') {
        actions.push({
          kind: 'move_unit',
          creatureInstanceId: creature.instanceId,
          destinationId: 'base'
        });
      }
    }
  }

  // commence_battle during COMBAT
  if (phase === GamePhase.COMBAT) {
    for (const bf of state.battlefields) {
      const hasMyUnit = player.board.creatures.some(
        (c) =>
          c.location && (c.location as any).zone === 'battlefield' &&
          (c.location as any).battlefieldId === bf.battlefieldId
      );
      if (hasMyUnit) {
        actions.push({ kind: 'commence_battle', battlefieldId: bf.battlefieldId });
      }
    }
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Legality gate (spec §4.1)
// ---------------------------------------------------------------------------

function actionIsLegal(
  engine: RiftboundGameEngine,
  playerId: string,
  action: BotAction
): boolean {
  const legal = enumerateLegalActions(engine, playerId);
  if (legal.length === 0) return false;
  return legal.some((l) => actionsEqual(l, action));
}

function actionsEqual(a: BotAction, b: BotAction): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'submit_initiative':
      return (b as typeof a).choice === a.choice;
    case 'select_battlefield':
      return (b as typeof a).battlefieldId === a.battlefieldId;
    case 'mulligan': {
      const bb = b as typeof a;
      return (
        bb.indices.length === a.indices.length &&
        bb.indices.every((v, i) => v === a.indices[i])
      );
    }
    case 'play_card': {
      const bb = b as typeof a;
      return (
        bb.cardIndex === a.cardIndex &&
        bb.destinationId === a.destinationId &&
        bb.targets.length === a.targets.length &&
        bb.targets.every((v, i) => v === a.targets[i])
      );
    }
    case 'deploy_leader':
      return (b as typeof a).destinationId === a.destinationId;
    case 'activate_legend':
      return true;
    case 'hide_card': {
      const bb = b as typeof a;
      return bb.cardIndex === a.cardIndex && bb.battlefieldId === a.battlefieldId;
    }
    case 'move_unit': {
      const bb = b as typeof a;
      return (
        bb.creatureInstanceId === a.creatureInstanceId &&
        bb.destinationId === a.destinationId
      );
    }
    case 'commence_battle':
      return (b as typeof a).battlefieldId === a.battlefieldId;
    case 'pass_priority':
    case 'respond_chain':
    case 'advance_phase':
    case 'concede':
      return true;
    case 'resolve_prompt_discard': {
      const bb = b as typeof a;
      return (
        bb.promptId === a.promptId &&
        bb.instanceIds.length === a.instanceIds.length &&
        bb.instanceIds.every((v, i) => v === a.instanceIds[i])
      );
    }
    case 'resolve_prompt_target': {
      const bb = b as typeof a;
      return (
        bb.promptId === a.promptId &&
        bb.selectionIds.length === a.selectionIds.length &&
        bb.selectionIds.every((v, i) => v === a.selectionIds[i])
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Action dispatch
// ---------------------------------------------------------------------------

function dispatchAction(
  engine: RiftboundGameEngine,
  playerId: string,
  action: BotAction
): void {
  switch (action.kind) {
    case 'submit_initiative':
      engine.submitInitiativeChoice(playerId, action.choice);
      return;
    case 'select_battlefield':
      engine.selectBattlefield(playerId, action.battlefieldId);
      return;
    case 'mulligan':
      engine.submitMulligan(playerId, action.indices);
      return;
    case 'resolve_prompt_discard':
      engine.submitDiscardSelection(playerId, action.promptId, action.instanceIds);
      return;
    case 'resolve_prompt_target':
      engine.submitTargetSelection(playerId, action.promptId, action.selectionIds);
      return;
    case 'play_card':
      engine.playCard(
        playerId,
        action.cardIndex,
        action.targets ?? [],
        action.destinationId ?? null
      );
      return;
    case 'deploy_leader':
      engine.deployChampionLeader(playerId, action.destinationId ?? null);
      return;
    case 'activate_legend':
      engine.activateChampionAbility(playerId, 'legend');
      return;
    case 'hide_card':
      engine.hideCard(playerId, action.cardIndex, action.battlefieldId);
      return;
    case 'move_unit':
      engine.moveUnit(playerId, action.creatureInstanceId, action.destinationId);
      return;
    case 'commence_battle':
      engine.commenceBattle(playerId, action.battlefieldId);
      return;
    case 'pass_priority':
      engine.passPriority(playerId);
      return;
    case 'respond_chain':
      engine.respondToChainReaction(playerId, action.pass);
      return;
    case 'advance_phase':
      engine.proceedToNextPhase();
      return;
    case 'concede':
      engine.concedeMatch(playerId);
      return;
  }
}

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

type Bot = (engine: RiftboundGameEngine, playerId: string, rng: Rng) => BotAction | null;

const baselineBot: Bot = (engine, playerId, rng) => {
  const actions = enumerateLegalActions(engine, playerId);
  if (actions.length === 0) return null;
  // Drop concede (spec §2.1 step 2). Our enumerator never emits it anyway.
  const choices = actions.filter((a) => a.kind !== 'concede');
  if (choices.length === 0) return { kind: 'advance_phase' };
  return rng.pick(choices) ?? null;
};

const heuristicBot: Bot = (engine, playerId, rng) => {
  const actions = enumerateLegalActions(engine, playerId);
  if (actions.length === 0) return null;

  const state = engine.getGameState();
  const player = state.players.find((p) => p.playerId === playerId);
  if (!player) return rng.pick(actions) ?? null;

  // Tier 0: prompt resolution (discard / target) — our enumerator returns only
  // that action if a prompt is open for this player, so any discard/target
  // action short-circuits here.
  const promptAction =
    actions.find((a) => a.kind === 'resolve_prompt_discard') ??
    actions.find((a) => a.kind === 'resolve_prompt_target');
  if (promptAction) return promptAction;

  // Setup-phase choices
  const init = actions.find((a) => a.kind === 'submit_initiative');
  if (init) return { kind: 'submit_initiative', choice: 0 };
  const bf = actions.find((a) => a.kind === 'select_battlefield');
  if (bf) return bf;
  const mull = actions.find((a) => a.kind === 'mulligan');
  if (mull) return { kind: 'mulligan', indices: [] };

  // Reaction window: if any respond_chain exists, pass immediately — prevents
  // reaction-chain deadlocks (Bug #1 in the selfplay report). Never fire off
  // own spells in reaction windows; they rarely help and often create a new
  // prompt we can't resolve.
  const respond = actions.find((a) => a.kind === 'respond_chain');
  if (respond) return { kind: 'respond_chain', pass: true };

  // If the ONLY progress action is advance_phase (plus maybe a pass), take it.
  // Don't spin in main_1 pass-looping.
  const nonAdvance = actions.filter(
    (a) => a.kind !== 'advance_phase' && a.kind !== 'pass_priority'
  );
  if (nonAdvance.length === 0) {
    const adv0 = actions.find((a) => a.kind === 'advance_phase');
    if (adv0) return adv0;
    const passOnly = actions.find((a) => a.kind === 'pass_priority');
    if (passOnly) return passOnly;
  }

  // Tier 1: commence battle — THIS is the VP engine. Any legal commence_battle
  // (favourable or not) is a higher-EV move than stockpiling: if we don't
  // commence, we never gain VP. Prefer favourable matchups, but still fire
  // if we have any presence at a battlefield.
  const commence = actions.filter((a) => a.kind === 'commence_battle');
  if (commence.length > 0) {
    for (const a of commence) {
      if (a.kind !== 'commence_battle') continue;
      if (isFavorableBattlefield(state, playerId, a.battlefieldId)) return a;
    }
    // Even an unfavourable showdown beats passing forever — we have units
    // there and we may still trade or draw bonuses. Fire the first one.
    return commence[0];
  }

  // Tier 2: deploy leader champion — aim at a battlefield for contest
  const deploy = actions.filter((a) => a.kind === 'deploy_leader');
  if (deploy.length > 0) {
    const battlefieldDeploy = deploy.find(
      (a) => (a as any).destinationId && (a as any).destinationId !== 'base'
    );
    return battlefieldDeploy ?? deploy[0];
  }

  // Tier 3: deploy creatures directly to battlefields — battlefield presence
  // is the only path to contest.
  const creaturePlays = actions.filter((a) => {
    if (a.kind !== 'play_card') return false;
    const c = player.hand[a.cardIndex];
    return c && (c.type ?? '').toLowerCase() === 'creature';
  });
  if (creaturePlays.length > 0) {
    // Strongly prefer direct-to-battlefield deployments over 'base'
    const directToBf = creaturePlays.filter(
      (a) => a.kind === 'play_card' && a.destinationId && a.destinationId !== 'base'
    );
    if (directToBf.length > 0) {
      const ranked = rankPermanentPlays(directToBf, player, state);
      if (ranked.length > 0) return ranked[0];
    }
    const ranked = rankPermanentPlays(creaturePlays, player, state);
    if (ranked.length > 0) return ranked[0];
  }

  // Tier 4: move own unit onto an uncontested battlefield — sets up a claim
  const moveToBf = actions.filter(
    (a) => a.kind === 'move_unit' && a.destinationId !== 'base'
  );
  if (moveToBf.length > 0) {
    const uncontrolled = moveToBf.find(
      (a) =>
        a.kind === 'move_unit' &&
        state.battlefields.find((bf2) => bf2.battlefieldId === a.destinationId)?.controller == null
    );
    return uncontrolled ?? moveToBf[0];
  }

  // Tier 4.5: if we already have creatures on a battlefield but we're in
  // MAIN_1, advance toward COMBAT instead of pass_priority looping.
  const phase = engine.currentPhase;
  const ownUnitsOnBf = player.board.creatures.some(
    (c) => c.location && (c.location as any).zone === 'battlefield'
  );
  if (phase === GamePhase.MAIN_1 && ownUnitsOnBf) {
    const adv = actions.find((a) => a.kind === 'advance_phase');
    if (adv) return adv;
  }

  // Tier 5: legend
  const legend = actions.find((a) => a.kind === 'activate_legend');
  if (legend) return legend;

  // Tier 6: non-creature permanents
  const permPlays = actions.filter((a) => {
    if (a.kind !== 'play_card') return false;
    const c = player.hand[a.cardIndex];
    const t = (c?.type ?? '').toLowerCase();
    return t === 'artifact' || t === 'enchantment';
  });
  if (permPlays.length > 0) {
    const ranked = rankPermanentPlays(permPlays, player, state);
    if (ranked.length > 0) return ranked[0];
  }

  // Tier 7: spells — skip if spell targeting is risky (no candidates). The
  // enumerator already filters for resolvable targets, so remaining spells
  // should be safe, but cap spell fires so we don't cycle through losers.
  const spellPlays = actions.filter((a) => {
    if (a.kind !== 'play_card') return false;
    const c = player.hand[a.cardIndex];
    return c && (c.type ?? '').toLowerCase() === 'spell';
  });
  if (spellPlays.length > 0 && phase !== GamePhase.MAIN_2) {
    return spellPlays[0];
  }

  // Tier 8: advance phase — progress the turn, don't loiter in main_1.
  const adv = actions.find((a) => a.kind === 'advance_phase');
  if (adv) return adv;

  // Tier 9: pass priority (last resort)
  const pass = actions.find((a) => a.kind === 'pass_priority');
  if (pass) return pass;

  // Fallback
  return rng.pick(actions) ?? null;
};

function isFavorableBattlefield(
  state: GameState,
  playerId: string,
  battlefieldId: string
): boolean {
  const other = state.players.find((p) => p.playerId !== playerId);
  const me = state.players.find((p) => p.playerId === playerId);
  if (!me) return false;
  let myMight = 0;
  for (const c of me.board.creatures) {
    if (c.location && (c.location as any).zone === 'battlefield' &&
        (c.location as any).battlefieldId === battlefieldId) {
      myMight += (c as any).power ?? 0;
    }
  }
  let enemyMight = 0;
  if (other) {
    for (const c of other.board.creatures) {
      if (c.location && (c.location as any).zone === 'battlefield' &&
          (c.location as any).battlefieldId === battlefieldId) {
        enemyMight += (c as any).power ?? 0;
      }
    }
  }
  const bf = state.battlefields.find((b) => b.battlefieldId === battlefieldId);
  if (!bf?.controller && myMight >= 1) return true;
  return myMight >= enemyMight + 1;
}

function rankPermanentPlays(
  actions: BotAction[],
  player: PlayerState,
  state: GameState
): BotAction[] {
  const scored = actions.map((a) => {
    if (a.kind !== 'play_card') return { a, score: -1 };
    const c = player.hand[a.cardIndex];
    const power = (c as any)?.power ?? 0;
    const tough = (c as any)?.toughness ?? 0;
    const cost = (c?.energyCost ?? c?.manaCost ?? 0) as number;
    let score = power + tough - cost * 0.1;
    // Prefer battlefield deploys with enemy presence
    const destId = a.destinationId;
    if (destId && destId !== 'base') {
      const bf = state.battlefields.find((b) => b.battlefieldId === destId);
      if (bf) {
        const enemyPresent = state.players.some(
          (p) => p.playerId !== player.playerId &&
            p.board.creatures.some(
              (cc) => cc.location && (cc.location as any).zone === 'battlefield' &&
                      (cc.location as any).battlefieldId === destId
            )
        );
        if (enemyPresent) score += 1;
      }
    }
    return { a, score };
  });
  scored.sort((x, y) => y.score - x.score);
  return scored.map((s) => s.a);
}

function getBot(name: StrategyName): Bot {
  switch (name) {
    case 'heuristic':
    case 'aggro':
    case 'control':
      return heuristicBot;
    case 'random':
    case 'baseline':
    default:
      return baselineBot;
  }
}

// ---------------------------------------------------------------------------
// Commentary generator (spec §6). Pure, deterministic.
// ---------------------------------------------------------------------------

interface EventLogLine {
  matchId: string;
  gameIndex: number;
  seed: number;
  eventIndex: number;
  timestamp: string;
  turn: number;
  phase: string;
  activePlayer: 'P1' | 'P2';
  actor: 'P1' | 'P2' | 'system';
  action: BotAction | null;
  cardPlayed?: {
    id: string;
    name: string;
    type: string;
    energyCost?: number;
    domain?: string;
    power?: number;
    toughness?: number;
    text?: string;
  } | null;
  target?: string | string[] | null;
  stateDelta?: Record<string, unknown>;
  vp: { P1: number; P2: number };
  hp: { P1: number; P2: number };
  mana: { P1: number; P2: number };
  priorityHolder?: 'P1' | 'P2' | null;
  windowType?: 'main' | 'reaction' | 'combat' | null;
  result?: 'P1_wins' | 'P2_wins' | 'draw';
  winReason?: string;
  terminal?: {
    winner: 'P1' | 'P2' | null;
    loser: 'P1' | 'P2' | null;
    reason: string;
    turns: number;
    totalEvents: number;
    violations: string[];
    durationMs: number;
  };
}

function htmlEscape(s: string | undefined): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function describeAction(event: EventLogLine): string {
  const actor = event.actor;
  const a = event.action;
  const name = (id: string | null | undefined): string => {
    if (!id) return 'base';
    const card = event.cardPlayed;
    if (card && card.id === id) return htmlEscape(card.name);
    return htmlEscape(String(id));
  };
  if (event.terminal) {
    return `${event.terminal.winner ?? 'No one'} wins by ${event.terminal.reason} on turn ${event.terminal.turns}.`;
  }
  if (!a) {
    if (actor === 'system') {
      return `Turn ${event.turn} — ${event.activePlayer} begins.`;
    }
    return '';
  }
  switch (a.kind) {
    case 'submit_initiative': {
      const pick = ['Blade', 'Shield', 'Ring'][a.choice];
      return `${actor} picks Doran's ${pick}.`;
    }
    case 'select_battlefield':
      return `${actor} drafts the ${name(a.battlefieldId)} battlefield.`;
    case 'mulligan':
      return a.indices.length === 0
        ? `${actor} keeps hand.`
        : `${actor} mulligans ${a.indices.length} card(s).`;
    case 'play_card': {
      const card = event.cardPlayed;
      if (!card) return `${actor} plays a card.`;
      if ((card.type ?? '').toLowerCase() === 'spell') {
        if (a.targets.length > 0) {
          return `${actor} casts ${htmlEscape(card.name)} [${card.energyCost ?? 0}] targeting ${a.targets.map((t) => htmlEscape(t)).join(', ')}.`;
        }
        return `${actor} casts ${htmlEscape(card.name)} [${card.energyCost ?? 0}].`;
      }
      const dest = a.destinationId ?? 'base';
      return `${actor} plays ${htmlEscape(card.name)} [${card.energyCost ?? 0}] to ${htmlEscape(dest)}.`;
    }
    case 'deploy_leader':
      return `${actor} deploys their chosen champion to ${htmlEscape(a.destinationId ?? 'base')}.`;
    case 'activate_legend':
      return `${actor} activates their legend ability.`;
    case 'hide_card':
      return `${actor} hides a card on ${htmlEscape(a.battlefieldId)}.`;
    case 'move_unit':
      return a.destinationId === 'base'
        ? `${actor} recalls a unit to base.`
        : `${actor} moves a unit to ${htmlEscape(a.destinationId)}.`;
    case 'commence_battle':
      return `${actor} commences showdown at ${htmlEscape(a.battlefieldId)}.`;
    case 'pass_priority':
      return `${actor} passes priority.`;
    case 'respond_chain':
      return `${actor} passes on the reaction chain.`;
    case 'resolve_prompt_discard':
      return `${actor} discards ${a.instanceIds.length} card(s).`;
    case 'resolve_prompt_target':
      return `${actor} selects ${a.selectionIds.length} target(s).`;
    case 'advance_phase':
      return `${actor} advances phase.`;
    case 'concede':
      return `${actor} concedes.`;
  }
}

// ---------------------------------------------------------------------------
// Event-log serializer (spec §5)
// ---------------------------------------------------------------------------

interface LogSink {
  write(event: EventLogLine): void;
  close(): void;
  path: string | null;
  events: EventLogLine[];
}

function makeLogSink(filePath: string | null): LogSink {
  const events: EventLogLine[] = [];
  let handle: number | null = null;
  if (filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    handle = fs.openSync(filePath, 'w');
  }
  return {
    path: filePath,
    events,
    write(event: EventLogLine): void {
      events.push(event);
      if (handle !== null) {
        fs.writeSync(handle, JSON.stringify(event) + '\n');
      }
    },
    close(): void {
      if (handle !== null) {
        fs.closeSync(handle);
        handle = null;
      }
    }
  };
}

function phaseLabel(phase: GamePhase): string {
  return String(phase).toLowerCase();
}

function windowTypeFor(state: GameState): 'main' | 'reaction' | 'combat' | null {
  const pw = state.priorityWindow;
  if (!pw) return null;
  if (pw.type === 'combat' || (pw as any).type === 'showdown') return 'combat';
  if (pw.type === 'reaction') return 'reaction';
  return 'main';
}

function snapshotState(
  engine: RiftboundGameEngine,
  p1: string,
  p2: string
): {
  vp: { P1: number; P2: number };
  hp: { P1: number; P2: number };
  mana: { P1: number; P2: number };
  stateDelta: Record<string, unknown>;
  priorityHolder: 'P1' | 'P2' | null;
  windowType: 'main' | 'reaction' | 'combat' | null;
} {
  const state = engine.getGameState();
  const pa = state.players.find((p) => p.playerId === p1);
  const pb = state.players.find((p) => p.playerId === p2);
  const untapped = (p?: PlayerState): number =>
    p?.channeledRunes?.filter((r) => !r.isTapped).length ?? 0;
  const vp = { P1: pa?.victoryPoints ?? 0, P2: pb?.victoryPoints ?? 0 };
  const hp = { P1: pa?.victoryPoints ?? 0, P2: pb?.victoryPoints ?? 0 };
  const mana = { P1: untapped(pa), P2: untapped(pb) };
  const stateDelta = {
    handSizeP1: pa?.hand.length ?? 0,
    handSizeP2: pb?.hand.length ?? 0,
    deckSizeP1: pa?.deck.length ?? 0,
    deckSizeP2: pb?.deck.length ?? 0,
    boardCountP1: pa?.board.creatures.length ?? 0,
    boardCountP2: pb?.board.creatures.length ?? 0,
    graveyardCountP1: pa?.graveyard.length ?? 0,
    graveyardCountP2: pb?.graveyard.length ?? 0,
    battlefields: state.battlefields.map((bf) => ({
      id: bf.battlefieldId,
      controller: bf.controller ?? null,
      contestedBy: (bf as any).contestedBy ?? []
    }))
  };
  const holder = state.priorityWindow?.holder ?? null;
  const priorityHolder: 'P1' | 'P2' | null =
    holder === p1 ? 'P1' : holder === p2 ? 'P2' : null;
  return {
    vp,
    hp,
    mana,
    stateDelta,
    priorityHolder,
    windowType: windowTypeFor(state)
  };
}

function buildCardPlayed(
  action: BotAction,
  player: PlayerState | undefined
): EventLogLine['cardPlayed'] {
  if (action.kind !== 'play_card' && action.kind !== 'hide_card') return null;
  if (!player) return null;
  const idx = (action as any).cardIndex as number;
  const card = player.hand[idx];
  if (!card) return null;
  return {
    id: card.id,
    name: card.name,
    type: (card.type ?? '').toLowerCase(),
    energyCost: (card.energyCost ?? card.manaCost ?? 0) as number,
    domain: (card as any).domain,
    power: (card as any).power,
    toughness: (card as any).toughness,
    text: card.text
  };
}

// ---------------------------------------------------------------------------
// Invariant checks (re-used from the previous harness)
// ---------------------------------------------------------------------------

function assertInvariants(
  engine: RiftboundGameEngine,
  turnNumber: number,
  turnLimit: number,
  violations: string[]
): void {
  const state = engine.getGameState();
  if (turnNumber > turnLimit) {
    violations.push('turn_limit_exceeded');
    throw new Error(`Turn count ${turnNumber} exceeded limit ${turnLimit}`);
  }
  for (const player of state.players) {
    if ((player.resources?.energy ?? 0) < 0) {
      violations.push('negative_energy');
      throw new Error(`Negative energy on ${player.playerId}`);
    }
    if (player.victoryPoints < 0) {
      violations.push('negative_vp');
      throw new Error(`Negative VP on ${player.playerId}`);
    }
    if (player.hand.length > 50) {
      violations.push('hand_too_large');
      throw new Error(`Hand size ${player.hand.length} too large`);
    }
    const zoneIds = new Map<string, string>();
    const register = (zone: string, id: string | undefined): void => {
      if (!id) return;
      const prior = zoneIds.get(id);
      if (prior && prior !== zone) {
        violations.push('zone_overlap');
        throw new Error(`Card ${id} in both ${prior} and ${zone}`);
      }
      zoneIds.set(id, zone);
    };
    for (const c of player.hand) register('hand', (c as any).instanceId ?? c.id);
    for (const c of player.deck) register('deck', (c as any).instanceId ?? c.id);
    for (const c of player.graveyard) register('graveyard', (c as any).instanceId ?? c.id);
    for (const c of player.exile) register('exile', (c as any).instanceId ?? c.id);
    for (const c of player.board.creatures) register('board_creatures', c.instanceId ?? c.id);
    for (const c of player.board.artifacts) register('board_artifacts', (c as any).instanceId ?? c.id);
    for (const c of player.board.enchantments) register('board_enchantments', (c as any).instanceId ?? c.id);
  }
  const winnerSet = Boolean(state.winner);
  const statusEnded =
    state.status === GameStatus.WINNER_DETERMINED || state.status === GameStatus.COMPLETED;
  if (winnerSet && !statusEnded) {
    violations.push('silent_win');
    throw new Error(`Winner set but status ${state.status}`);
  }
  for (const p of state.players) {
    if (p.victoryPoints >= p.victoryScore && !statusEnded) {
      violations.push('vp_threshold_without_end');
      throw new Error(`${p.playerId} hit VP threshold without end`);
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

function formatTimestampForFilename(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    date.getUTCFullYear().toString() +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    '-' +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds())
  );
}

function playOneGame(
  gameIndex: number,
  cfg: HarnessConfig,
  baseSeed: number,
  playable: EnrichedCardRecord[] | null,
  battlefieldRecords: EnrichedCardRecord[] | null,
  log: (msg: string) => void
): RunResult {
  const p1 = 'playerA';
  const p2 = 'playerB';
  const seed = (baseSeed + gameIndex * 2654435761) >>> 0;
  const deckRng = makeRng(seed);
  const botRngA = forkRng(seed, 0xa1a1a1a1);
  const botRngB = forkRng(seed, 0xb2b2b2b2);
  const pickRng = (pid: string): Rng => (pid === p1 ? botRngA : botRngB);

  const gameId = `selfplay-${gameIndex}-${seed}`;
  const startedAt = new Date();
  const tsTag = formatTimestampForFilename(startedAt);
  const jsonlPath = cfg.emitJsonl
    ? path.join(cfg.jsonlDir, `match-${tsTag}-${seed}.jsonl`)
    : null;

  const deviations: string[] = [];
  const record: GameRecord = {
    gameId,
    seed,
    strategyA: cfg.strategyA,
    strategyB: cfg.strategyB,
    turns: 0,
    status: 'completed',
    winner: null,
    terminator: 'unknown',
    violations: [],
    jsonlPath: jsonlPath ?? undefined,
    deviations
  };

  const sink = makeLogSink(jsonlPath);
  let eventIndex = 0;
  const emit = (
    engine: RiftboundGameEngine,
    actor: 'P1' | 'P2' | 'system',
    action: BotAction | null,
    extras: Partial<EventLogLine> = {}
  ): void => {
    const state = engine.getGameState();
    const cur = state.players[state.currentPlayerIndex];
    const snap = snapshotState(engine, p1, p2);
    const activePlayer = labelForPlayer(cur?.playerId ?? p1, p1, p2);
    const line: EventLogLine = {
      matchId: gameId,
      gameIndex,
      seed,
      eventIndex: eventIndex++,
      timestamp: new Date().toISOString(),
      turn: engine.turnNumber,
      phase: phaseLabel(engine.currentPhase),
      activePlayer,
      actor,
      action,
      vp: snap.vp,
      hp: snap.hp,
      mana: snap.mana,
      stateDelta: snap.stateDelta,
      priorityHolder: snap.priorityHolder,
      windowType: snap.windowType,
      ...extras
    };
    sink.write(line);
  };

  let engine: RiftboundGameEngine;
  try {
    engine = new RiftboundGameEngine(gameId, [p1, p2]);
    const deckA = buildDeckConfigForGame(deckRng, gameIndex, playable, battlefieldRecords, cfg.quick);
    const deckB = buildDeckConfigForGame(deckRng, gameIndex + 1, playable, battlefieldRecords, cfg.quick);
    engine.initializeGame({ [p1]: deckA, [p2]: deckB });
  } catch (err) {
    const e = err as Error;
    record.status = 'crashed';
    record.terminator = 'crashed';
    record.error = e.message;
    record.errorStack = e.stack;
    sink.close();
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

  // Drive through setup (coin flip / battlefield / mulligan) via bots themselves.
  let setupGuard = 0;
  while (
    setupGuard++ < 200 &&
    engine.status !== GameStatus.IN_PROGRESS &&
    engine.status !== GameStatus.WINNER_DETERMINED &&
    engine.status !== GameStatus.COMPLETED
  ) {
    let madeProgress = false;
    for (const pid of [p1, p2]) {
      const legals = enumerateLegalActions(engine, pid);
      if (legals.length === 0) continue;
      const bot = getBot(pid === p1 ? cfg.strategyA : cfg.strategyB);
      const action = bot(engine, pid, pickRng(pid));
      if (!action) continue;
      if (!actionIsLegal(engine, pid, action)) {
        record.violations.push('bot_illegal_action');
        break;
      }
      try {
        dispatchAction(engine, pid, action);
        madeProgress = true;
      } catch {
        // ignore — setup races sometimes have both players prompted; engine
        // will reject stale ones.
      }
    }
    if (!madeProgress) break;
  }

  // Coin-flip tie fallback (spec §1.1): force choice 0 for both
  if (engine.status === GameStatus.COIN_FLIP) {
    for (const pid of [p1, p2]) {
      try {
        engine.submitInitiativeChoice(pid, 0);
      } catch {
        /* noop */
      }
    }
  }

  if (engine.status !== GameStatus.IN_PROGRESS) {
    record.status = 'crashed';
    record.terminator = 'setup_failed';
    record.error = `setup did not reach IN_PROGRESS (status=${engine.status})`;
    sink.close();
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

  // Game loop
  let lastActionSig = '';
  let sameSigStreak = 0;
  let iterationsWithoutTurnAdvance = 0;
  let lastTurn = engine.turnNumber;
  let actionCount = 0;
  // Defense-in-depth: if the same actor proposes the same rejected action
  // repeatedly (e.g. a targeting bug slips past the legality gate), force an
  // advance_phase to break out. Primary fix is in the bot, this is a guard.
  let lastRejectSig = '';
  let rejectStreak = 0;
  // Target-prompt loop-breaker: some spells re-defer their prompt (new promptId
  // each time) when targets resolve to []. Detect and break out.
  let emptyTargetStreak = 0;
  const HARD_TURN_CAP = Math.min(60, cfg.turnLimit);

  try {
    while (engine.status === GameStatus.IN_PROGRESS) {
      record.turns = engine.turnNumber;
      assertInvariants(engine, engine.turnNumber, HARD_TURN_CAP + 1, record.violations);

      if (engine.turnNumber > HARD_TURN_CAP) {
        record.status = 'timeout';
        record.terminator = 'turn_cap';
        break;
      }
      if (actionCount >= cfg.actionLimit) {
        record.status = 'action_cap';
        record.terminator = 'action_cap';
        break;
      }

      const state = engine.getGameState();
      const priorityHolder = state.priorityWindow?.holder ?? null;
      const chainReactor = state.reactionChain?.currentReactorId ?? null;
      const actorId =
        chainReactor ?? priorityHolder ?? engine.getCurrentPlayerState().playerId;
      const bot = getBot(actorId === p1 ? cfg.strategyA : cfg.strategyB);
      const rng = pickRng(actorId);

      let action = bot(engine, actorId, rng) ?? { kind: 'advance_phase' };

      // Target-prompt loop-breaker: if the bot is resolving a target prompt
      // with an empty selection list, count consecutive occurrences. After 4
      // in a row (typically the spell keeps re-deferring a new promptId), try
      // to unstick the game by draining the prompts directly on the engine
      // and forcing a phase advance on the current player.
      if (action.kind === 'resolve_prompt_target' && action.selectionIds.length === 0) {
        emptyTargetStreak++;
        if (emptyTargetStreak >= 4) {
          if (!cfg.quiet) log(`[${gameId}] empty-target loop broken: draining prompts`);
          // Mark all of this player's open target prompts as resolved so we
          // can exit the loop. Also clear corresponding pendingEffects.
          try {
            const gs = engine.getGameState();
            const openPrompts = gs.prompts.filter(
              (p) => !p.resolved && p.type === 'target' && p.playerId === actorId
            );
            for (const p of openPrompts) {
              (p as any).resolved = true;
            }
            gs.pendingEffects = gs.pendingEffects.filter(
              (e) => !(e.type === 'target' && e.targetPlayerId === actorId)
            );
          } catch {
            /* noop */
          }
          // Emit a system note for the loop-break
          emit(engine, 'system', null, {});
          emptyTargetStreak = 0;
          continue;
        }
      } else {
        emptyTargetStreak = 0;
      }

      // Pre-dispatch legality gate (spec §4.1).
      if (!actionIsLegal(engine, actorId, action)) {
        record.violations.push('bot_illegal_action');
        throw new Error(
          `bot_illegal_action: ${actorId} produced ${action.kind} not in legal set`
        );
      }

      const actorLabel = labelForPlayer(actorId, p1, p2);
      const actingPlayer = state.players.find((p) => p.playerId === actorId);
      const cardPlayed = buildCardPlayed(action, actingPlayer);
      const target =
        action.kind === 'play_card'
          ? action.destinationId
          : action.kind === 'move_unit'
          ? action.destinationId
          : action.kind === 'commence_battle'
          ? action.battlefieldId
          : null;

      const sig = `${actorId}|${action.kind}|${engine.currentPhase}|${engine.turnNumber}`;
      if (sig === lastActionSig) sameSigStreak++;
      else {
        sameSigStreak = 0;
        lastActionSig = sig;
      }

      try {
        dispatchAction(engine, actorId, action);
        actionCount++;
        lastRejectSig = '';
        rejectStreak = 0;
        emit(engine, actorLabel, action, {
          cardPlayed: cardPlayed ?? undefined,
          target: target ?? null
        });
      } catch (err) {
        const e = err as Error;
        if (!cfg.quiet) log(`[${gameId}] dispatch error: ${e.message}`);
        // Track repeated rejects of the same action signature. If the bot
        // keeps proposing a guaranteed-reject action (shouldn't happen now
        // that resolveSpellTargets is in place, but this is defense-in-depth),
        // force the game to advance a phase and eventually pass priority.
        const rejectSig = JSON.stringify({ a: actorId, k: action });
        if (rejectSig === lastRejectSig) rejectStreak++;
        else {
          rejectStreak = 1;
          lastRejectSig = rejectSig;
        }
        try {
          if (rejectStreak >= 3) {
            // Try passing priority first, then advance_phase, to break out of
            // a priority-window stall without changing turn.
            try {
              engine.passPriority(actorId);
              emit(engine, actorLabel, { kind: 'pass_priority' });
            } catch {
              engine.proceedToNextPhase();
              emit(engine, actorLabel, { kind: 'advance_phase' });
            }
          } else {
            engine.proceedToNextPhase();
            emit(engine, actorLabel, { kind: 'advance_phase' });
          }
        } catch {
          /* noop */
        }
      }

      if (engine.turnNumber === lastTurn) {
        iterationsWithoutTurnAdvance++;
      } else {
        iterationsWithoutTurnAdvance = 0;
        lastTurn = engine.turnNumber;
      }

      if (sameSigStreak >= 50 || iterationsWithoutTurnAdvance >= 500) {
        record.flaggedLoop = true;
        record.status = 'timeout';
        record.terminator = 'infinite_loop';
        record.violations.push('infinite_loop_suspected');
        break;
      }
    }

    const final = engine.getGameState();
    if (final.status === GameStatus.WINNER_DETERMINED) {
      record.winner = final.winner ?? null;
      record.status = 'completed';
      record.terminator = final.endReason ?? 'victory_points';
    } else if (
      (record.status === 'timeout' && record.terminator === 'turn_cap') ||
      record.status === 'action_cap'
    ) {
      // Hard-cap tiebreak: more VP → more board presence → coin-flip by seed.
      // Applies to turn cap and action cap paths so we always emit a winner.
      const pa = final.players.find((p) => p.playerId === p1);
      const pb = final.players.find((p) => p.playerId === p2);
      const vpA = pa?.victoryPoints ?? 0;
      const vpB = pb?.victoryPoints ?? 0;
      const tag = record.status === 'action_cap' ? 'action_cap' : 'turn_cap';
      if (vpA > vpB) {
        record.winner = p1;
        record.terminator = `${tag}_vp_tiebreak`;
      } else if (vpB > vpA) {
        record.winner = p2;
        record.terminator = `${tag}_vp_tiebreak`;
      } else {
        const boardA = pa?.board.creatures.length ?? 0;
        const boardB = pb?.board.creatures.length ?? 0;
        if (boardA > boardB) {
          record.winner = p1;
          record.terminator = `${tag}_board_tiebreak`;
        } else if (boardB > boardA) {
          record.winner = p2;
          record.terminator = `${tag}_board_tiebreak`;
        } else {
          const coin = (seed >>> 0) % 2;
          record.winner = coin === 0 ? p1 : p2;
          record.terminator = `${tag}_coinflip`;
        }
      }
      record.status = 'completed';
    } else if (record.status === 'completed') {
      record.status = 'timeout';
      record.terminator = 'no_winner';
    }
  } catch (err) {
    const e = err as Error;
    const hitInvariant = record.violations.length > 0;
    record.status = hitInvariant ? 'invariant' : 'crashed';
    record.terminator = record.status;
    record.error = e.message;
    record.errorStack = e.stack;
    const crash: CrashSample = {
      gameId,
      seed,
      strategyA: cfg.strategyA,
      strategyB: cfg.strategyB,
      turn: engine.turnNumber,
      error: e.message,
      stack: e.stack,
      partialState: safeSerialize(engine)
    };
    // Emit terminal record before closing
    emit(engine, 'system', null, {
      result: 'draw',
      winReason: `${record.status}: ${e.message}`,
      terminal: {
        winner: null,
        loser: null,
        reason: record.status,
        turns: engine.turnNumber,
        totalEvents: eventIndex + 1,
        violations: record.violations,
        durationMs: Date.now() - startedAt.getTime()
      }
    });
    sink.close();
    return { record, crashSample: crash };
  }

  // Emit terminal record
  const winnerLabel: 'P1' | 'P2' | null =
    record.winner === p1 ? 'P1' : record.winner === p2 ? 'P2' : null;
  const loserLabel: 'P1' | 'P2' | null =
    record.winner === p1 ? 'P2' : record.winner === p2 ? 'P1' : null;
  const resultField: 'P1_wins' | 'P2_wins' | 'draw' =
    winnerLabel === 'P1' ? 'P1_wins' : winnerLabel === 'P2' ? 'P2_wins' : 'draw';
  const winReason =
    record.terminator === 'victory_points'
      ? `reached ${engine.getGameState().victoryScore ?? 8} VP`
      : record.terminator === 'burn_out'
      ? 'opponent deck out'
      : record.terminator === 'turn_cap'
      ? 'turn cap (no tiebreak)'
      : record.terminator.startsWith('turn_cap_')
      ? `turn cap: ${record.terminator.replace('turn_cap_', '').replace('_', ' ')}`
      : record.terminator.startsWith('action_cap')
      ? `action cap: ${record.terminator.replace('action_cap_', '').replace('_', ' ')}`
      : record.terminator;
  emit(engine, 'system', null, {
    result: resultField,
    winReason,
    terminal: {
      winner: winnerLabel,
      loser: loserLabel,
      reason: record.terminator,
      turns: engine.turnNumber,
      totalEvents: eventIndex + 1,
      violations: record.violations,
      durationMs: Date.now() - startedAt.getTime()
    }
  });

  sink.close();
  return { record };
}

function safeSerialize(engine: RiftboundGameEngine): unknown {
  try {
    return JSON.parse(JSON.stringify(engine.getGameState()));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Report
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
  let actionCap = 0;
  let winsA = 0;
  let winsB = 0;
  let draws = 0;
  let drawsByCap = 0;
  let totalTurns = 0;
  const violationsByType: Record<string, number> = {};
  const loopCandidates: string[] = [];
  const deviations = new Set<string>();

  for (const r of records) {
    totalTurns += r.turns;
    for (const v of r.violations) {
      violationsByType[v] = (violationsByType[v] ?? 0) + 1;
    }
    for (const d of r.deviations ?? []) deviations.add(d);
    if (r.flaggedLoop) loopCandidates.push(r.gameId);
    switch (r.status) {
      case 'completed':
        completed++;
        if (r.winner === 'playerA') winsA++;
        else if (r.winner === 'playerB') winsB++;
        else draws++;
        if (r.terminator.startsWith('turn_cap') || r.terminator.startsWith('action_cap')) {
          drawsByCap++;
        }
        break;
      case 'crashed':
        crashed++;
        break;
      case 'timeout':
        timedOut++;
        break;
      case 'invariant':
        invariant++;
        break;
      case 'action_cap':
        actionCap++;
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
      actionLimit: cfg.actionLimit,
      quick: cfg.quick
    },
    summary: {
      gamesCompleted: completed,
      gamesCrashed: crashed,
      gamesTimedOut: timedOut,
      gamesInvariant: invariant,
      gamesActionCap: actionCap,
      avgTurns: records.length > 0 ? totalTurns / records.length : 0,
      winsA,
      winsB,
      draws,
      drawsByTurnCap: drawsByCap
    },
    violationsByType,
    topCrashes: crashes.slice(0, 20),
    infiniteLoopCandidates: loopCandidates,
    matches: records.map((r) => ({
      gameId: r.gameId,
      seed: r.seed,
      winner: r.winner,
      turns: r.turns,
      status: r.status,
      terminator: r.terminator,
      jsonlPath: r.jsonlPath
    })),
    deviations: [...deviations],
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

  log(`[selfplay] starting ${cfg.games} matches`);
  log(
    `[selfplay] strategyA=${cfg.strategyA} strategyB=${cfg.strategyB} seed=${cfg.seed} turnLimit=${cfg.turnLimit} actionLimit=${cfg.actionLimit}`
  );

  let catalog: EnrichedCardRecord[] | null = null;
  let playable: EnrichedCardRecord[] | null = null;
  let battlefieldRecords: EnrichedCardRecord[] | null = null;
  if (!cfg.quick) {
    try {
      catalog = getCardCatalog();
      playable = pickPlayableCards(catalog);
      battlefieldRecords = pickBattlefieldRecords(catalog);
      log(
        `[selfplay] loaded catalog: ${catalog.length} cards, ${playable.length} playable, ${battlefieldRecords.length} battlefields`
      );
    } catch (err) {
      const e = err as Error;
      notes.push(`Catalog load failed: ${e.message}. Falling back to synthetic decks.`);
      log(`[selfplay] WARN catalog load failed: ${e.message}`);
    }
  } else {
    notes.push('--quick used: synthetic fallback decks only');
  }

  if (cfg.emitJsonl) {
    fs.mkdirSync(cfg.jsonlDir, { recursive: true });
  }

  const startedAt = new Date();
  const records: GameRecord[] = [];
  const crashes: CrashSample[] = [];

  for (let i = 0; i < cfg.games; i++) {
    const res = playOneGame(i, cfg, cfg.seed, playable, battlefieldRecords, log);
    records.push(res.record);
    if (res.crashSample) crashes.push(res.crashSample);
    if (!cfg.quiet) {
      log(
        `[selfplay] match ${i + 1}/${cfg.games} seed=${res.record.seed} status=${res.record.status} winner=${res.record.winner ?? 'none'} turns=${res.record.turns} terminator=${res.record.terminator}${res.record.jsonlPath ? ' jsonl=' + res.record.jsonlPath : ''}`
      );
    }
  }

  const report = buildReport(cfg, records, crashes, startedAt, notes);

  try {
    fs.mkdirSync(path.dirname(cfg.report), { recursive: true });
    fs.writeFileSync(cfg.report, JSON.stringify(report, null, 2));
  } catch (err) {
    const e = err as Error;
    process.stderr.write(`[selfplay] ERROR writing report: ${e.message}\n`);
  }

  const s = report.summary;
  log(
    `[selfplay] done: ${s.gamesCompleted}/${cfg.games} completed, ${s.gamesCrashed} crashed, ${s.gamesTimedOut} timeout, ${s.gamesInvariant} invariant, ${s.gamesActionCap} action_cap. winsA=${s.winsA} winsB=${s.winsB} draws=${s.draws} avgTurns=${s.avgTurns.toFixed(1)} report=${cfg.report}`
  );
}

export {
  // Exposed for reuse by the viewer (Phase 3), downstream tests, and the
  // server-side bot-vs-bot driver that powers the live spectator flow.
  BotAction,
  describeAction,
  enumerateLegalActions,
  actionIsLegal,
  actionsEqual,
  dispatchAction,
  baselineBot,
  heuristicBot,
  getBot,
  buildDeckConfigForGame,
  forkRng,
  makeRng,
  Rng,
  StrategyName
};

if (require.main === module) {
  main();
}
