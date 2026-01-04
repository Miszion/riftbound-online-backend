import {
  ActivationProfile,
  CardActivationState,
  CardAssetInfo,
  CardCostProfile,
  EffectOperation,
  EffectProfile,
  EnrichedCardRecord,
  RuleClause,
  buildActivationStateIndex,
  findCardById,
  findCardBySlug
} from './card-catalog';

/**
 * Riftbound TCG Game State Engine
 *
 * This module handles all game logic for a single match:
 * - Player deck management
 * - Card play rules and validation
 * - Combat resolution
 * - Game state tracking
 * - Win conditions
 * - Turn management
 *
 * All game logic is kept in a single file for full traceability.
 */

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export enum CardType {
  CREATURE = 'creature',
  SPELL = 'spell',
  ARTIFACT = 'artifact',
  ENCHANTMENT = 'enchantment',
  RUNE = 'rune'
}

export enum CardRarity {
  COMMON = 'common',
  UNCOMMON = 'uncommon',
  RARE = 'rare',
  LEGENDARY = 'legendary',
  EPIC = 'epic',
  PROMO = 'promo',
  SHOWCASE = 'showcase'
}

export enum Domain {
  FURY = 'fury',
  CALM = 'calm',
  MIND = 'mind',
  BODY = 'body',
  CHAOS = 'chaos',
  ORDER = 'order'
}

export type DomainCost = Partial<Record<Domain, number>>;

export interface Card {
  id: string;
  slug?: string;
  name: string;
  type: CardType;
  rarity?: CardRarity;
  setName?: string | null;
  colors?: string[];
  tags?: string[];
  keywords?: string[];
  manaCost?: number;
  energyCost?: number;
  powerCost?: DomainCost;
  domain?: Domain;
  power?: number;
  toughness?: number;
  abilities?: CardAbility[];
  activationProfile?: ActivationProfile;
  rules?: RuleClause[];
  assets?: CardAssetInfo;
  metadata?: Record<string, unknown>;
  text: string;
  flavorText?: string | null;
  effectProfile?: EffectProfile;
  instanceId?: string;
}

export interface CardAbility {
  name: string;
  description: string;
  triggerType?: 'play' | 'attack' | 'damage' | 'heal' | 'death';
}

export interface PlayerHand {
  playerId: string;
  cards: Card[];
}

export interface RuneCard {
  id: string;
  name: string;
  domain?: Domain;
  energyValue?: number;
  powerValue?: number;
  slug?: string;
  assets?: CardAssetInfo | null;
  isTapped?: boolean;
  cardSnapshot?: Card | null;
}

export type PlayerSeed =
  | string
  | {
      playerId?: string;
      id?: string;
      name?: string | null;
    };

export type CardLocation =
  | {
      zone: 'base';
    }
  | {
      zone: 'battlefield';
      battlefieldId: string;
    };

export interface BoardCard extends Card {
  instanceId: string;
  currentToughness: number;
  isTapped: boolean;
  summoned: boolean; // Can't attack same turn it's summoned
  counters?: Record<string, number>;
  activationState: CardActivationState & {
    history: ActivationHistoryEntry[];
  };
  ruleLog: RuleLogEntry[];
  location: CardLocation;
}

export interface PlayerBoard {
  playerId: string;
  creatures: BoardCard[];
  artifacts: BoardCard[];
  enchantments: BoardCard[];
}

export interface PlayerState {
  playerId: string;
  name: string;
  victoryPoints: number;
  victoryScore: number;
  mana: number;
  maxMana: number;
  deck: Card[];
  runeDeck: RuneCard[];
  channeledRunes: RuneCard[];
  hand: Card[];
  graveyard: Card[];
  exile: Card[];
  board: PlayerBoard;
  resources: ResourcePool;
  temporaryEffects: TemporaryEffect[];
  battlefieldPool: Card[];
  selectedBattlefield?: BattlefieldState;
  firstTurnRuneBoost: number;
  championLegend?: Card | null;
  championLeader?: Card | null;
}

export interface ResourcePool {
  energy: number;
  power: Record<Domain, number>;
  universalPower: number;
}

export interface PlayerDeckConfig {
  mainDeck?: DeckCardEntry[];
  /**
   * Some clients (e.g. the web UI) send the main deck as `cards`.
   * Keep supporting that shape to avoid invalid deck errors.
   */
  cards?: DeckCardEntry[];
  runeDeck?: (DeckCardEntry | RuneCard)[];
  battlefields?: DeckCardEntry[];
  cardCount?: number;
  championLegend?: DeckCardEntry | null;
  championLeader?: DeckCardEntry | null;
}

export interface DeckCardReference {
  cardId?: string;
  slug?: string;
  quantity?: number;
  overrides?: Partial<Card>;
}

export type DeckCardEntry = Card | string | DeckCardReference;

interface CardCost {
  energy: number;
  power: DomainCost;
}

export interface ActivationHistoryEntry {
  at: number;
  reason: string;
  active: boolean;
}

export interface RuleLogEntry {
  clauseId: string;
  resolvedAt: number;
  context: string;
}

export interface TemporaryEffect {
  id: string;
  affectedCards?: string[]; // instanceIds
  affectedPlayer?: string;
  duration: number; // turns remaining
  effect: {
    type: 'damage_boost' | 'toughness_boost' | 'grant_ability' | 'prevent_damage' | 'draw_card';
    value?: number;
  };
}

export type ScoreReason = 'combat' | 'objective' | 'support' | 'decking' | 'concede' | 'timeout';

export type PromptType =
  | 'mulligan'
  | 'action'
  | 'target'
  | 'reaction'
  | 'priority'
  | 'battlefield'
  | 'coin_flip';

export interface GamePrompt {
  id: string;
  type: PromptType;
  playerId: string;
  data: Record<string, unknown>;
  resolved: boolean;
  createdAt: number;
  resolvedAt?: number;
  resolution?: Record<string, unknown>;
}

export interface PriorityWindow {
  id: string;
  type: 'main' | 'reaction' | 'showdown';
  holder: string;
  openedAt: number;
  event?: string;
  expiresAt?: number;
}

export interface GameStateSnapshot {
  turn: number;
  phase: GamePhase;
  timestamp: number;
  reason: string;
  summary: string;
}

export interface ScoreEvent {
  playerId: string;
  amount: number;
  reason: ScoreReason;
  sourceCardId?: string;
  timestamp: number;
}

export type DuelLogTone = 'info' | 'success' | 'warning' | 'error';

export interface DuelLogEntry {
  id: string;
  message: string;
  tone: DuelLogTone;
  timestamp: number;
  playerId?: string | null;
  actorName?: string | null;
}

export interface ChatMessage {
  id: string;
  playerId?: string | null;
  playerName?: string | null;
  message: string;
  timestamp: number;
}

export enum GamePhase {
  BEGIN = 'begin',
  MAIN_1 = 'main_1',
  COMBAT = 'combat',
  MAIN_2 = 'main_2',
  END = 'end',
  CLEANUP = 'cleanup'
}

export enum GameStatus {
  WAITING_FOR_PLAYERS = 'waiting_for_players',
  SETUP = 'setup',
  COIN_FLIP = 'coin_flip',
  BATTLEFIELD_SELECTION = 'battlefield_selection',
  MULLIGAN = 'mulligan',
  IN_PROGRESS = 'in_progress',
  WINNER_DETERMINED = 'winner_determined',
  COMPLETED = 'completed'
}

export type TurnSequenceStep = 'awaken' | 'begin' | 'channel' | 'draw' | 'main';
const TURN_SEQUENCE_LABELS: Record<TurnSequenceStep, string> = {
  awaken: 'Awaken step',
  begin: 'Begin step',
  channel: 'Channel step',
  draw: 'Draw step',
  main: 'Main Phase 1'
};

export interface GameState {
  matchId: string;
  players: PlayerState[];
  currentPlayerIndex: number;
  currentPhase: GamePhase;
  turnNumber: number;
  status: GameStatus;
  winner?: string;
  moveHistory: GameMove[];
  timestamp: number;
  victoryScore: number;
  scoreLog: ScoreEvent[];
  endReason?: MatchResult['reason'];
  prompts: GamePrompt[];
  priorityWindow: PriorityWindow | null;
  snapshots: GameStateSnapshot[];
  battlefields: BattlefieldState[];
  initiativeWinner?: string | null;
  initiativeLoser?: string | null;
  initiativeSelections?: Record<string, number>;
  initiativeDecidedAt?: number | null;
  duelLog: DuelLogEntry[];
  chatLog: ChatMessage[];
  pendingMainPhaseEntry: boolean;
  turnSequenceStep: TurnSequenceStep | null;
}

export interface GameMove {
  playerIndex: number;
  turn: number;
  phase: GamePhase;
  action: 'play_card' | 'attack' | 'move' | 'pass' | 'activate_ability' | 'end_turn';
  cardId?: string;
  targetId?: string;
  timestamp: number;
}

export interface MatchResult {
  matchId: string;
  winner: string;
  loser: string;
  reason: 'victory_points' | 'burn_out' | 'concede' | 'timeout';
  duration: number;
  turns: number;
  moves: GameMove[];
}

export interface BattlefieldState {
  battlefieldId: string;
  slug?: string;
  name: string;
  card?: Card;
  ownerId: string;
  controller?: string;
  contestedBy: string[];
  lastConqueredTurn?: number;
  lastHoldTurn?: number;
  lastCombatTurn?: number;
}

const INITIATIVE_CHOICES = [
  { value: 0, label: "Doran's Blade" },
  { value: 1, label: "Doran's Shield" },
  { value: 2, label: "Doran's Ring" }
];

const INITIATIVE_BEATS: Record<number, number> = {
  0: 1, // Blade beats Shield
  1: 2, // Shield beats Ring
  2: 0 // Ring beats Blade
};

// ============================================================================
// GAME ENGINE CLASS
// ============================================================================

export class RiftboundGameEngine {
  private static readonly MAX_DUEL_LOG_ENTRIES = 200;
  private static readonly MAX_CHAT_LOG_ENTRIES = 200;
  private gameState: GameState;
  private readonly INITIAL_HAND_SIZE = 4;
  private readonly VICTORY_SCORE = 8;
  private readonly MIN_DECK_SIZE = 39;
  private readonly RUNE_DECK_SIZE = 12;
  private readonly RUNES_PER_TURN = 2;
  private readonly DEFAULT_BATTLEFIELD_COUNT = 2;
  private readonly cardActivationTemplates = buildActivationStateIndex();
  private readonly catalogCardCache = new Map<string, Card>();
  private promptCounter = 0;
  private cardInstanceCounter = 0;

  constructor(matchId: string, players: PlayerSeed[]) {
    if (players.length !== 2) {
      throw new Error('Riftbound requires exactly 2 players');
    }
    const normalizedPlayers = players.map((entry) => {
      if (typeof entry === 'string') {
        return { playerId: entry, name: null };
      }
      const derivedId = entry.playerId ?? entry.id;
      if (!derivedId) {
        throw new Error('Invalid player descriptor');
      }
      return {
        playerId: derivedId,
        name: entry.name ?? null
      };
    });

    this.gameState = {
      matchId,
      players: normalizedPlayers.map((player) =>
        this.createPlayerState(player.playerId, player.name)
      ),
      currentPlayerIndex: 0,
      currentPhase: GamePhase.BEGIN,
      turnNumber: 1,
      status: GameStatus.SETUP,
      moveHistory: [],
      timestamp: Date.now(),
      victoryScore: this.VICTORY_SCORE,
      scoreLog: [],
      prompts: [],
      priorityWindow: null,
      snapshots: [],
      battlefields: [],
      initiativeWinner: null,
      initiativeLoser: null,
      initiativeSelections: {},
      initiativeDecidedAt: null,
      duelLog: [],
      chatLog: [],
      pendingMainPhaseEntry: false,
      turnSequenceStep: null
    };
  }

  private static cloneGameState(state: GameState): GameState {
    return JSON.parse(JSON.stringify(state)) as GameState;
  }

  public static fromSerializedState(state: GameState): RiftboundGameEngine {
    const players = state.players.map((player) => ({
      playerId: player.playerId,
      name: player.name ?? null
    }));
    const engine = new RiftboundGameEngine(state.matchId, players);
    engine.gameState = RiftboundGameEngine.cloneGameState(state);
    engine.promptCounter = engine.gameState.prompts.length;
    if (typeof engine.gameState.pendingMainPhaseEntry !== 'boolean') {
      engine.gameState.pendingMainPhaseEntry = false;
    }
    if (!engine.gameState.turnSequenceStep) {
      engine.gameState.turnSequenceStep = null;
    }
    return engine;
  }

  // ========================================================================
  // INITIALIZATION
  // ========================================================================

  private createPlayerState(playerId: string, displayName?: string | null): PlayerState {
    const normalizedName =
      typeof displayName === 'string' && displayName.trim().length > 0
        ? displayName.trim()
        : playerId;
    return {
      playerId,
      name: normalizedName,
      victoryPoints: 0,
      victoryScore: this.VICTORY_SCORE,
      mana: 0,
      maxMana: 0,
      deck: [],
      runeDeck: [],
      channeledRunes: [],
      hand: [],
      graveyard: [],
      exile: [],
      board: {
        playerId,
        creatures: [],
        artifacts: [],
        enchantments: []
      },
      resources: {
        energy: 0,
        power: this.createEmptyPowerPool(),
        universalPower: 0
      },
      temporaryEffects: [],
      battlefieldPool: [],
      firstTurnRuneBoost: 0,
      championLegend: null,
      championLeader: null
    };
  }

  private nextCardInstanceId(cardId: string): string {
    const counter = this.cardInstanceCounter++;
    return `${cardId}_${Date.now()}_${counter}`;
  }

  /**
   * Initialize the game with player decks
   */
  public initializeGame(decksByPlayerId: Record<string, PlayerDeckConfig | DeckCardEntry[]>): void {
    if (this.gameState.status !== GameStatus.SETUP) {
      throw new Error('Game already initialized');
    }

    for (const player of this.gameState.players) {
      const deckConfig = decksByPlayerId[player.playerId];
      if (!deckConfig) {
        throw new Error(`Missing deck for player ${player.playerId}`);
      }

      const mainDeckEntries = Array.isArray(deckConfig)
        ? deckConfig
        : deckConfig.mainDeck ?? deckConfig.cards ?? [];
      const normalizedMainDeck = this.buildDeckFromConfig(mainDeckEntries);
      if (!normalizedMainDeck.length || normalizedMainDeck.length < this.MIN_DECK_SIZE) {
        throw new Error(
          `Invalid deck size for player ${player.playerId} (requires at least ${this.MIN_DECK_SIZE}, got ${normalizedMainDeck.length})`
        );
      }

      const runeDeckConfig = Array.isArray(deckConfig) ? undefined : deckConfig.runeDeck;
      const normalizedRuneDeck =
        runeDeckConfig && runeDeckConfig.length > 0
          ? this.normalizeRuneDeck(runeDeckConfig)
          : this.generateFallbackRuneDeck();

      if (!Array.isArray(deckConfig) && deckConfig.battlefields?.length) {
        player.battlefieldPool = this.buildDeckFromConfig(deckConfig.battlefields);
      } else if (Array.isArray(deckConfig)) {
        player.battlefieldPool = this.generateFallbackBattlefields(player.playerId);
      } else {
        player.battlefieldPool = this.generateFallbackBattlefields(player.playerId);
      }

      if (!Array.isArray(deckConfig)) {
        player.championLegend = this.resolveChampionCard(deckConfig.championLegend ?? null);
        player.championLeader = this.resolveChampionCard(deckConfig.championLeader ?? null);
      } else {
        player.championLegend = null;
        player.championLeader = null;
      }

      if (normalizedRuneDeck.length < this.RUNE_DECK_SIZE) {
        throw new Error(
          `Invalid rune deck for player ${player.playerId} (requires ${this.RUNE_DECK_SIZE}, got ${normalizedRuneDeck.length})`
        );
      }

      player.deck = [...normalizedMainDeck];
      player.runeDeck = [...normalizedRuneDeck];
      player.channeledRunes = [];
      this.shuffle(player.deck);
      this.shuffle(player.runeDeck);
      this.drawCards(player, this.INITIAL_HAND_SIZE);
    }

    this.gameState.status = GameStatus.COIN_FLIP;
    this.recordSnapshot('setup-ready');
    this.startCoinFlipPhase();
  }

  private startCoinFlipPhase(): void {
    this.gameState.prompts = this.gameState.prompts.filter((prompt) => prompt.type !== 'coin_flip');
    this.gameState.initiativeWinner = null;
    this.gameState.initiativeLoser = null;
    this.gameState.initiativeSelections = {};
    this.gameState.initiativeDecidedAt = null;
    for (const player of this.gameState.players) {
      this.enqueuePrompt('coin_flip', player.playerId, {
        options: INITIATIVE_CHOICES,
        instructions:
          "Select Doran's Blade, Shield, or Ring. Shield beats Ring, Blade beats Shield, Ring beats Blade. Matching choices force a rematch."
      });
    }
    this.recordSnapshot('coin-flip-awaiting');
  }

  public submitInitiativeChoice(playerId: string, choice: number): void {
    if (this.gameState.status !== GameStatus.COIN_FLIP) {
      throw new Error('Initiative has already been determined');
    }
    if (![0, 1, 2].includes(choice)) {
      throw new Error('Invalid initiative choice');
    }
    const prompt = this.findPrompt('coin_flip', playerId);
    if (prompt.resolved) {
      throw new Error('Initiative choice already submitted');
    }
    this.resolvePrompt(prompt, { choice });
    if (this.promptsResolved('coin_flip')) {
      this.finalizeInitiativeDuel();
    }
  }

  private finalizeInitiativeDuel(): void {
    const selections = this.gameState.prompts
      .filter((prompt) => prompt.type === 'coin_flip' && prompt.resolution)
      .map((prompt) => ({
        playerId: prompt.playerId,
        choice: Number(prompt.resolution?.choice)
      }));

    if (selections.length !== this.gameState.players.length) {
      return;
    }

    const [firstSelection, secondSelection] = selections;
    if (
      firstSelection.choice === undefined ||
      secondSelection.choice === undefined ||
      Number.isNaN(firstSelection.choice) ||
      Number.isNaN(secondSelection.choice)
    ) {
      throw new Error('Invalid initiative selections');
    }

    if (firstSelection.choice === secondSelection.choice) {
      this.recordSnapshot('coin-flip-tie');
      this.startCoinFlipPhase();
      return;
    }

    const firstWins = INITIATIVE_BEATS[firstSelection.choice] === secondSelection.choice;
    const winner = firstWins ? firstSelection : secondSelection;
    const loser = firstWins ? secondSelection : firstSelection;

    const firstIndex = this.gameState.players.findIndex((p) => p.playerId === winner.playerId);
    if (firstIndex === -1) {
      throw new Error('Failed to locate initiative winner');
    }
    this.gameState.currentPlayerIndex = firstIndex;

    const loserState = this.getPlayerById(loser.playerId);
    loserState.firstTurnRuneBoost = 1;

    const selectionMap: Record<string, number> = {};
    for (const selection of selections) {
      selectionMap[selection.playerId] = selection.choice;
    }
    this.gameState.initiativeWinner = winner.playerId;
    this.gameState.initiativeLoser = loser.playerId;
    this.gameState.initiativeSelections = selectionMap;
    this.gameState.initiativeDecidedAt = Date.now();

    this.gameState.prompts = this.gameState.prompts.filter((prompt) => prompt.type !== 'coin_flip');
    this.recordSnapshot('coin-flip');
    this.gameState.status = GameStatus.BATTLEFIELD_SELECTION;
    this.startBattlefieldSelectionPhase();
  }

  private startBattlefieldSelectionPhase(): void {
    this.gameState.prompts = this.gameState.prompts.filter((prompt) => prompt.type !== 'battlefield');
    for (const player of this.gameState.players) {
      const options = this.ensureBattlefieldOptions(player);
      if (options.length <= 1) {
        const selected = options[0];
        if (selected) {
          this.assignBattlefieldSelection(player, selected);
        }
        continue;
      }
      this.enqueuePrompt('battlefield', player.playerId, {
        options: options.map((card) => this.buildBattlefieldPromptOption(card))
      });
    }
    this.checkBattlefieldSelectionCompletion();
  }

  private ensureBattlefieldOptions(player: PlayerState): Card[] {
    if (!player.battlefieldPool || player.battlefieldPool.length === 0) {
      player.battlefieldPool = this.generateFallbackBattlefields(player.playerId);
    }
    return player.battlefieldPool;
  }

  public selectBattlefield(playerId: string, battlefieldId: string): void {
    if (
      this.gameState.status !== GameStatus.BATTLEFIELD_SELECTION &&
      this.gameState.status !== GameStatus.SETUP
    ) {
      throw new Error('Battlefield selection phase has ended');
    }

    const player = this.getPlayerById(playerId);
    const options = this.ensureBattlefieldOptions(player);
    const choice = options.find(
      (card) => card.id === battlefieldId || (card.slug && card.slug === battlefieldId)
    );
    if (!choice) {
      throw new Error('Battlefield not available for selection');
    }

    this.assignBattlefieldSelection(player, choice);
    const prompt = this.gameState.prompts.find(
      (entry) => entry.type === 'battlefield' && entry.playerId === playerId && !entry.resolved
    );
    if (prompt) {
      this.resolvePrompt(prompt, { battlefieldId: choice.id });
    }
    this.checkBattlefieldSelectionCompletion();
  }

  private assignBattlefieldSelection(player: PlayerState, card: Card): void {
    player.selectedBattlefield = this.createBattlefieldStateFromCard(card, player.playerId);
  }

  private buildBattlefieldPromptOption(card: Card) {
    return {
      cardId: card.id,
      slug: card.slug ?? null,
      name: card.name,
      description: card.text ?? null,
      cardSnapshot: {
        cardId: card.id,
        slug: card.slug ?? null,
        name: card.name,
        type: card.type,
        rarity: card.rarity ?? null,
        colors: card.colors ?? [],
        keywords: card.keywords ?? [],
        effect: card.text ?? null,
        assets: card.assets ?? null
      }
    };
  }

  private checkBattlefieldSelectionCompletion(): void {
    if (!this.gameState.players.every((player) => Boolean(player.selectedBattlefield))) {
      return;
    }

    const orderedSelections = this.gameState.players
      .map((player) => player.selectedBattlefield!)
      .map((state) => this.cloneBattlefieldState(state))
      .slice(0, this.DEFAULT_BATTLEFIELD_COUNT);
    this.gameState.battlefields = orderedSelections;
    this.gameState.status = GameStatus.MULLIGAN;
    this.recordSnapshot('battlefields-ready');
    this.startMulliganPhase();
  }

  private startMulliganPhase(): void {
    this.gameState.prompts = this.gameState.prompts.filter((prompt) => prompt.type !== 'mulligan');
    for (const player of this.gameState.players) {
      this.enqueuePrompt('mulligan', player.playerId, {
        handSize: player.hand.length,
        maxReplacements: 2
      });
    }
  }

  public submitMulligan(playerId: string, indices: number[]): void {
    if (this.gameState.status !== GameStatus.MULLIGAN) {
      throw new Error('Mulligan phase already completed');
    }
    const player = this.getPlayerById(playerId);
    const prompt = this.findPrompt('mulligan', playerId);
    const unique = Array.from(new Set(indices))
      .filter((index) => Number.isInteger(index) && index >= 0 && index < player.hand.length)
      .slice(0, 2)
      .sort((a, b) => b - a);

    const setAside: Card[] = [];
    for (const index of unique) {
      const [card] = player.hand.splice(index, 1);
      if (card) {
        setAside.push(card);
      }
    }

    this.recycleCards(player, setAside);
    this.drawCards(player, setAside.length);

    this.resolvePrompt(prompt, {
      replaced: setAside.length
    });
    this.recordSnapshot(`mulligan-${playerId}`);

    if (this.promptsResolved('mulligan')) {
      this.finishMulliganPhase();
    }
  }

  private finishMulliganPhase(): void {
    this.gameState.status = GameStatus.IN_PROGRESS;
    this.gameState.currentPhase = GamePhase.BEGIN;
    this.recordSnapshot('mulligan-complete');
    this.beginTurn();
  }

  // ========================================================================
  // PHASE MANAGEMENT
  // ========================================================================

  /**
   * Begin turn: restore mana and draw a card
   */
  public beginTurn(): void {
    const currentPlayer = this.getCurrentPlayer();
    this.closePriorityWindow();
    this.gameState.pendingMainPhaseEntry = true;
    this.currentPhase = GamePhase.BEGIN;

    // A — Awaken
    this.updateTurnSequenceStep('awaken', currentPlayer, 'turn-awaken');
    this.untapAllPermanents(currentPlayer);
    this.untapRunes(currentPlayer);
    this.readySummonedCreatures(currentPlayer);

    // B — Begin phase triggers
    this.updateTurnSequenceStep('begin', currentPlayer, 'turn-begin-step');
    this.resolveTemporaryEffects(currentPlayer);

    // C — Channel
    this.updateTurnSequenceStep('channel', currentPlayer, 'turn-channel');
    const bonusRunes = currentPlayer.firstTurnRuneBoost > 0 ? currentPlayer.firstTurnRuneBoost : 0;
    const runesToChannel = this.RUNES_PER_TURN + bonusRunes;
    this.channelRunes(currentPlayer, runesToChannel);
    currentPlayer.firstTurnRuneBoost = 0;

    // D — Draw
    this.updateTurnSequenceStep('draw', currentPlayer, 'turn-draw');
    this.drawCards(currentPlayer, 1);

    if (this.hasBlockingBeginPhaseActivity()) {
      this.openPriorityWindow('main', currentPlayer.playerId, 'begin-phase');
      this.recordSnapshot('begin-phase-blocked');
      return;
    }

    this.promoteBeginPhaseToMainPhase(currentPlayer);
  }

  private channelRunes(player: PlayerState, maxRunes: number): void {
    for (let i = 0; i < maxRunes; i++) {
      if (player.runeDeck.length === 0) {
        break;
      }

      const rune = player.runeDeck.shift();
      if (!rune) {
        break;
      }

      rune.isTapped = false;
      player.channeledRunes.push(rune);
    }
    this.recalculateResources(player);
  }

  public addDuelLogEntry(entry: {
    id?: string | null;
    playerId?: string | null;
    actorName?: string | null;
    message: string;
    tone?: string | null;
  }): DuelLogEntry {
    const trimmed = (entry.message ?? '').trim();
    if (!trimmed) {
      throw new Error('Log message is required');
    }
    const tone = this.normalizeLogTone(entry.tone);
    const identifier =
      (entry.id ?? '').trim() || `log_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const existing = this.gameState.duelLog.find((log) => log.id === identifier);
    if (existing) {
      return existing;
    }
    const resolvedName = entry.actorName ?? this.resolvePlayerName(entry.playerId);
    const newEntry: DuelLogEntry = {
      id: identifier,
      message: trimmed.slice(0, 500),
      tone,
      timestamp: Date.now(),
      playerId: entry.playerId ?? null,
      actorName: resolvedName ?? null
    };
    this.gameState.duelLog.push(newEntry);
    this.trimLogCollection(this.gameState.duelLog, RiftboundGameEngine.MAX_DUEL_LOG_ENTRIES);
    return newEntry;
  }

  public addChatMessage(entry: {
    id?: string | null;
    playerId?: string | null;
    playerName?: string | null;
    message: string;
  }): ChatMessage {
    const trimmed = (entry.message ?? '').trim();
    if (!trimmed) {
      throw new Error('Chat message cannot be empty');
    }
    const identifier =
      (entry.id ?? '').trim() || `chat_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const existing = this.gameState.chatLog.find((message) => message.id === identifier);
    if (existing) {
      return existing;
    }
    const resolvedName =
      entry.playerName ?? this.resolvePlayerName(entry.playerId) ?? undefined;
    const message: ChatMessage = {
      id: identifier,
      playerId: entry.playerId ?? null,
      playerName: resolvedName ?? null,
      message: trimmed.slice(0, 1000),
      timestamp: Date.now()
    };
    this.gameState.chatLog.push(message);
    this.trimLogCollection(this.gameState.chatLog, RiftboundGameEngine.MAX_CHAT_LOG_ENTRIES);
    return message;
  }

  private resolvePlayerName(playerId?: string | null): string | null {
    if (!playerId) {
      return null;
    }
    const player = this.gameState.players.find((entry) => entry.playerId === playerId);
    return player?.name ?? null;
  }

  private normalizeLogTone(tone?: string | null): DuelLogTone {
    const normalized = (tone ?? '').toLowerCase();
    if (normalized === 'success' || normalized === 'warning' || normalized === 'error') {
      return normalized;
    }
    return 'info';
  }

  private trimLogCollection<T>(collection: T[], limit: number): void {
    if (collection.length <= limit) {
      return;
    }
    const excess = collection.length - limit;
    collection.splice(0, excess);
  }

  private exhaustRunes(player: PlayerState, count: number): void {
    if (count <= 0) {
      return;
    }
    let remaining = count;
    for (const rune of player.channeledRunes) {
      if (remaining <= 0) {
        break;
      }
      if (!rune.isTapped) {
        rune.isTapped = true;
        remaining--;
      }
    }
    this.recalculateResources(player);
  }

  private untapRunes(player: PlayerState): void {
    let changed = false;
    for (const rune of player.channeledRunes) {
      if (rune.isTapped) {
        rune.isTapped = false;
        changed = true;
      }
    }
    if (changed) {
      this.recalculateResources(player);
    }
  }

  private recalculateResources(player: PlayerState): void {
    const untappedRunes = player.channeledRunes.filter((rune) => !rune.isTapped);
    const energy = untappedRunes.length;
    let universal = 0;
    const powerPool = this.createEmptyPowerPool();
    for (const rune of untappedRunes) {
      const contribution = Math.max(1, rune.powerValue ?? 1);
      const domain = rune.domain ?? null;
      if (domain && powerPool[domain] !== undefined) {
        powerPool[domain] += contribution;
      } else {
        universal += contribution;
      }
    }
    player.resources.energy = energy;
    player.resources.power = powerPool;
    player.resources.universalPower = universal;
    this.syncLegacyMana(player);
  }

  private tryAllocateRunesForCost(player: PlayerState, cost: CardCost, commit: boolean): boolean {
    const energyRequirement = Math.max(0, cost.energy ?? 0);
    const powerRequirement = cost.power ?? {};
    const totalPowerRequired = Object.values(powerRequirement).reduce(
      (sum, value) => sum + Math.max(0, Math.ceil(value ?? 0)),
      0
    );
    if (energyRequirement <= 0 && totalPowerRequired <= 0) {
      return true;
    }

    const availableEntries = player.channeledRunes.map((rune, index) => ({ rune, index }));
    const reserved = new Set<number>();
    const energySelections: Array<{ rune: RuneCard; index: number }> = [];
    const powerSelections: Array<{ rune: RuneCard; index: number }> = [];
    const powerAssigned = new Set<number>();
    const validDomains = new Set<string>(Object.values(Domain));
    const domainDemand = new Map<Domain, number>();
    for (const [domainKey, rawValue] of Object.entries(powerRequirement)) {
      if (!validDomains.has(domainKey)) {
        continue;
      }
      const normalizedDomain = domainKey as Domain;
      const requirement = Math.max(0, Math.ceil(rawValue ?? 0));
      if (requirement > 0) {
        domainDemand.set(normalizedDomain, requirement);
      }
    }

    const claimEntry = (
      predicate: (entry: { rune: RuneCard; index: number }) => boolean,
      options?: { allowTapped?: boolean }
    ): { rune: RuneCard; index: number } | null => {
      const allowTapped = Boolean(options?.allowTapped);
      for (const entry of availableEntries) {
        if (reserved.has(entry.index)) {
          continue;
        }
        if (!allowTapped && entry.rune.isTapped) {
          continue;
        }
        if (predicate(entry)) {
          reserved.add(entry.index);
          return entry;
        }
      }
      return null;
    };

    const useEnergySelectionForPower = (domain: Domain) => {
      for (const entry of energySelections) {
        if (powerAssigned.has(entry.index)) {
          continue;
        }
        if (entry.rune.domain === domain && (entry.rune.powerValue ?? 1) > 0) {
          powerAssigned.add(entry.index);
          return entry;
        }
      }
      for (const entry of energySelections) {
        if (powerAssigned.has(entry.index)) {
          continue;
        }
        if (!entry.rune.domain && (entry.rune.powerValue ?? 1) > 0) {
          powerAssigned.add(entry.index);
          return entry;
        }
      }
      return null;
    };

    let energyRemaining = energyRequirement;
    while (energyRemaining > 0) {
      const selection =
        claimEntry((entry) => {
          const domainKey = entry.rune.domain as Domain | undefined;
          return Boolean(domainKey && (domainDemand.get(domainKey) ?? 0) > 0);
        }) ??
        claimEntry((entry) => !entry.rune.domain) ??
        claimEntry((_entry) => true);
      if (!selection) {
        return false;
      }
      energySelections.push(selection);
      energyRemaining -= 1;
    }

    for (const [normalizedDomain, requirement] of domainDemand.entries()) {
      let remaining = requirement;
      while (remaining > 0) {
        let selection = useEnergySelectionForPower(normalizedDomain);
        if (!selection) {
          selection = claimEntry(
            (entry) =>
              entry.rune.domain === normalizedDomain &&
              (entry.rune.powerValue ?? 1) > 0,
            { allowTapped: true }
          );
          if (!selection) {
            selection = claimEntry(
              (entry) => !entry.rune.domain && (entry.rune.powerValue ?? 1) > 0,
              { allowTapped: true }
            );
          }
          if (!selection) {
            return false;
          }
          energySelections.push(selection);
          powerAssigned.add(selection.index);
        }
        powerSelections.push(selection);
        remaining -= selection.rune.powerValue ?? 1;
      }
    }

    if (commit) {
      energySelections.forEach(({ rune }) => {
        rune.isTapped = true;
      });
      powerSelections.forEach(({ rune }) => {
        this.recycleRune(player, rune);
      });
      this.recalculateResources(player);
    }

    return true;
  }

  private enterCombatPhase(autoRecord = false): void {
    if (this.currentPhase === GamePhase.COMBAT) {
      return;
    }
    this.currentPhase = GamePhase.COMBAT;
    const opponent = this.getOtherPlayer(this.getCurrentPlayer());
    this.openPriorityWindow('showdown', opponent.playerId, 'combat-open');
    if (autoRecord) {
      this.recordSnapshot('phase-combat');
    }
  }

  private advancePhaseOnce(): void {
    switch (this.currentPhase) {
      case GamePhase.BEGIN:
        if (this.gameState.pendingMainPhaseEntry) {
          this.tryAutoAdvanceFromBeginPhase();
        } else {
          this.beginTurn();
        }
        break;
      case GamePhase.MAIN_1:
        this.enterCombatPhase();
        break;
      case GamePhase.COMBAT:
        this.currentPhase = GamePhase.MAIN_2;
        this.openPriorityWindow('main', this.getCurrentPlayer().playerId, 'post-combat');
        break;
      case GamePhase.MAIN_2:
        this.currentPhase = GamePhase.END;
        this.resolveEndOfTurnEffects(this.getCurrentPlayer());
        {
          const opponent = this.getOtherPlayer(this.getCurrentPlayer());
          this.openPriorityWindow('reaction', opponent.playerId, 'end-step');
        }
        break;
      case GamePhase.END:
        this.currentPhase = GamePhase.CLEANUP;
        this.endTurn();
        this.closePriorityWindow();
        break;
      case GamePhase.CLEANUP:
        break;
    }
    this.recordSnapshot(`phase-${this.currentPhase}`);
  }

  private hasBlockingEndStepActivity(): boolean {
    return this.gameState.prompts.some((prompt) => !prompt.resolved);
  }

  private hasBlockingBeginPhaseActivity(): boolean {
    return this.gameState.prompts.some((prompt) => !prompt.resolved);
  }

  private shouldAutoAdvancePhase(previousPhase: GamePhase): boolean {
    if (this.currentPhase === GamePhase.END) {
      if (this.hasBlockingEndStepActivity()) {
        return false;
      }
      if (this.gameState.priorityWindow?.event === 'end-step') {
        this.closePriorityWindow();
      }
      return true;
    }
    if (previousPhase === GamePhase.END && this.currentPhase === GamePhase.BEGIN) {
      return true;
    }
    return false;
  }

  private promoteBeginPhaseToMainPhase(
    player: PlayerState,
    reason: string = 'turn-begin'
  ): void {
    this.gameState.pendingMainPhaseEntry = false;
    this.updateTurnSequenceStep('main', player, reason);
    this.currentPhase = GamePhase.MAIN_1;
    this.openPriorityWindow('main', player.playerId, 'turn-start');
  }

  private tryAutoAdvanceFromBeginPhase(): void {
    if (this.currentPhase !== GamePhase.BEGIN) {
      return;
    }
    if (!this.gameState.pendingMainPhaseEntry) {
      return;
    }
    if (this.hasBlockingBeginPhaseActivity()) {
      return;
    }
    const currentPlayer = this.getCurrentPlayer();
    this.promoteBeginPhaseToMainPhase(currentPlayer, 'turn-begin-effects-resolved');
  }

  private updateTurnSequenceStep(step: TurnSequenceStep, player: PlayerState, snapshotReason?: string): void {
    this.gameState.turnSequenceStep = step;
    const label = TURN_SEQUENCE_LABELS[step];
    this.addDuelLogEntry({
      playerId: player.playerId,
      actorName: player.name ?? player.playerId,
      message: `${label} for ${player.name ?? player.playerId}`,
      tone: 'info'
    });
    if (snapshotReason) {
      this.recordSnapshot(snapshotReason);
    }
  }

  /**
   * Proceed to next phase
   */
  public proceedToNextPhase(): void {
    const startedInEndPhase = this.currentPhase === GamePhase.END;
    if (!startedInEndPhase) {
      let safetyCounter = 0;
      const MAX_PHASE_ADVANCES = 10;
      while (safetyCounter < MAX_PHASE_ADVANCES) {
        const phaseBeforeAdvance: GamePhase = this.currentPhase;
        if (phaseBeforeAdvance === GamePhase.END) {
          this.handleAutoAdvanceAfterPhase(phaseBeforeAdvance);
          return;
        }
        this.advancePhaseOnce();
        safetyCounter += 1;
        const phaseAfterAdvance: GamePhase = this.currentPhase;
        if (phaseAfterAdvance === phaseBeforeAdvance) {
          return;
        }
        if (phaseAfterAdvance === GamePhase.END) {
          this.handleAutoAdvanceAfterPhase(phaseBeforeAdvance);
          return;
        }
      }
      this.handleAutoAdvanceAfterPhase(this.currentPhase);
      return;
    }
    const phaseBeforeAdvance: GamePhase = this.currentPhase;
    this.advancePhaseOnce();
    this.handleAutoAdvanceAfterPhase(phaseBeforeAdvance);
  }

  private handleAutoAdvanceAfterPhase(phaseBeforeAdvance: GamePhase): void {
    let continueAdvancing = this.shouldAutoAdvancePhase(phaseBeforeAdvance);
    let previousPhase = phaseBeforeAdvance;
    while (continueAdvancing) {
      this.advancePhaseOnce();
      previousPhase = this.currentPhase;
      continueAdvancing = this.shouldAutoAdvancePhase(previousPhase);
    }
    if (this.currentPhase === GamePhase.BEGIN && !this.gameState.pendingMainPhaseEntry) {
      this.advancePhaseOnce();
    }
  }

  /**
   * End the current turn and switch to the next player
   */
  private endTurn(): void {
    const nextPlayerIndex = (this.currentPlayerIndex + 1) % this.gameState.players.length;
    if (nextPlayerIndex === 0) {
      this.gameState.turnNumber++;
    }
    this.currentPlayerIndex = nextPlayerIndex;
    this.currentPhase = GamePhase.BEGIN;
    this.gameState.pendingMainPhaseEntry = false;
  }

  // ========================================================================
  // CARD PLAY RULES
  // ========================================================================

  /**
   * Play a card from hand to board
   */
  public playCard(
    playerId: string,
    cardIndex: number,
    targets?: string[],
    destinationId?: string | null
  ): void {
    const player = this.getPlayerById(playerId);
    if (player.playerId !== this.getCurrentPlayer().playerId) {
      throw new Error('Not your turn');
    }

    if (this.currentPhase !== GamePhase.MAIN_1 && this.currentPhase !== GamePhase.MAIN_2) {
      throw new Error(`Cannot play cards during ${this.currentPhase} phase`);
    }

    const card = player.hand[cardIndex];
    if (!card) {
      throw new Error('Card not in hand');
    }

    const cardCost = this.getCardCost(card);
    if (!this.canPayCost(player, cardCost)) {
      throw new Error('Insufficient resources');
    }

    // Validate targets
    this.validateTargets(card, targets ?? []);

    // Remove from hand
    player.hand.splice(cardIndex, 1);
    this.payCardCost(player, cardCost);

    // Place on board based on card type
    const boardCard = this.createBoardCard(card);
    const cardType = (card.type ?? '').toLowerCase() as CardType;
    const entersZoneTapped =
      cardType === CardType.CREATURE ||
      cardType === CardType.ARTIFACT ||
      cardType === CardType.ENCHANTMENT;
    if (entersZoneTapped) {
      boardCard.isTapped = !this.cardEntersUntapped(card);
    }
    switch (cardType) {
      case CardType.CREATURE:
        boardCard.location = this.resolveDeploymentLocation(player, destinationId);
        player.board.creatures.push(boardCard);
        this.logRuleUsage(boardCard, 'enter-play');
        this.triggerAbilities(boardCard, 'play', player, targets);
        break;
      case CardType.SPELL:
        this.resolveSpell(card, player, targets);
        player.graveyard.push(card);
        break;
      case CardType.ARTIFACT:
        boardCard.location = { zone: 'base' };
        player.board.artifacts.push(boardCard);
        this.logRuleUsage(boardCard, 'enter-play');
        this.triggerAbilities(boardCard, 'play', player, targets);
        break;
      case CardType.ENCHANTMENT:
        boardCard.location = { zone: 'base' };
        player.board.enchantments.push(boardCard);
        this.logRuleUsage(boardCard, 'enter-play');
        this.triggerAbilities(boardCard, 'play', player, targets);
        break;
      default:
        throw new Error(`Unsupported card type: ${card.type}`);
    }

    this.recordMove('play_card', card.id, destinationId ?? targets?.[0]);
  }

  /**
   * Validate that targets are legal
   */
  private validateTargets(card: Card, targets: string[]): void {
    if (card.activationProfile?.requiresTarget && targets.length === 0) {
      throw new Error(`${card.name} requires a valid target`);
    }

    if (targets.length > 0) {
      const [primaryTarget] = targets;
      if (!primaryTarget) {
        throw new Error('Invalid target');
      }

      const boardTarget = this.findCardInstance(primaryTarget);
      const playerTarget = this.gameState.players.find((p) => p.playerId === primaryTarget);
      const battlefieldTarget = this.findBattlefieldState(primaryTarget);
      if (!boardTarget && !playerTarget && !battlefieldTarget) {
        throw new Error('Target not found on board, among players, or battlefields');
      }
    }
  }

  private getCardCost(card: Card): CardCost {
    const energy = card.energyCost ?? card.manaCost ?? 0;
    const power = this.normalizePowerCost(card.powerCost);
    return {
      energy,
      power
    };
  }

  private normalizePowerCost(cost?: DomainCost): DomainCost {
    if (!cost) {
      return {};
    }
    return Object.entries(cost).reduce<DomainCost>((acc, [domainKey, value]) => {
      const normalizedValue =
        typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
      if (normalizedValue > 0) {
        acc[domainKey as Domain] = normalizedValue;
      }
      return acc;
    }, {});
  }

  private canPayCost(player: PlayerState, cost: CardCost): boolean {
    return this.tryAllocateRunesForCost(player, cost, false);
  }

  private payCardCost(player: PlayerState, cost: CardCost): void {
    const paid = this.tryAllocateRunesForCost(player, cost, true);
    if (!paid) {
      throw new Error('Insufficient runes');
    }
  }

  // ========================================================================
  // COMBAT
  // ========================================================================

  /**
   * Move a unit between the base and a battlefield
   */
  public moveUnit(playerId: string, creatureInstanceId: string, destinationId: string): void {
    if (!destinationId) {
      throw new Error('Destination is required to move a unit');
    }

    const player = this.getPlayerById(playerId);
    if (player.playerId !== this.getCurrentPlayer().playerId) {
      throw new Error('Not your turn');
    }

    if (this.gameState.status !== GameStatus.IN_PROGRESS) {
      throw new Error('Game is not in progress');
    }

    const creature = player.board.creatures.find((c) => c.instanceId === creatureInstanceId);
    if (!creature) {
      throw new Error('Creature not found');
    }

    if (creature.isTapped) {
      throw new Error('Creature is tapped');
    }

    if (creature.summoned) {
      throw new Error('Creature cannot move the turn it was summoned');
    }

    if (destinationId === 'base') {
      if (
        this.currentPhase !== GamePhase.MAIN_1 &&
        this.currentPhase !== GamePhase.MAIN_2 &&
        this.currentPhase !== GamePhase.COMBAT
      ) {
        throw new Error('Units can only return to base during main or combat phases');
      }
      this.moveUnitToBase(player, creature);
      this.recordMove('move', creature.id, destinationId);
      return;
    }

    const battlefield = this.findBattlefieldState(destinationId);
    if (!battlefield) {
      throw new Error('Battlefield not found');
    }

    if (this.currentPhase !== GamePhase.COMBAT) {
      if (this.currentPhase === GamePhase.MAIN_1) {
        this.enterCombatPhase(true);
      } else {
        throw new Error('Units can only enter battlefields during the combat phase');
      }
    }

    this.moveUnitToBattlefield(player, creature, battlefield);
    this.recordMove('move', creature.id, battlefield.battlefieldId);
  }

  private resolveDeploymentLocation(
    player: PlayerState,
    destinationId?: string | null
  ): CardLocation {
    if (!destinationId || destinationId === 'base') {
      return { zone: 'base' };
    }
    const battlefield = this.findBattlefieldState(destinationId);
    if (!battlefield) {
      throw new Error('Battlefield not found');
    }
    if (battlefield.controller !== player.playerId) {
      throw new Error('You must control a battlefield to deploy there');
    }
    return {
      zone: 'battlefield',
      battlefieldId: battlefield.battlefieldId
    };
  }

  /**
   * Declare an attacker (legacy)
   */
  public declareAttacker(playerId: string, creatureInstanceId: string, destinationId?: string): void {
    if (!destinationId) {
      throw new Error('Attacks require a battlefield destination');
    }
    this.moveUnit(playerId, creatureInstanceId, destinationId);
  }

  /**
   * Resolve combat damage
   */
  public resolveCombat(attackerInstanceId: string, targetId: string, blocked: boolean): void {
    const attacker = this.findCardInstance(attackerInstanceId);
    if (!attacker || attacker.type !== CardType.CREATURE) {
      throw new Error('Invalid attacker');
    }

    const attackerController = this.getPlayerByCard(attacker.instanceId);
    const explicitBattlefield = targetId ? this.findBattlefieldState(targetId) : undefined;
    const targetPlayer = targetId ? this.gameState.players.find((p) => p.playerId === targetId) : undefined;
    const inferredBattlefield =
      explicitBattlefield ??
      (targetPlayer
        ? this.gameState.battlefields.find((battlefield) => battlefield.controller === targetPlayer.playerId)
        : undefined) ??
      this.gameState.battlefields[0];

    if (!inferredBattlefield) {
      throw new Error('Battlefield not found for combat resolution');
    }

    if (inferredBattlefield.lastCombatTurn === this.turnNumber) {
      return;
    }

    if (!blocked) {
      this.applyBattlefieldControl(attackerController, inferredBattlefield, 'combat', {
        sourceCardId: attacker.id
      });
      this.markBattlefieldEngagement(inferredBattlefield);
      return;
    }

    this.markBattlefieldContested(inferredBattlefield, attackerController.playerId);
    this.markBattlefieldEngagement(inferredBattlefield);
  }

  private awardVictoryPoints(
    player: PlayerState,
    amount: number,
    reason: ScoreReason,
    sourceCardId?: string
  ): void {
    if (amount <= 0 || this.gameState.status !== GameStatus.IN_PROGRESS) {
      return;
    }

    const previous = player.victoryPoints;
    player.victoryPoints = Math.min(player.victoryPoints + amount, player.victoryScore);

    this.gameState.scoreLog.push({
      playerId: player.playerId,
      amount: player.victoryPoints - previous,
      reason,
      sourceCardId,
      timestamp: Date.now()
    });

    if (player.victoryPoints >= player.victoryScore) {
      const opponent = this.getOtherPlayer(player);
      this.endGame(player, opponent, 'victory_points');
    }
  }

  // ========================================================================
  // CARD DRAWING
  // ========================================================================

  /**
   * Draw cards from deck
   */
  private drawCards(player: PlayerState, count: number): void {
    for (let i = 0; i < count; i++) {
      if (player.deck.length === 0) {
        this.burnOut(player);
        return;
      }

      const card = player.deck.shift();
      if (card) {
        player.hand.push(card);
      }
    }
  }

  private burnOut(player: PlayerState): void {
    const opponent = this.getOtherPlayer(player);
    this.gameState.scoreLog.push({
      playerId: opponent.playerId,
      amount: 0,
      reason: 'decking',
      sourceCardId: undefined,
      timestamp: Date.now()
    });
    this.endGame(opponent, player, 'burn_out');
  }

  // ========================================================================
  // SPELL RESOLUTION
  // ========================================================================

  /**
   * Resolve spell effects
   */
  private resolveSpell(spell: Card, caster: PlayerState, targets?: string[]): void {
    const targetId = targets?.[0];
    const boardTarget = targetId ? this.findCardInstance(targetId) : undefined;
    const playerTarget = targetId ? this.gameState.players.find((p) => p.playerId === targetId) : undefined;
    const battlefieldTarget = targetId ? this.findBattlefieldState(targetId) : undefined;
    const operations = spell.effectProfile?.operations ?? [];

    if (operations.length > 0) {
      this.executeEffectOperations(operations, caster, {
        source: spell,
        boardTarget,
        playerTarget,
        battlefieldTarget
      });
    } else {
      const profile = spell.activationProfile;
      if (profile) {
        if (profile.actions.includes('draw')) {
          this.drawCards(caster, 1);
        }

        if (profile.actions.includes('buff') && boardTarget) {
          this.applyTemporaryEffect(boardTarget.instanceId, {
            id: `buff_${Date.now()}`,
            affectedCards: [boardTarget.instanceId],
            duration: 1,
            effect: {
              type: 'damage_boost',
              value: 2
            }
          });
        }

        if (profile.actions.includes('kill') && boardTarget) {
          this.damageCreature(boardTarget, boardTarget.currentToughness, spell);
        }

        if (profile.actions.includes('discard') && playerTarget) {
          const discarded = playerTarget.hand.shift();
          if (discarded) {
            playerTarget.graveyard.push(discarded);
          }
        }

      } else {
        const spellName = spell.name.toLowerCase();

        if (spellName.includes('fireball') || spellName.includes('bolt')) {
          const damageTarget = this.ensureDamageableTarget(boardTarget, spell);
          const damage = 3;
          this.damageCreature(damageTarget, damage, spell);
        }

        if (spellName.includes('draw') || spellName.includes('cycle')) {
          this.drawCards(caster, 1);
        }

        if (spellName.includes('buff') || spellName.includes('boost')) {
          if (boardTarget) {
            this.applyTemporaryEffect(boardTarget.instanceId, {
              id: `buff_${Date.now()}`,
              affectedCards: [boardTarget.instanceId],
              duration: 1,
              effect: {
                type: 'damage_boost',
                value: 2
              }
            });
          }
        }

      }
    }

    this.logRuleUsage(spell, 'spell-resolution');
  }

  private executeEffectOperations(
    operations: EffectOperation[],
    caster: PlayerState,
    context: {
      source: Card;
      boardTarget?: BoardCard;
      playerTarget?: PlayerState;
      battlefieldTarget?: BattlefieldState;
    }
  ): void {
    for (const operation of operations) {
      switch (operation.type) {
        case 'draw_cards': {
          const count = Math.max(1, operation.magnitudeHint ?? 1);
          this.drawCards(caster, count);
          break;
        }
        case 'discard_cards': {
          const targetPlayer = context.playerTarget ?? this.getOtherPlayer(caster);
          const discarded = targetPlayer.hand.shift();
          if (discarded) {
            targetPlayer.graveyard.push(discarded);
          }
          break;
        }
        case 'modify_stats': {
          const target = context.boardTarget;
          if (!target) {
            break;
          }
          const amount = operation.magnitudeHint ?? 2;
          const value = operation.targetHint === 'enemy' ? -Math.abs(amount) : Math.abs(amount);
          this.applyTemporaryEffect(target.instanceId, {
            id: `mod_${Date.now()}`,
            affectedCards: [target.instanceId],
            duration: 1,
            effect: {
              type: 'damage_boost',
              value
            }
          });
          break;
        }
        case 'deal_damage': {
          const amount = operation.magnitudeHint ?? 2;
          const damageTarget = this.ensureDamageableTarget(context.boardTarget, context.source);
          this.damageCreature(damageTarget, amount, context.source);
          break;
        }
        case 'heal': {
          const target = context.boardTarget;
          if (!target || target.type !== CardType.CREATURE) {
            break;
          }
          const healAmount = Math.max(1, operation.magnitudeHint ?? 1);
          this.restoreCreature(target, healAmount);
          break;
        }
        case 'remove_permanent': {
          if (context.boardTarget) {
            this.damageCreature(context.boardTarget, context.boardTarget.currentToughness, context.source);
          }
          break;
        }
        case 'gain_resource': {
          const amount = operation.magnitudeHint ?? 1;
          if (amount > 0) {
            const normalized = Math.max(1, Math.round(amount));
            this.channelRunes(caster, normalized);
          } else if (amount < 0) {
            const normalized = Math.max(1, Math.round(Math.abs(amount)));
            this.exhaustRunes(caster, normalized);
          }
          break;
        }
        case 'shield': {
          const target = context.boardTarget;
          if (!target) {
            break;
          }
          this.applyTemporaryEffect(target.instanceId, {
            id: `shield_${Date.now()}`,
            affectedCards: [target.instanceId],
            duration: 1,
            effect: {
              type: 'prevent_damage',
              value: operation.magnitudeHint ?? 1
            }
          });
          break;
        }
        case 'channel_rune': {
          const amount = Math.max(1, operation.magnitudeHint ?? 1);
          this.channelRunes(caster, amount);
          break;
        }
        case 'control_battlefield': {
          const battlefield = this.resolveBattlefieldTargetForControl(
            caster,
            context.battlefieldTarget
          );
          if (!battlefield) {
            break;
          }
          const points = Math.max(1, operation.magnitudeHint ?? 1);
          this.applyBattlefieldControl(caster, battlefield, 'objective', {
            points,
            sourceCardId: context.source.id
          });
          break;
        }
        case 'generic': {
          if (operation.targetHint === 'battlefield') {
            const battlefield = this.resolveBattlefieldTargetForControl(
              caster,
              context.battlefieldTarget
            );
            if (!battlefield) {
              break;
            }
            const points = Math.max(1, operation.magnitudeHint ?? 1);
            this.applyBattlefieldControl(caster, battlefield, 'objective', {
              points,
              sourceCardId: context.source.id
            });
            break;
          }
          this.logRuleUsage(context.source, `unhandled-operation-${operation.type}`);
          break;
        }
        default: {
          this.logRuleUsage(context.source, `unhandled-operation-${operation.type}`);
          break;
        }
      }
    }
  }

  /**
   * Damage a creature
   */
  private damageCreature(creature: BoardCard, amount: number, _source: Card): void {
    if (creature.type !== CardType.CREATURE) {
      throw new Error('Only units (non-gears) can be dealt damage.');
    }

    creature.currentToughness -= amount;

    if (creature.currentToughness <= 0) {
      // Destroy the creature
      this.updateActivationState(creature, false, 'destroyed');
       const battlefieldId =
        creature.location.zone === 'battlefield' ? creature.location.battlefieldId : null;
      const player = this.getPlayerByCard(creature.instanceId);
      const index = player.board.creatures.findIndex((c) => c.instanceId === creature.instanceId);
      if (index !== -1) {
        const destroyed = player.board.creatures.splice(index, 1)[0];
        if (battlefieldId) {
          this.removeContestant(battlefieldId, player.playerId);
        }
        player.graveyard.push(destroyed);
        this.triggerAbilities(destroyed, 'death', player);
      }
    }
  }

  private restoreCreature(creature: BoardCard, amount: number): void {
    if (creature.type !== CardType.CREATURE) {
      return;
    }
    const baseToughness = creature.toughness ?? creature.currentToughness ?? 0;
    if (baseToughness <= 0) {
      return;
    }
    creature.currentToughness = Math.min(baseToughness, (creature.currentToughness ?? 0) + amount);
    this.updateActivationState(creature, true, 'healed');
  }

  // ========================================================================
  // ABILITIES
  // ========================================================================

  /**
   * Trigger card abilities
   */
  private triggerAbilities(
    card: Card,
    triggerType: string,
    player: PlayerState,
    targets?: string[]
  ): void {
    if (!card.abilities || card.abilities.length === 0) {
      if (triggerType === 'play') {
        this.logRuleUsage(card, 'static-entry');
      }
      return;
    }

    for (const ability of card.abilities) {
      if (!ability.triggerType || ability.triggerType === triggerType) {
        this.resolveAbility(ability, card, player, targets);
        if (this.isBoardCard(card)) {
          this.updateActivationState(card, true, `ability-${ability.name}`);
        }
      }
    }
  }

  /**
   * Resolve ability effects
   */
  private resolveAbility(
    ability: CardAbility,
    card: Card,
    player: PlayerState,
    targets?: string[]
  ): void {
    this.logRuleUsage(card, `ability-${ability.name}`);
    // Ability resolution logic based on ability name
    const abilityName = ability.name.toLowerCase();

    if (abilityName.includes('draw')) {
      this.drawCards(player, 1);
    }

    if (abilityName.includes('damage')) {
      if (!targets?.[0]) {
        throw new Error(`${card.name} requires a unit target to resolve its damage ability.`);
      }
      const boardTarget = this.findCardInstance(targets[0]);
      const damageTarget = this.ensureDamageableTarget(boardTarget, card);
      this.damageCreature(damageTarget, 2, card);
    }

  }

  // ========================================================================
  // TEMPORARY EFFECTS
  // ========================================================================

  /**
   * Apply a temporary effect (buff, debuff, etc.)
   */
  private applyTemporaryEffect(cardInstanceId: string, effect: TemporaryEffect): void {
    const player = this.getPlayerByCard(cardInstanceId);
    player.temporaryEffects.push(effect);
    this.updateActivationState(cardInstanceId, true, `effect-${effect.effect.type}`);
  }

  /**
   * Resolve temporary effects that expire
   */
  private resolveTemporaryEffects(player: PlayerState): void {
    player.temporaryEffects = player.temporaryEffects.filter((effect) => {
      effect.duration--;
      if (effect.duration <= 0 && effect.affectedCards) {
        effect.affectedCards.forEach((instanceId) =>
          this.updateActivationState(instanceId, false, 'temporary-effect-expired')
        );
      }
      return effect.duration > 0;
    });
  }

  /**
   * Resolve end-of-turn effects
   */
  private resolveEndOfTurnEffects(player: PlayerState): void {
    const permanents = [
      ...player.board.creatures,
      ...player.board.artifacts,
      ...player.board.enchantments
    ];

    for (const permanent of permanents) {
      if (!permanent.activationState.isStateful && permanent.activationState.active) {
        this.updateActivationState(permanent, false, 'end-step-reset');
      }
    }
  }

  // ========================================================================
  // HELPERS
  // ========================================================================

  private buildDeckFromConfig(entries: DeckCardEntry[]): Card[] {
    if (!entries) {
      return [];
    }
    const cards: Card[] = [];
    for (const entry of entries) {
      const materialized = this.materializeDeckEntry(entry);
      materialized.forEach((card) => {
        const cloned = this.cloneCard(card);
        if (!cloned.instanceId) {
          cloned.instanceId = this.nextCardInstanceId(cloned.id);
        }
        cards.push(cloned);
      });
    }
    return cards;
  }

  private normalizeRuneIdentifier(value?: string | null): string | null {
    if (!value) {
      return null;
    }
    const trimmed = value.trim();
    const legacyMatch = trimmed.match(/^([A-Z]+-\d+)[A-Za-z]$/i);
    if (legacyMatch) {
      return legacyMatch[1];
    }
    return trimmed;
  }

  private normalizeRuneDeck(entries: (DeckCardEntry | RuneCard)[]): RuneCard[] {
    if (!entries || entries.length === 0) {
      return [];
    }
    const runes: RuneCard[] = [];
    for (const entry of entries) {
      if (this.isRuneCardEntry(entry)) {
        runes.push(this.hydrateRuneEntry(entry));
        continue;
      }
      const materialized = this.materializeDeckEntry(entry as DeckCardEntry);
      materialized.forEach((card) => runes.push(this.toRuneCard(card)));
    }
    return runes;
  }

  private hydrateRuneEntry(entry: RuneCard): RuneCard {
    if (entry.cardSnapshot) {
      return {
        ...entry,
        slug: entry.slug ?? entry.cardSnapshot.slug ?? undefined,
        assets: entry.assets ?? entry.cardSnapshot.assets ?? null,
        cardSnapshot: this.cloneCard(entry.cardSnapshot)
      };
    }
    const legacyId = (entry as any).runeId as string | undefined;
    const resolvedId = entry.id ?? legacyId ?? null;
    const normalizedId = this.normalizeRuneIdentifier(resolvedId);
    const identifier = entry.slug ?? normalizedId ?? undefined;
    let catalogCard: Card | null = null;
    if (identifier) {
      try {
        catalogCard = this.lookupCatalogCard(identifier);
      } catch {
        catalogCard = null;
      }
    }
    if (!catalogCard && normalizedId && normalizedId !== identifier) {
      try {
        catalogCard = this.lookupCatalogCard(normalizedId);
      } catch {
        catalogCard = null;
      }
    }
    if (catalogCard) {
      const resolved = this.toRuneCard(catalogCard);
      return {
        ...resolved,
        id: normalizedId ?? resolved.id,
        name: entry.name ?? resolved.name,
        domain: entry.domain ?? resolved.domain,
        energyValue: entry.energyValue ?? resolved.energyValue,
        powerValue: entry.powerValue ?? resolved.powerValue,
        slug: entry.slug ?? resolved.slug,
        assets: entry.assets ?? resolved.assets ?? null,
        cardSnapshot: resolved.cardSnapshot ?? this.cloneCard(catalogCard)
      };
    }
    return {
      ...entry,
      cardSnapshot: null
    };
  }

  private isRuneCardEntry(entry: DeckCardEntry | RuneCard): entry is RuneCard {
    return (
      typeof entry === 'object' &&
      entry !== null &&
      'id' in entry &&
      'name' in entry &&
      !('quantity' in entry)
    );
  }

  private toRuneCard(card: Card): RuneCard {
    if (card.type !== CardType.RUNE) {
      throw new Error(`Card ${card.id} must be a rune when building rune decks`);
    }
    const resolvedPowerValue =
      (card as any).powerValue ??
      (card.powerCost
        ? Object.values(card.powerCost).reduce((sum, value) => sum + (value ?? 0), 0)
        : 1);
    return {
      id: card.id,
      name: card.name,
      domain: card.domain,
      energyValue: (card as any).energyValue ?? card.energyCost ?? 1,
      powerValue: resolvedPowerValue && resolvedPowerValue > 0 ? resolvedPowerValue : 1,
      slug: card.slug,
      assets: card.assets ?? null,
      cardSnapshot: this.cloneCard(card)
    };
  }

  private resolveChampionCard(entry?: DeckCardEntry | null): Card | null {
    if (!entry) {
      return null;
    }
    try {
      const [card] = this.materializeDeckEntry(entry);
      return card ? this.cloneCard(card) : null;
    } catch {
      return null;
    }
  }

  private materializeDeckEntry(entry: DeckCardEntry): Card[] {
    if (typeof entry === 'string') {
      return [this.lookupCatalogCard(entry)];
    }

    if (this.isDeckCard(entry)) {
      return [this.cloneCard(entry)];
    }

    if (this.isDeckReference(entry)) {
      const identifier = entry.cardId ?? entry.slug;
      if (!identifier) {
        throw new Error('Deck entry is missing a card reference');
      }
      const quantity = Math.max(1, entry.quantity ?? 1);
      const baseCard = this.lookupCatalogCard(identifier);
      return Array.from({ length: quantity }).map(() => this.applyOverrides(baseCard, entry.overrides));
    }

    throw new Error('Unsupported deck entry type');
  }

  private isDeckCard(entry: DeckCardEntry): entry is Card {
    return typeof entry === 'object' && entry !== null && 'type' in entry;
  }

  private isDeckReference(entry: DeckCardEntry): entry is DeckCardReference {
    return typeof entry === 'object' && entry !== null && !('type' in entry);
  }

  private lookupCatalogCard(identifier: string): Card {
    const normalized = identifier.toLowerCase();
    const cached = this.catalogCardCache.get(normalized);
    if (cached) {
      return this.cloneCard(cached);
    }

    const record = findCardById(identifier) ?? findCardBySlug(identifier);
    if (!record) {
      throw new Error(`Card not found for identifier: ${identifier}`);
    }

    const card = this.convertRecordToCard(record);
    this.catalogCardCache.set(record.id.toLowerCase(), this.cloneCard(card));
    if (record.slug) {
      this.catalogCardCache.set(record.slug.toLowerCase(), this.cloneCard(card));
    }

    return card;
  }

  private convertRecordToCard(record: EnrichedCardRecord): Card {
    const domain = this.mapDomain(record.colors[0]);
    const powerCost = this.resolvePowerCost(record.cost);
    return {
      id: record.id,
      slug: record.slug,
      name: record.name,
      type: this.mapCardType(record.type),
      rarity: this.mapRarity(record.rarity),
      setName: record.setName,
      colors: record.colors,
      tags: record.tags,
      keywords: record.keywords,
      manaCost: record.cost.energy ?? undefined,
      energyCost: record.cost.energy ?? undefined,
      powerCost,
      domain,
      power: record.might ?? undefined,
      toughness: record.might ?? undefined,
      activationProfile: record.activation,
      rules: record.rules,
      assets: record.assets,
      metadata: {
        setName: record.setName,
        rarity: record.rarity,
        ...(record.behaviorHints ?? {})
      },
      text: record.effect,
      flavorText: record.flavor,
      effectProfile: record.effectProfile
    };
  }

  private cloneCard(card: Card): Card {
    return {
      ...card,
      instanceId: card.instanceId,
      powerCost: card.powerCost ? { ...card.powerCost } : undefined,
      abilities: card.abilities ? card.abilities.map((ability) => ({ ...ability })) : undefined,
      keywords: card.keywords ? [...card.keywords] : undefined,
      tags: card.tags ? [...card.tags] : undefined,
      colors: card.colors ? [...card.colors] : undefined,
      activationProfile: card.activationProfile
        ? {
            ...card.activationProfile,
            triggers: [...card.activationProfile.triggers],
            actions: [...card.activationProfile.actions],
            reactionWindows: [...card.activationProfile.reactionWindows]
          }
        : undefined,
      rules: card.rules ? card.rules.map((rule) => ({ ...rule })) : undefined,
      metadata: card.metadata ? { ...card.metadata } : undefined,
      assets: card.assets ? { ...card.assets } : undefined,
      effectProfile: card.effectProfile
        ? {
            ...card.effectProfile,
            operations: card.effectProfile.operations.map((operation) => ({ ...operation }))
          }
        : undefined
    };
  }

  private applyOverrides(card: Card, overrides?: Partial<Card>): Card {
    if (!overrides) {
      return this.cloneCard(card);
    }

    return this.cloneCard({
      ...card,
      ...overrides,
      powerCost: overrides.powerCost ?? card.powerCost,
      abilities: overrides.abilities ?? card.abilities,
      activationProfile: overrides.activationProfile ?? card.activationProfile,
      rules: overrides.rules ?? card.rules
    });
  }

  private mapCardType(rawType?: string | null): CardType {
    switch ((rawType || '').toLowerCase()) {
      case 'unit':
      case 'creature':
      case 'champion':
      case 'legend':
        return CardType.CREATURE;
      case 'gear':
      case 'artifact':
      case 'equipment':
        return CardType.ARTIFACT;
      case 'enchantment':
      case 'battlefield':
      case 'field':
        return CardType.ENCHANTMENT;
      case 'rune':
        return CardType.RUNE;
      default:
        return CardType.SPELL;
    }
  }

  private mapDomain(color?: string): Domain | undefined {
    switch ((color || '').toLowerCase()) {
      case 'fury':
        return Domain.FURY;
      case 'calm':
        return Domain.CALM;
      case 'mind':
        return Domain.MIND;
      case 'body':
        return Domain.BODY;
      case 'chaos':
        return Domain.CHAOS;
      case 'order':
        return Domain.ORDER;
      default:
        return undefined;
    }
  }

  private mapRarity(raw?: string | null): CardRarity | undefined {
    switch ((raw || '').toLowerCase()) {
      case 'common':
        return CardRarity.COMMON;
      case 'uncommon':
        return CardRarity.UNCOMMON;
      case 'rare':
        return CardRarity.RARE;
      case 'legendary':
        return CardRarity.LEGENDARY;
      case 'epic':
        return CardRarity.EPIC;
      case 'promo':
        return CardRarity.PROMO;
      case 'showcase':
        return CardRarity.SHOWCASE;
      default:
        return undefined;
    }
  }

  private enqueuePrompt(
    type: PromptType,
    playerId: string,
    data: Record<string, unknown>
  ): GamePrompt {
    const prompt: GamePrompt = {
      id: `${type}_${++this.promptCounter}_${Date.now()}`,
      type,
      playerId,
      data,
      resolved: false,
      createdAt: Date.now()
    };
    this.gameState.prompts.push(prompt);
    return prompt;
  }

  private findPrompt(type: PromptType, playerId: string): GamePrompt {
    const prompt = this.gameState.prompts.find(
      (entry) => entry.type === type && entry.playerId === playerId && !entry.resolved
    );
    if (!prompt) {
      throw new Error(`No pending ${type} prompt for player ${playerId}`);
    }
    return prompt;
  }

  private resolvePrompt(prompt: GamePrompt, resolution: Record<string, unknown>): void {
    prompt.resolved = true;
    prompt.resolution = resolution;
    prompt.resolvedAt = Date.now();
    this.tryAutoAdvanceFromBeginPhase();
  }

  private promptsResolved(type?: PromptType): boolean {
    return this.gameState.prompts
      .filter((prompt) => (type ? prompt.type === type : true))
      .every((prompt) => prompt.resolved);
  }

  private openPriorityWindow(type: PriorityWindow['type'], holder: string, event?: string): void {
    const timestamp = Date.now();
    this.gameState.priorityWindow = {
      id: `priority_${timestamp}_${Math.random()}`,
      type,
      holder,
      openedAt: timestamp,
      event
    };
  }

  private closePriorityWindow(): void {
    this.gameState.priorityWindow = null;
  }

  private recordSnapshot(reason: string): void {
    const timestamp = Date.now();
    const summary = {
      currentPlayer: this.gameState.players[this.currentPlayerIndex]?.playerId ?? null,
      scores: this.gameState.players.map((player) => ({
        playerId: player.playerId,
        victoryPoints: player.victoryPoints,
        handSize: player.hand.length,
        deckCount: player.deck.length,
        boardCount:
          player.board.creatures.length +
          player.board.artifacts.length +
          player.board.enchantments.length
      })),
      phase: this.currentPhase,
      status: this.gameState.status
    };

    this.gameState.snapshots.push({
      turn: this.turnNumber,
      phase: this.currentPhase,
      timestamp,
      reason,
      summary: JSON.stringify(summary)
    });
  }

  private recycleCards(player: PlayerState, cards: Card[]): void {
    if (cards.length === 0) {
      return;
    }
    for (const card of cards) {
      player.deck.push(card);
    }
  }

  private recycleRune(player: PlayerState, rune: RuneCard): void {
    const index = player.channeledRunes.indexOf(rune);
    if (index >= 0) {
      const [removed] = player.channeledRunes.splice(index, 1);
      removed.isTapped = false;
      player.runeDeck.push(removed);
      return;
    }
    player.runeDeck.push({
      ...rune,
      isTapped: false
    });
  }

  private resolvePowerCost(cost?: CardCostProfile): DomainCost | undefined {
    if (cost?.powerCost && cost.powerType && cost.powerCost > 0) {
      const domain = this.mapDomain(cost.powerType);
      if (domain) {
        return { [domain]: cost.powerCost };
      }
    }
    if (cost?.powerSymbols && cost.powerSymbols.length > 0) {
      const resolved = this.mapPowerSymbols(cost.powerSymbols);
      return this.hasDomainCostEntries(resolved) ? resolved : undefined;
    }
    return undefined;
  }

  private mapPowerSymbols(symbols: string[]): DomainCost {
    return (symbols || []).reduce<DomainCost>((acc, symbol) => {
      const domain = this.symbolToDomain(symbol);
      if (domain) {
        acc[domain] = (acc[domain] ?? 0) + 1;
      }
      return acc;
    }, {});
  }

  private hasDomainCostEntries(cost: DomainCost): boolean {
    return Object.values(cost).some((value) => {
      const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 0;
      return numeric > 0;
    });
  }

  private symbolToDomain(symbol: string): Domain | undefined {
    switch (symbol.toLowerCase()) {
      case 'r':
        return Domain.FURY;
      case 'g':
        return Domain.CALM;
      case 'b':
        return Domain.MIND;
      case 'o':
        return Domain.BODY;
      case 'p':
        return Domain.CHAOS;
      case 'y':
        return Domain.ORDER;
      default:
        return undefined;
    }
  }

  private updateActivationState(target: BoardCard | string, active: boolean, reason: string): void {
    const boardCard = typeof target === 'string' ? this.findCardInstance(target) : target;
    if (!boardCard) {
      return;
    }

    boardCard.activationState.active = active;
    boardCard.activationState.lastChangedAt = Date.now();
    boardCard.activationState.history.push({
      at: boardCard.activationState.lastChangedAt,
      reason,
      active
    });
  }

  private logRuleUsage(card: Card | BoardCard, context: string): void {
    if (!card.rules || card.rules.length === 0) {
      return;
    }

    if (!this.isBoardCard(card)) {
      return;
    }

    const timestamp = Date.now();
    card.ruleLog.push(
      ...card.rules.map((clause) => ({
        clauseId: clause.id,
        resolvedAt: timestamp,
        context
      }))
    );
  }

  private isBoardCard(card: Card | BoardCard): card is BoardCard {
    return typeof (card as BoardCard).instanceId === 'string';
  }

  private getCurrentPlayer(): PlayerState {
    return this.gameState.players[this.currentPlayerIndex];
  }

  private getOtherPlayer(player: PlayerState): PlayerState {
    return this.gameState.players.find((p) => p.playerId !== player.playerId)!;
  }

  private getPlayerById(playerId: string): PlayerState {
    const player = this.gameState.players.find((p) => p.playerId === playerId);
    if (!player) {
      throw new Error(`Player ${playerId} not found`);
    }
    return player;
  }

  private getPlayerByCard(cardInstanceId: string): PlayerState {
    for (const player of this.gameState.players) {
      const found =
        player.board.creatures.find((c) => c.instanceId === cardInstanceId) ||
        player.board.artifacts.find((c) => c.instanceId === cardInstanceId) ||
        player.board.enchantments.find((c) => c.instanceId === cardInstanceId);
      if (found) return player;
    }
    throw new Error(`Card instance ${cardInstanceId} not found`);
  }

  private findCardInstance(cardInstanceId: string): BoardCard | undefined {
    for (const player of this.gameState.players) {
      const found =
        player.board.creatures.find((c) => c.instanceId === cardInstanceId) ||
        player.board.artifacts.find((c) => c.instanceId === cardInstanceId) ||
        player.board.enchantments.find((c) => c.instanceId === cardInstanceId);
      if (found) return found;
    }
    return undefined;
  }

  private ensureDamageableTarget(target: BoardCard | undefined, source: Card): BoardCard {
    if (!target) {
      throw new Error(`${source.name} requires a unit target to deal damage.`);
    }
    if (target.type !== CardType.CREATURE) {
      throw new Error(`${source.name} can only damage units (non-gears).`);
    }
    return target;
  }

  private createBoardCard(card: Card): BoardCard {
    const activationTemplate = this.cardActivationTemplates[card.id];
    const initialActive = activationTemplate?.isStateful ?? Boolean(card.activationProfile?.stateful);
    const timestamp = Date.now();
    const resolvedInstanceId = card.instanceId ?? this.nextCardInstanceId(card.id);
    const cloned = this.cloneCard(card);
    cloned.instanceId = resolvedInstanceId;
    return {
      ...cloned,
      instanceId: resolvedInstanceId,
      currentToughness: card.toughness || 0,
      isTapped: false,
      summoned: true,
      counters: {},
      activationState: {
        cardId: card.id,
        isStateful: activationTemplate?.isStateful ?? Boolean(card.activationProfile?.stateful),
        active: initialActive,
        lastChangedAt: timestamp,
        history: [
          {
            at: timestamp,
            reason: 'enter-play',
            active: initialActive
          }
        ]
      },
      ruleLog: [],
      location: {
        zone: 'base'
      }
    };
  }

  private cardEntersUntapped(card: Card): boolean {
    const metadata = (card.metadata ?? {}) as Record<string, unknown>;
    if (metadata.enterUntapped === true || metadata.enterReady === true) {
      return true;
    }
    const keywords = (card.keywords ?? []).map((kw) => kw?.toLowerCase().trim());
    if (keywords.some((kw) => kw === 'untapped' || kw === 'ready' || kw === 'enter untapped')) {
      return true;
    }
    const textFragments: string[] = [];
    if (card.text) {
      textFragments.push(card.text);
    }
    if (card.rules) {
      card.rules.forEach((rule) => {
        if (rule?.text) {
          textFragments.push(rule.text);
        }
      });
    }
    if (card.abilities) {
      card.abilities.forEach((ability) => {
        if (ability?.description) {
          textFragments.push(ability.description);
        }
      });
    }
    const untappedPattern =
      /\b(enters?|enter)\b[^.]*\b(untapped|ready)\b/i;
    return textFragments.some((text) => untappedPattern.test(text));
  }

  private shuffle<T>(items: T[]): void {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
  }

  private createEmptyPowerPool(): Record<Domain, number> {
    return {
      [Domain.FURY]: 0,
      [Domain.CALM]: 0,
      [Domain.MIND]: 0,
      [Domain.BODY]: 0,
      [Domain.CHAOS]: 0,
      [Domain.ORDER]: 0
    };
  }

  private generateFallbackRuneDeck(): RuneCard[] {
    const domains = Object.values(Domain);
    return Array.from({ length: this.RUNE_DECK_SIZE }).map((_, index) => {
      const domain = domains[index % domains.length];
      return {
        id: `fallback_rune_${index}`,
        name: `${domain} Rune`,
        domain,
        energyValue: 1,
        powerValue: 1
      };
    });
  }

  private generateFallbackBattlefields(playerId: string): Card[] {
    return [
      {
        id: `fallback_battlefield_${playerId}`,
        slug: `fallback_battlefield_${playerId}`,
        name: 'Training Grounds',
        type: CardType.ENCHANTMENT,
        rarity: CardRarity.COMMON,
        text: 'Auto-generated battlefield placeholder.',
        flavorText: null,
        setName: null,
        colors: [],
        tags: ['Battlefield'],
        keywords: [],
        manaCost: 0,
        energyCost: 0,
        powerCost: undefined,
        domain: undefined,
        power: 0,
        toughness: 0,
        abilities: [],
        activationProfile: undefined,
        rules: [],
        assets: undefined,
        metadata: {
          generated: true
        },
        effectProfile: undefined
      }
    ];
  }

  private createBattlefieldStateFromCard(card: Card, ownerId: string): BattlefieldState {
    return {
      battlefieldId: card.id,
      slug: card.slug,
      name: card.name,
      card: this.cloneCard(card),
      ownerId,
      controller: undefined,
      contestedBy: [],
      lastCombatTurn: undefined
    };
  }

  private cloneBattlefieldState(state: BattlefieldState): BattlefieldState {
    return {
      battlefieldId: state.battlefieldId,
      slug: state.slug,
      name: state.name,
      card: state.card ? this.cloneCard(state.card) : undefined,
      ownerId: state.ownerId,
      controller: state.controller,
      contestedBy: [...state.contestedBy],
      lastConqueredTurn: state.lastConqueredTurn,
      lastHoldTurn: state.lastHoldTurn,
      lastCombatTurn: state.lastCombatTurn
    };
  }

  private findBattlefieldState(identifier: string): BattlefieldState | undefined {
    return this.gameState.battlefields.find(
      (battlefield) =>
        battlefield.battlefieldId === identifier ||
        (battlefield.slug && battlefield.slug === identifier) ||
        battlefield.name === identifier
    );
  }

  private resolveBattlefieldTargetForControl(
    player: PlayerState,
    explicit?: BattlefieldState
  ): BattlefieldState | undefined {
    if (explicit) {
      return explicit;
    }
    const enemyControlled = this.gameState.battlefields.find(
      (battlefield) => battlefield.controller && battlefield.controller !== player.playerId
    );
    if (enemyControlled) {
      return enemyControlled;
    }
    const neutral = this.gameState.battlefields.find((battlefield) => !battlefield.controller);
    if (neutral) {
      return neutral;
    }
    return this.gameState.battlefields[0];
  }

  private applyBattlefieldControl(
    player: PlayerState,
    battlefield: BattlefieldState,
    reason: ScoreReason,
    options?: { points?: number; sourceCardId?: string }
  ): void {
    const alreadyControlled = battlefield.controller === player.playerId;
    battlefield.controller = player.playerId;
    battlefield.contestedBy = [];
    if (alreadyControlled) {
      battlefield.lastHoldTurn = this.turnNumber;
    } else {
      battlefield.lastConqueredTurn = this.turnNumber;
      battlefield.lastHoldTurn = undefined;
    }
    const sourceCard = options?.sourceCardId ?? battlefield.card?.id ?? battlefield.battlefieldId;
    const amount = Math.max(1, options?.points ?? 1);
    this.awardVictoryPoints(player, amount, reason, sourceCard);
  }

  private markBattlefieldContested(battlefield: BattlefieldState, contestantId: string): void {
    if (!battlefield.contestedBy.includes(contestantId)) {
      battlefield.contestedBy.push(contestantId);
    }
  }

  private markBattlefieldEngagement(battlefield: BattlefieldState): void {
    battlefield.lastCombatTurn = this.turnNumber;
  }

  private removeContestant(battlefieldId: string, contestantId: string): void {
    const battlefield = this.findBattlefieldState(battlefieldId);
    if (!battlefield) {
      return;
    }
    const stillPresent = this.getUnitsOnBattlefield(battlefieldId).some((unit) => {
      const owner = this.getPlayerByCard(unit.instanceId);
      return owner.playerId === contestantId;
    });
    if (!stillPresent) {
      battlefield.contestedBy = battlefield.contestedBy.filter((entry) => entry !== contestantId);
    }
  }

  private getUnitsOnBattlefield(battlefieldId: string): BoardCard[] {
    const units: BoardCard[] = [];
    for (const player of this.gameState.players) {
      for (const creature of player.board.creatures) {
        if (
          creature.location.zone === 'battlefield' &&
          creature.location.battlefieldId === battlefieldId
        ) {
          units.push(creature);
        }
      }
    }
    return units;
  }

  private tapMovedUnit(creature: BoardCard): void {
    creature.isTapped = true;
    this.updateActivationState(creature, true, 'move');
  }

  private moveUnitToBase(player: PlayerState, creature: BoardCard): void {
    if (creature.location.zone === 'base') {
      throw new Error('Unit is already at your base');
    }
    const previousBattlefield = creature.location.battlefieldId;
    creature.location = { zone: 'base' };
    this.tapMovedUnit(creature);
    this.removeContestant(previousBattlefield, player.playerId);
  }

  private moveUnitToBattlefield(
    player: PlayerState,
    creature: BoardCard,
    battlefield: BattlefieldState
  ): void {
    if (
      creature.location.zone === 'battlefield' &&
      creature.location.battlefieldId === battlefield.battlefieldId
    ) {
      throw new Error('Unit is already at that battlefield');
    }

    const previousLocation =
      creature.location.zone === 'battlefield' ? creature.location.battlefieldId : null;

    creature.location = {
      zone: 'battlefield',
      battlefieldId: battlefield.battlefieldId
    };
    this.tapMovedUnit(creature);

    if (previousLocation) {
      this.removeContestant(previousLocation, player.playerId);
    }

    const enemyUnits = this.getUnitsOnBattlefield(battlefield.battlefieldId).filter((unit) => {
      const owner = this.getPlayerByCard(unit.instanceId);
      return owner.playerId !== player.playerId;
    });
    const blocked = enemyUnits.length > 0;
    this.resolveCombat(creature.instanceId, battlefield.battlefieldId, blocked);
  }

  private untapAllPermanents(player: PlayerState): void {
    for (const creature of player.board.creatures) {
      creature.isTapped = false;
    }
    for (const artifact of player.board.artifacts) {
      artifact.isTapped = false;
    }
    for (const enchantment of player.board.enchantments) {
      enchantment.isTapped = false;
    }
  }

  private readySummonedCreatures(player: PlayerState): void {
    for (const creature of player.board.creatures) {
      if (creature.summoned) {
        creature.summoned = false;
      }
    }
  }

  private syncLegacyMana(player: PlayerState): void {
    player.mana = player.resources.energy;
    player.maxMana = player.resources.energy;
  }

  private recordMove(
    action: GameMove['action'],
    cardIdOrIndex?: string,
    targetId?: string
  ): void {
    this.gameState.moveHistory.push({
      playerIndex: this.currentPlayerIndex,
      turn: this.turnNumber,
      phase: this.currentPhase,
      action,
      cardId: cardIdOrIndex,
      targetId,
      timestamp: Date.now()
    });
  }

  /**
   * End the game and determine a winner
   */
  private endGame(
    winner: PlayerState,
    _loser: PlayerState,
    reason: MatchResult['reason']
  ): void {
    this.gameState.status = GameStatus.WINNER_DETERMINED;
    this.gameState.winner = winner.playerId;
    this.gameState.endReason = reason;
    this.recordSnapshot('match-end');
  }

  // ========================================================================
  // PUBLIC GETTERS
  // ========================================================================

  public getGameState(): GameState {
    return this.gameState;
  }

  public getPlayerState(playerId: string): PlayerState {
    return this.getPlayerById(playerId);
  }

  public getCurrentPlayerState(): PlayerState {
    return this.getCurrentPlayer();
  }

  public canPlayerAct(playerId: string): boolean {
    return (
      this.gameState.status === GameStatus.IN_PROGRESS &&
      this.getCurrentPlayer().playerId === playerId
    );
  }

  public getMatchResult(): MatchResult | null {
    if (this.gameState.status !== GameStatus.WINNER_DETERMINED) {
      return null;
    }

    const winner = this.gameState.players.find((p) => p.playerId === this.gameState.winner);
    const loser = this.gameState.players.find((p) => p.playerId !== this.gameState.winner);

    if (!winner || !loser) {
      return null;
    }

    return {
      matchId: this.gameState.matchId,
      winner: winner.playerId,
      loser: loser.playerId,
      reason: this.gameState.endReason ?? 'victory_points',
      duration: Date.now() - this.gameState.timestamp,
      turns: this.turnNumber,
      moves: this.gameState.moveHistory
    };
  }

  get turnNumber(): number {
    return this.gameState.turnNumber;
  }

  get currentPhase(): GamePhase {
    return this.gameState.currentPhase;
  }

  set currentPhase(phase: GamePhase) {
    this.gameState.currentPhase = phase;
  }

  get currentPlayerIndex(): number {
    return this.gameState.currentPlayerIndex;
  }

  set currentPlayerIndex(index: number) {
    this.gameState.currentPlayerIndex = index;
  }

  get status(): GameStatus {
    return this.gameState.status;
  }
}
