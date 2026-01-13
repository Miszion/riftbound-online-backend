import {
  ActivationProfile,
  CardAbility,
  CardActivationState,
  CardAssetInfo,
  CardCostProfile,
  EffectOperation,
  EffectProfile,
  EnrichedCardRecord,
  RuleClause,
  TokenSpec,
  buildActivation,
  buildActivationStateIndex,
  buildEffectProfile,
  findCardById,
  findCardByName,
  findCardBySlug,
  parseAssaultBonus,
  parseTokenSpecs
} from './card-catalog';
import {
  ChampionAbilityCost,
  DomainKey,
  canSatisfyChampionCost,
  hasManualActivation,
  parseChampionAbilityCost,
  summarizeChampionCost
} from './champion-utils';

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
  isTapped?: boolean;
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
  championLegendStatus?: ChampionAbilityRuntimeState | null;
  championLeaderStatus?: ChampionAbilityRuntimeState | null;
  championLeaderDeployed?: boolean;
}

export interface ChampionAbilityRuntimeState {
  canActivate: boolean;
  hasManualActivation: boolean;
  reason?: string | null;
  cost: ChampionAbilityCost;
  costSummary: string;
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

interface AccelerateCost {
  energy: number;
  rune?: Domain;
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

export type ScoreReason =
  | 'combat'
  | 'objective'
  | 'support'
  | 'decking'
  | 'concede'
  | 'timeout'
  | 'hold';

export type PromptType =
  | 'mulligan'
  | 'action'
  | 'target'
  | 'reaction'
  | 'priority'
  | 'battlefield'
  | 'coin_flip'
  | 'discard';

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
  type: 'main' | 'reaction' | 'showdown' | 'combat';
  holder: string;
  openedAt: number;
  event?: string;
  expiresAt?: number;
}

export interface CombatContext {
  battlefieldId: string;
  initiatedBy: string;
  defendingPlayerId?: string | null;
  attackingUnitIds: string[];
  defendingUnitIds: string[];
  priorityStage: 'action' | 'reaction';
  lastActionPlayerId?: string;
  actionPasses: number;
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

type EffectOperationContext = {
  source: Card;
  boardTarget?: BoardCard;
  playerTarget?: PlayerState;
  battlefieldTarget?: BattlefieldState;
  abilityName?: string | null;
  triggerType?: string | null;
  targets?: string[] | null;
};

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

const ABILITY_KEYWORD_PATTERN = /^\s*\[(?<keyword>[^\]]+)\]\s*[—-]\s*(?<body>.+)$/i;
const SUPPORTED_KEYWORD_TRIGGERS: Record<string, CardAbility['triggerType']> = {
  deathknell: 'death'
};

export interface GameState {
  matchId: string;
  players: PlayerState[];
  currentPlayerIndex: number;
  currentPhase: GamePhase;
  turnNumber: number;
  status: GameStatus;
  outcomePersisted?: boolean;
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
  focusPlayerId?: string | null;
  combatContext?: CombatContext | null;
  pendingEffects: PendingEffect[];
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

interface EffectContextSnapshot {
  sourceCardId?: string | null;
  sourceInstanceId?: string | null;
  boardTargetInstanceId?: string | null;
  battlefieldId?: string | null;
  targetIds?: string[] | null;
}

interface ReturnCriteria {
  allowUnits: boolean;
  allowGear: boolean;
  friendlyOnly: boolean;
  enemyOnly: boolean;
  battlefieldOnly: boolean;
  maxMight?: number | null;
  optional: boolean;
  globalAll: boolean;
  minTargets: number;
  maxTargets: number;
}

interface PendingEffect {
  id: string;
  type: 'discard' | 'target';
  casterId: string;
  targetPlayerId: string;
  operations?: EffectOperation[];
  nextIndex?: number;
  context?: EffectContextSnapshot;
  metadata?: Record<string, unknown>;
}

export interface MatchResult {
  matchId: string;
  winner: string;
  loser: string;
  reason: 'victory_points' | 'burn_out' | 'concede' | 'timeout';
  duration: number;
  turns: number;
  moves: GameMove[];
  players?: { playerId: string; name?: string | null }[];
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
  lastHoldScoreTurn?: number;
  combatTurnByPlayer?: Record<string, number>;
  effectState?: Record<string, unknown>;
}

export interface BattlefieldPresence {
  playerId: string;
  totalMight: number;
  unitCount: number;
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
      turnSequenceStep: null,
      focusPlayerId: null,
      combatContext: null,
      pendingEffects: []
    };
  }

  public commenceBattle(playerId: string, battlefieldId: string): void {
    const player = this.getPlayerById(playerId);
    if (player.playerId !== this.getCurrentPlayer().playerId) {
      throw new Error('Not your turn');
    }
    if (this.gameState.status !== GameStatus.IN_PROGRESS) {
      throw new Error('Game is not in progress');
    }
    if (this.gameState.combatContext) {
      throw new Error('A combat is already in progress');
    }
    const battlefield = this.findBattlefieldState(battlefieldId);
    if (!battlefield) {
      throw new Error('Battlefield not found');
    }
    if (this.hasPlayerBattledOnBattlefieldThisTurn(player.playerId, battlefield)) {
      throw new Error('You already resolved combat on this battlefield this turn.');
    }
    const units = this.getUnitsOnBattlefield(battlefieldId);
    const friendlyUnits = units.filter(
      (unit) => this.getPlayerByCard(unit.instanceId).playerId === player.playerId
    );
    if (friendlyUnits.length === 0) {
      throw new Error('You must have a unit on this battlefield to commence combat.');
    }
    this.initiateBattlefieldEngagement(player, battlefield);
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
    const ensureBoardCardRuntimeState = (card: BoardCard) => {
      const activationTemplate = engine.cardActivationTemplates[card.id];
      const fallbackStateful =
        activationTemplate?.isStateful ?? Boolean(card.activationProfile?.stateful);
      if (!card.activationState || typeof card.activationState !== 'object') {
        card.activationState = {
          cardId: card.id,
          isStateful: fallbackStateful,
          active: fallbackStateful,
          lastChangedAt: Date.now(),
          history: []
        };
      } else {
        if (!card.activationState.cardId) {
          card.activationState.cardId = card.id;
        }
        if (typeof card.activationState.isStateful !== 'boolean') {
          card.activationState.isStateful = fallbackStateful;
        }
        if (typeof card.activationState.active !== 'boolean') {
          card.activationState.active = card.activationState.isStateful;
        }
        if (typeof card.activationState.lastChangedAt !== 'number') {
          card.activationState.lastChangedAt = Date.now();
        }
        if (!Array.isArray(card.activationState.history)) {
          card.activationState.history = [];
        }
      }
      if (!Array.isArray(card.ruleLog)) {
        card.ruleLog = [];
      }
    };
    if (!Array.isArray(engine.gameState.prompts)) {
      engine.gameState.prompts = [];
    }
    if (!Array.isArray(engine.gameState.snapshots)) {
      engine.gameState.snapshots = [];
    }
    if (!Array.isArray(engine.gameState.duelLog)) {
      engine.gameState.duelLog = [];
    }
    if (!Array.isArray(engine.gameState.chatLog)) {
      engine.gameState.chatLog = [];
    }
    if (!Array.isArray(engine.gameState.scoreLog)) {
      engine.gameState.scoreLog = [];
    }
    if (!Array.isArray(engine.gameState.moveHistory)) {
      engine.gameState.moveHistory = [];
    }
    if (!Array.isArray(engine.gameState.battlefields)) {
      engine.gameState.battlefields = [];
    }
    if (!Array.isArray(engine.gameState.pendingEffects)) {
      engine.gameState.pendingEffects = [];
    }
    engine.promptCounter = engine.gameState.prompts.length;
    if (typeof engine.gameState.pendingMainPhaseEntry !== 'boolean') {
      engine.gameState.pendingMainPhaseEntry = false;
    }
    if (!engine.gameState.turnSequenceStep) {
      engine.gameState.turnSequenceStep = null;
    }
    if (typeof engine.gameState.focusPlayerId === 'undefined') {
      engine.gameState.focusPlayerId = null;
    }
    if (!engine.gameState.combatContext) {
      engine.gameState.combatContext = null;
    }
    for (const player of engine.gameState.players) {
      if (typeof player.championLeaderDeployed !== 'boolean') {
        player.championLeaderDeployed = false;
      }
      if (!Array.isArray(player.hand)) {
        player.hand = [];
      }
      if (!Array.isArray(player.deck)) {
        player.deck = [];
      }
      if (!Array.isArray(player.runeDeck)) {
        player.runeDeck = [];
      }
      if (!Array.isArray(player.channeledRunes)) {
        player.channeledRunes = [];
      }
      if (!Array.isArray(player.graveyard)) {
        player.graveyard = [];
      }
      if (!Array.isArray(player.exile)) {
        player.exile = [];
      }
      if (!Array.isArray(player.temporaryEffects)) {
        player.temporaryEffects = [];
      }
      if (!Array.isArray(player.battlefieldPool)) {
        player.battlefieldPool = [];
      }
      if (!player.board) {
        player.board = {
          playerId: player.playerId,
          creatures: [],
          artifacts: [],
          enchantments: []
        };
      } else {
        if (!Array.isArray(player.board.creatures)) {
          player.board.creatures = [];
        }
        if (!Array.isArray(player.board.artifacts)) {
          player.board.artifacts = [];
        }
        if (!Array.isArray(player.board.enchantments)) {
          player.board.enchantments = [];
        }
      }
      player.board.creatures.forEach(ensureBoardCardRuntimeState);
      player.board.artifacts.forEach(ensureBoardCardRuntimeState);
      player.board.enchantments.forEach(ensureBoardCardRuntimeState);
      if (!player.resources) {
        player.resources = {
          energy: 0,
          universalPower: 0,
          power: engine.createEmptyPowerPool()
        };
      } else {
        player.resources.energy = Number(player.resources.energy ?? 0);
        player.resources.universalPower = Number(player.resources.universalPower ?? 0);
        player.resources.power = {
          ...engine.createEmptyPowerPool(),
          ...(player.resources.power ?? {})
        } as Record<Domain, number>;
      }
    }
    for (const battlefield of engine.gameState.battlefields) {
      if (!Array.isArray(battlefield.contestedBy)) {
        battlefield.contestedBy = [];
      }
      if (!battlefield.combatTurnByPlayer) {
        battlefield.combatTurnByPlayer = {};
      }
      if (!battlefield.effectState) {
        battlefield.effectState = {};
      }
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
      championLeader: null,
      championLeaderDeployed: false
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
    this.initializeBattlefieldEffects(orderedSelections);
    this.gameState.status = GameStatus.MULLIGAN;
    this.recordSnapshot('battlefields-ready');
    this.startMulliganPhase();
  }

  private initializeBattlefieldEffects(battlefields: BattlefieldState[]): void {
    for (const battlefield of battlefields) {
      const owner = this.getPlayerById(battlefield.ownerId);
      this.triggerBattlefieldAbility(battlefield, 'setup', owner);
    }
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

  public submitDiscardSelection(
    playerId: string,
    promptId: string,
    cardInstanceIds: string[]
  ): void {
    const prompt = this.gameState.prompts.find(
      (entry) => entry.id === promptId && entry.type === 'discard'
    );
    if (!prompt) {
      throw new Error('Discard prompt not found');
    }
    if (prompt.playerId !== playerId) {
      throw new Error('Discard prompt does not belong to this player');
    }
    const pendingIndex = this.gameState.pendingEffects.findIndex(
      (entry) => entry.id === promptId && entry.type === 'discard'
    );
    if (pendingIndex === -1) {
      throw new Error('No pending discard effect to resolve');
    }
    const pending = this.gameState.pendingEffects[pendingIndex];
    if (!pending.operations || pending.nextIndex === undefined || !pending.context) {
      throw new Error('Pending discard effect is missing execution context');
    }
    const player = this.getPlayerById(playerId);
    const discardCount = Math.max(
      1,
      Number(
        (prompt.data?.count as number | undefined) ?? (pending.metadata?.count as number | undefined) ?? 1
      )
    );
    const uniqueSelections = Array.from(new Set(cardInstanceIds));
    const discarded: Card[] = [];
    for (const instanceId of uniqueSelections) {
      if (discarded.length >= discardCount) {
        break;
      }
      const index = player.hand.findIndex((card) => card.instanceId === instanceId);
      if (index === -1) {
        continue;
      }
      const [card] = player.hand.splice(index, 1);
      if (card) {
        discarded.push(card);
      }
    }
    while (discarded.length < discardCount && player.hand.length > 0) {
      const card = player.hand.shift();
      if (card) {
        discarded.push(card);
      }
    }
    const contextSnapshot = this.restoreEffectContext(pending.context);
    discarded.forEach((card) => {
      player.graveyard.push(card);
      const playerName = this.resolvePlayerName(player.playerId) ?? 'Player';
      const suffix = this.describeEffectSuffix(contextSnapshot);
      this.addDuelLogEntry({
        playerId: player.playerId,
        message: `${playerName} discards ${card.name ?? 'a card'}${suffix}.`,
        tone: 'warning'
      });
    });
    this.resolvePrompt(prompt, {
      discarded: discarded.length
    });
    this.gameState.pendingEffects.splice(pendingIndex, 1);
    const caster = this.getPlayerById(pending.casterId);
    this.executeEffectOperations(pending.operations, caster, contextSnapshot, pending.nextIndex + 1);
  }

  public submitTargetSelection(playerId: string, promptId: string, selectionIds: string[]): void {
    const prompt = this.gameState.prompts.find(
      (entry) => entry.id === promptId && entry.type === 'target'
    );
    if (!prompt) {
      throw new Error('Target prompt not found');
    }
    if (prompt.playerId !== playerId) {
      throw new Error('Target prompt does not belong to this player');
    }
    const pendingIndex = this.gameState.pendingEffects.findIndex(
      (entry) => entry.id === promptId && entry.type === 'target'
    );
    if (pendingIndex === -1) {
      throw new Error('No pending target effect to resolve');
    }
    const pending = this.gameState.pendingEffects[pendingIndex];
    const sanitizedSelections = Array.from(new Set(selectionIds.filter(Boolean)));
    if (pending.operations && pending.context && pending.nextIndex !== undefined) {
      const caster = this.getPlayerById(pending.casterId);
      const contextSnapshot = this.restoreEffectContext(pending.context);
      contextSnapshot.targets = sanitizedSelections;
      this.executeEffectOperations(pending.operations, caster, contextSnapshot, pending.nextIndex + 1);
    } else {
      const handler = String(pending.metadata?.handler ?? '');
      const caster = this.getPlayerById(pending.casterId);
      switch (handler) {
        case 'graveyard_return': {
          const requireUnit = Boolean(pending.metadata?.requireUnit);
          const spellRef = this.buildSpellReference(
            (pending.metadata?.sourceCardId as string) ?? null,
            (pending.metadata?.sourceCardName as string) ?? null
          );
          this.tryReturnGraveyardCards(spellRef, caster, sanitizedSelections, requireUnit);
          break;
        }
        case 'multi_damage': {
          const damage = Math.max(1, Number(pending.metadata?.damage) || 0);
          if (damage > 0) {
            const spellRef = this.buildSpellReference(
              (pending.metadata?.sourceCardId as string) ?? null,
              (pending.metadata?.sourceCardName as string) ?? null
            );
            this.applySpellDamageToTargets(spellRef, caster, damage, sanitizedSelections);
          }
          break;
        }
        case 'play_from_graveyard': {
          const requireUnit = Boolean(pending.metadata?.requireUnit);
          const spellRef = this.buildSpellReference(
            (pending.metadata?.sourceCardId as string) ?? null,
            (pending.metadata?.sourceCardName as string) ?? null
          );
          this.playCardFromGraveyard(caster, sanitizedSelections, {
            requireUnit,
            ignoreEnergy: pending.metadata?.ignoreEnergy !== false,
            source: spellRef
          });
          break;
        }
        default:
          throw new Error('Target selection handler is not supported yet');
      }
    }
    this.gameState.pendingEffects.splice(pendingIndex, 1);
    this.resolvePrompt(prompt, { selectedIds: sanitizedSelections });
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
    this.readyChampions(currentPlayer);

    // B — Begin phase triggers
    this.updateTurnSequenceStep('begin', currentPlayer, 'turn-begin-step');
    this.resolveTemporaryEffects(currentPlayer);
    this.checkBattlefieldHoldBonuses(currentPlayer);
    this.triggerBattlefieldTurnStart(currentPlayer);

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

  private triggerBattlefieldTurnStart(player: PlayerState): void {
    for (const battlefield of this.gameState.battlefields) {
      this.triggerBattlefieldAbility(battlefield, 'turn_start', player);
    }
  }

  private channelRunes(player: PlayerState, maxRunes: number, options?: { tapped?: boolean }): number {
    const enterTapped = Boolean(options?.tapped);
    let channeled = 0;
    for (let i = 0; i < maxRunes; i++) {
      if (player.runeDeck.length === 0) {
        break;
      }

      const rune = player.runeDeck.shift();
      if (!rune) {
        break;
      }

      rune.isTapped = enterTapped;
      player.channeledRunes.push(rune);
      channeled += 1;
    }
    this.recalculateResources(player);
    return channeled;
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

  private readyRunes(player: PlayerState, count: number): number {
    if (count <= 0) {
      return 0;
    }
    let remaining = count;
    let changed = false;
    for (const rune of player.channeledRunes) {
      if (remaining <= 0) {
        break;
      }
      if (rune.isTapped) {
        rune.isTapped = false;
        remaining--;
        changed = true;
      }
    }
    if (changed) {
      this.recalculateResources(player);
    }
    return count - remaining;
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

  private cardSupportsTiming(card: Card, timing: 'action' | 'reaction'): boolean {
    const keywordHints = (card.keywords ?? []).map((keyword) => keyword.toLowerCase());
    const timingHints = new Set<string>(keywordHints);
    if (card.activationProfile?.timing) {
      timingHints.add(card.activationProfile.timing.toLowerCase());
    }
    (card.activationProfile?.reactionWindows ?? []).forEach((window) =>
      timingHints.add(window.toLowerCase())
    );
    return timingHints.has(timing);
  }

  private ensureCombatTiming(card: Card, stage: 'action' | 'reaction'): void {
    if (!this.cardSupportsTiming(card, stage)) {
      const label = stage === 'action' ? 'action' : 'reaction';
      throw new Error(`Only ${label} cards may be played right now.`);
    }
  }

  /**
   * Play a card from hand to board
   */
  public playCard(
    playerId: string,
    cardIndex: number,
    targets?: string[],
    destinationId?: string | null,
    options?: { useAccelerate?: boolean }
  ): void {
    const player = this.getPlayerById(playerId);
    const hasCombatPriority = this.hasCombatPriority(playerId);
    if (!hasCombatPriority && player.playerId !== this.getCurrentPlayer().playerId) {
      throw new Error('Not your turn');
    }

    if (
      !hasCombatPriority &&
      this.currentPhase !== GamePhase.MAIN_1 &&
      this.currentPhase !== GamePhase.MAIN_2
    ) {
      throw new Error(`Cannot play cards during ${this.currentPhase} phase`);
    }

    const card = player.hand[cardIndex];
    if (!card) {
      throw new Error('Card not in hand');
    }

    const combatStage = hasCombatPriority
      ? this.gameState.combatContext?.priorityStage ?? 'action'
      : null;
    if (hasCombatPriority) {
      this.ensureCombatTiming(card, combatStage ?? 'action');
      this.currentPhase = GamePhase.COMBAT;
    }

    const cardCost = this.getCardCost(card);
    const accelerateConfig =
      options?.useAccelerate === true ? this.getAccelerateCost(card) : null;
    if (accelerateConfig) {
      cardCost.energy += accelerateConfig.energy;
      if (accelerateConfig.rune) {
        cardCost.power = {
          ...(cardCost.power ?? {}),
          [accelerateConfig.rune]: (cardCost.power?.[accelerateConfig.rune] ?? 0) + 1
        };
      }
    }
    if (!this.canPayCost(player, cardCost)) {
      throw new Error('Insufficient resources');
    }

    // Validate targets
    this.validateTargets(card, targets ?? []);

    // Remove from hand
    player.hand.splice(cardIndex, 1);
    this.payCardCost(player, cardCost);

    // Place on board based on card type
    const cardType = (card.type ?? '').toLowerCase() as CardType;
    switch (cardType) {
      case CardType.CREATURE:
      case CardType.ARTIFACT:
      case CardType.ENCHANTMENT:
        this.deployPermanentCard(player, card, {
          destinationId,
          targets,
          accelerated: Boolean(accelerateConfig)
        });
        break;
      case CardType.SPELL:
        this.resolveSpell(card, player, targets);
        player.graveyard.push(card);
        break;
      default:
        throw new Error(`Unsupported card type: ${card.type}`);
    }

    this.recordMove('play_card', card.id, destinationId ?? targets?.[0]);
    if (accelerateConfig) {
      const playerName = this.resolvePlayerName(player.playerId) ?? 'Player';
      this.addDuelLogEntry({
        playerId: player.playerId,
        message: `${playerName} accelerates ${card.name ?? 'a unit'} to enter ready.`,
        tone: 'info'
      });
    }
    this.advanceCombatPriorityAfterPlay(player, combatStage);
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

  private getAccelerateCost(card: Card): AccelerateCost | null {
    if (!card.metadata || typeof card.metadata !== 'object') {
      return null;
    }
    const payload = card.metadata as Record<string, unknown>;
    const raw = payload.accelerateCost as { energy?: number; rune?: string } | undefined;
    if (!raw) {
      return null;
    }
    const energy = Number(raw.energy ?? 0);
    if (!Number.isFinite(energy) || energy <= 0) {
      return null;
    }
    const rune = raw.rune ? this.mapDomain(raw.rune) : undefined;
    return {
      energy: Math.round(energy),
      rune
    };
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

  private hasPlayerBattledOnBattlefieldThisTurn(
    playerId: string,
    battlefield: BattlefieldState
  ): boolean {
    const record = battlefield.combatTurnByPlayer?.[playerId];
    return typeof record === 'number' && record === this.turnNumber;
  }

  private registerBattlefieldBattleForPlayer(playerId: string, battlefield: BattlefieldState): void {
    if (!battlefield.combatTurnByPlayer) {
      battlefield.combatTurnByPlayer = {};
    }
    battlefield.combatTurnByPlayer[playerId] = this.turnNumber;
  }

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

    const originBattlefieldId =
      creature.location.zone === 'battlefield' ? creature.location.battlefieldId : null;

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

    if (this.hasPlayerBattledOnBattlefieldThisTurn(player.playerId, battlefield)) {
      throw new Error('You already resolved combat on this battlefield this turn.');
    }

    if (
      originBattlefieldId &&
      originBattlefieldId !== battlefield.battlefieldId &&
      !this.cardHasMechanic(creature, 'ganking')
    ) {
      throw new Error('Only units with Ganking can move between battlefields');
    }

    const canEnterBattlefieldPhase =
      this.currentPhase === GamePhase.MAIN_1 || this.currentPhase === GamePhase.COMBAT;
    if (!canEnterBattlefieldPhase) {
      throw new Error('Units can only enter battlefields during the main phase or combat');
    }

    this.moveUnitToBattlefield(player, creature, battlefield, {
      autoEngage: false
    });
    this.recordMove('move', creature.id, battlefield.battlefieldId);
  }

  public deployChampionLeader(playerId: string, destinationId?: string | null): void {
    const player = this.getPlayerById(playerId);
    const champion = player.championLeader;
    if (!champion) {
      throw new Error('No champion leader assigned.');
    }
    if (player.championLeaderDeployed) {
      throw new Error('Champion leader already deployed.');
    }
    const hasCombatPriority = this.hasCombatPriority(playerId);
    if (hasCombatPriority) {
      throw new Error('Cannot deploy champion leader during combat priority.');
    }
    if (player.playerId !== this.getCurrentPlayer().playerId) {
      throw new Error('Not your turn');
    }
    if (
      this.currentPhase !== GamePhase.MAIN_1 &&
      this.currentPhase !== GamePhase.MAIN_2
    ) {
      throw new Error('Champion leaders can only be deployed during the main phase.');
    }
    if (this.gameState.status !== GameStatus.IN_PROGRESS) {
      throw new Error('Game is not in progress.');
    }

    const cardCost = this.getCardCost(champion);
    if (!this.canPayCost(player, cardCost)) {
      throw new Error('Insufficient resources to deploy champion leader.');
    }

    this.payCardCost(player, cardCost);

    const boardCard = this.deployPermanentCard(player, champion, { destinationId, targets: [] });

    player.championLeaderDeployed = true;
    this.recordMove(
      'play_card',
      champion.id,
      boardCard.location.zone === 'battlefield' ? boardCard.location.battlefieldId ?? null : 'base'
    );

    this.addDuelLogEntry({
      playerId,
      message: `${this.resolvePlayerName(playerId) ?? 'Player'} deploys ${champion.name}.`,
      tone: 'info'
    });
  }

  public concedeMatch(concedingPlayerId: string): MatchResult {
    const concedingPlayer = this.getPlayerById(concedingPlayerId);
    const opponent = this.getOtherPlayer(concedingPlayer);
    const alreadyDecided = this.getMatchResult();
    if (alreadyDecided) {
      return alreadyDecided;
    }
    this.addDuelLogEntry({
      playerId: concedingPlayer.playerId,
      message: `${this.resolvePlayerName(concedingPlayer.playerId) ?? 'Player'} concedes the duel.`,
      tone: 'warning'
    });
    this.endGame(opponent, concedingPlayer, 'concede');
    return {
      matchId: this.gameState.matchId,
      winner: opponent.playerId,
      loser: concedingPlayer.playerId,
      reason: 'concede',
      duration: Date.now() - this.gameState.timestamp,
      turns: this.turnNumber,
      moves: [...this.gameState.moveHistory]
    };
  }

  public activateChampionAbility(
    playerId: string,
    target: 'legend' | 'leader' = 'legend',
    destinationId?: string | null
  ): void {
    const player = this.getPlayerById(playerId);
    if (target === 'leader') {
      this.deployChampionLeader(playerId, destinationId);
      return;
    }
    const champion = player.championLegend;
    if (!champion) {
      throw new Error('No legend assigned to activate.');
    }
    const costProfile = parseChampionAbilityCost(champion.text ?? '');
    if (costProfile.requiresExhaust && champion.isTapped) {
      throw new Error(`${champion.name} is exhausted.`);
    }
    const cardCost = this.championCostToCardCost(costProfile);
    if (!this.tryAllocateRunesForCost(player, cardCost, true)) {
      throw new Error('Insufficient resources to activate champion ability.');
    }
    if (costProfile.requiresExhaust) {
      champion.isTapped = true;
    }
    const operations = champion.effectProfile?.operations ?? [];
    if (operations.length === 0) {
      throw new Error('Champion has no activatable effect.');
    }
    this.executeEffectOperations(operations, player, {
      source: champion,
      abilityName: 'legend ability',
      triggerType: 'legend'
    });
    this.recordMove('activate_ability', champion.id);
    this.addDuelLogEntry({
      playerId,
      message: `${this.resolvePlayerName(playerId) ?? 'Player'} activates ${champion.name}.`,
      tone: 'info'
    });
  }

  public passPriority(playerId: string): void {
    const window = this.gameState.priorityWindow;
    if (!window) {
      throw new Error('No priority window is active.');
    }
    if (window.holder !== playerId) {
      throw new Error('You do not currently have priority.');
    }
    const player = this.getPlayerById(playerId);
    if (window.type === 'combat' && this.gameState.combatContext) {
      this.handleCombatPriorityPass(player);
      return;
    }
    this.addDuelLogEntry({
      playerId,
      message: `${this.resolvePlayerName(playerId) ?? 'Player'} passes priority.`,
      tone: 'info'
    });
    this.closePriorityWindow();
  }

  private resolveDeploymentLocation(
    player: PlayerState,
    destinationId?: string | null,
    card?: Card | null
  ): CardLocation {
    if (!destinationId || destinationId === 'base') {
      return { zone: 'base' };
    }
    const battlefield = this.findBattlefieldState(destinationId);
    if (!battlefield) {
      throw new Error('Battlefield not found');
    }
    
    // If player controls the battlefield, always allow deployment
    if (battlefield.controller === player.playerId) {
      return {
        zone: 'battlefield',
        battlefieldId: battlefield.battlefieldId
      };
    }
    
    // Check card-specific deployment permissions
    const cardPerms = card ? this.getCardBattlefieldDeploymentPermissions(card) : null;
    const hasAllyGrant = this.hasAllyGrantingOpenBattlefieldDeploy(player);
    const isOpenBattlefield = !battlefield.controller;
    const isEnemyOccupied = battlefield.controller && battlefield.controller !== player.playerId;
    
    // Can deploy to open battlefield if card says so OR if an ally grants the ability
    if (isOpenBattlefield && (cardPerms?.canPlayToOpenBattlefield || hasAllyGrant)) {
      return {
        zone: 'battlefield',
        battlefieldId: battlefield.battlefieldId
      };
    }
    
    // Can deploy to occupied enemy battlefield if card says so
    if (isEnemyOccupied && cardPerms?.canPlayToOccupiedEnemyBattlefield) {
      return {
        zone: 'battlefield',
        battlefieldId: battlefield.battlefieldId
      };
    }
    
    // Default: must control battlefield
    throw new Error('You must control a battlefield to deploy there');
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
        sourceCardId: attacker.id,
        initiatedAttack: true
      });
      this.markBattlefieldEngagement(inferredBattlefield);
      this.registerBattlefieldBattleForPlayer(attackerController.playerId, inferredBattlefield);
      return;
    }

    this.markBattlefieldContested(inferredBattlefield, attackerController.playerId);
    this.markBattlefieldEngagement(inferredBattlefield);
    this.registerBattlefieldBattleForPlayer(attackerController.playerId, inferredBattlefield);
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

    const gained = player.victoryPoints - previous;
    if (gained > 0) {
      if (!Array.isArray(this.gameState.scoreLog)) {
        this.gameState.scoreLog = [];
      }
      this.gameState.scoreLog.push({
        playerId: player.playerId,
        amount: gained,
        reason,
        sourceCardId,
        timestamp: Date.now()
      });
      const playerName = this.resolvePlayerName(player.playerId) ?? 'Player';
      const sourceName = this.resolveSourceCardName(sourceCardId);
      const reasonLabel = this.describeScoreReason(reason, sourceName);
      const suffix = reasonLabel ? ` ${reasonLabel}` : '';
      this.addDuelLogEntry({
        playerId: player.playerId,
        message: `${playerName} gains ${gained} victory point${gained === 1 ? '' : 's'}${suffix}.`,
        tone: 'success'
      });
    }

    if (player.victoryPoints >= player.victoryScore) {
      const opponent = this.getOtherPlayer(player);
      this.endGame(player, opponent, 'victory_points');
    }
  }

  private resolveSourceCardName(sourceCardId?: string): string | null {
    if (!sourceCardId) {
      return null;
    }
    const boardCard = this.findCardInstance(sourceCardId);
    if (boardCard?.name) {
      return boardCard.name;
    }
    const battlefield = this.gameState.battlefields.find(
      (entry) => entry.battlefieldId === sourceCardId
    );
    if (battlefield) {
      return battlefield.name;
    }
    try {
      const catalogCard = this.lookupCatalogCard(sourceCardId);
      return catalogCard?.name ?? null;
    } catch {
      return null;
    }
  }

  private describeScoreReason(reason: ScoreReason, sourceName?: string | null): string | null {
    switch (reason) {
      case 'combat':
        return sourceName ? `for conquering ${sourceName}` : 'after combat';
      case 'hold':
        return sourceName ? `for holding ${sourceName}` : 'for holding a battlefield';
      case 'objective':
        return sourceName ? `for securing ${sourceName}` : 'for securing an objective';
      case 'support':
        return 'from a support effect';
      case 'decking':
        return 'after the opponent exhausted their deck';
      case 'concede':
        return 'after the opponent conceded';
      case 'timeout':
        return 'after a timeout';
      default:
        return null;
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

  private millCards(
    player: PlayerState,
    amount: number,
    context: EffectOperationContext | undefined
  ): void {
    const total = Math.max(1, amount);
    const moved: Card[] = [];
    for (let i = 0; i < total; i++) {
      if (player.deck.length === 0) {
        break;
      }
      const card = player.deck.shift();
      if (!card) {
        break;
      }
      player.graveyard.push(card);
      moved.push(card);
    }
    if (moved.length > 0) {
      const playerName = this.resolvePlayerName(player.playerId) ?? 'Player';
      const suffix = context ? this.describeEffectSuffix(context) : '';
      this.addDuelLogEntry({
        playerId: player.playerId,
        message: `${playerName} mills ${moved.length} card${moved.length === 1 ? '' : 's'}${suffix}.`,
        tone: 'warning'
      });
    }
  }

  private burnOut(player: PlayerState): void {
    const opponent = this.getOtherPlayer(player);
    if (!Array.isArray(this.gameState.scoreLog)) {
      this.gameState.scoreLog = [];
    }
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
    if (this.handleSpecialSpell(spell, caster, targets)) {
      return;
    }
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
        battlefieldTarget,
        triggerType: 'spell',
        targets: targets ?? null
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
    context: EffectOperationContext,
    startIndex = 0
  ): void {
    const resolveBoardTargets = (): BoardCard[] => {
      if (context.targets && context.targets.length > 0) {
        return context.targets
          .map((targetId) => this.findCardInstance(targetId))
          .filter((card): card is BoardCard => Boolean(card));
      }
      return context.boardTarget ? [context.boardTarget] : [];
    };
    for (let index = startIndex; index < operations.length; index++) {
      const operation = operations[index];
      switch (operation.type) {
        case 'draw_cards': {
          const targetPlayer = this.resolveOperationPlayer(operation, caster, context);
          const count = Math.max(1, operation.magnitudeHint ?? 1);
          this.drawCards(targetPlayer, count);
          this.logCardDraw(targetPlayer, count, context);
          break;
        }
        case 'mill_cards': {
          const targetPlayer = this.resolveOperationPlayer(operation, caster, context);
          const metadataCount =
            typeof operation.metadata === 'object' && operation.metadata
              ? Number((operation.metadata as { count?: number }).count)
              : undefined;
          const count = Math.max(1, metadataCount ?? operation.magnitudeHint ?? 1);
          this.millCards(targetPlayer, count, context);
          break;
        }
        case 'discard_cards': {
          // Discard defaults to self (caster) - opponent discard requires explicit targetHint: 'enemy'
          const targetPlayer = this.resolveOperationPlayer(operation, caster, context);
          if (
            context.battlefieldTarget &&
            context.source &&
            targetPlayer.hand.length > 0
          ) {
            if (
              this.deferDiscardOperation(operation, operations, index, caster, targetPlayer, context)
            ) {
              return;
            }
          }
          const discarded = targetPlayer.hand.shift();
          if (discarded) {
            targetPlayer.graveyard.push(discarded);
            const playerName = this.resolvePlayerName(targetPlayer.playerId) ?? 'Player';
            const suffix = this.describeEffectSuffix(context);
            this.addDuelLogEntry({
              playerId: targetPlayer.playerId,
              message: `${playerName} discards ${discarded.name ?? 'a card'}${suffix}.`,
              tone: 'warning'
            });
          }
          break;
        }
        case 'modify_stats': {
          const targetsToBuff = resolveBoardTargets();
          if (targetsToBuff.length === 0) {
            break;
          }
          const amount = operation.magnitudeHint ?? 2;
          targetsToBuff.forEach((target) => {
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
          });
          break;
        }
        case 'deal_damage': {
          const amount = operation.magnitudeHint ?? 2;
          const targetsToDamage = resolveBoardTargets();
          if (targetsToDamage.length === 0) {
            const damageTarget = this.ensureDamageableTarget(context.boardTarget, context.source);
            this.damageCreature(damageTarget, amount, context.source);
            break;
          }
          targetsToDamage.forEach((target) => {
            const damageTarget = this.ensureDamageableTarget(target, context.source);
            this.damageCreature(damageTarget, amount, context.source);
          });
          break;
        }
        case 'heal': {
          const targetsToHeal = resolveBoardTargets().filter(
            (target) => target.type === CardType.CREATURE
          );
          if (targetsToHeal.length === 0) {
            break;
          }
          const healAmount = Math.max(1, operation.magnitudeHint ?? 1);
          targetsToHeal.forEach((target) => {
            this.restoreCreature(target, healAmount);
          });
          break;
        }
        case 'remove_permanent': {
          const removalTargets = resolveBoardTargets();
          if (removalTargets.length === 0 && context.boardTarget) {
            removalTargets.push(context.boardTarget);
          }
          removalTargets.forEach((target) => {
            this.damageCreature(
              target,
              target.currentToughness,
              context.source
            );
          });
          break;
        }
        case 'summon_unit':
        case 'create_token': {
          const tokenSpec = this.getTokenSpec(operation, context.source);
          if (!tokenSpec) {
            this.logRuleUsage(context.source, `${operation.type}-manual`);
            break;
          }
          if (tokenSpec.variableCount || tokenSpec.flexiblePlacement) {
            this.logRuleUsage(context.source, `${operation.type}-manual`);
            break;
          }
          this.spawnTokenUnits(caster, tokenSpec, context);
          break;
        }
        case 'return_from_graveyard': {
          const effectText = this.stripRichText(context.source?.text ?? '');
          const optional = /\bup to\b/i.test(effectText) || /\bmay\b/i.test(effectText);
          const requireUnit = this.requiresUnitForGraveyardReturn(context.source);
          const maxTargets =
            operation.magnitudeHint && operation.magnitudeHint > 0
              ? operation.magnitudeHint
              : this.detectReturnCountFromText(effectText) ?? 1;
          const minTargets = optional ? 0 : 1;
          const selections = context.targets ?? [];
          if (selections.length === 0) {
            if (
              this.deferTargetSelectionForOperation(operations, index, caster, context, {
                scope: 'graveyard',
                min: minTargets,
                max: maxTargets,
                allowFriendly: true,
                allowOpponent: false,
                metadata: {
                  handler: 'return_from_graveyard',
                  requireUnit,
                  maxTargets
                }
              })
            ) {
              return;
            }
            break;
          }
          const moved = this.tryReturnGraveyardCards(
            context.source ?? this.buildSpellReference(),
            caster,
            selections,
            requireUnit,
            context
          );
          if (!moved) {
            this.addDuelLogEntry({
              playerId: caster.playerId,
              message: `${context.source?.name ?? 'Spell'} failed to find the selected card in the graveyard.`,
              tone: 'warning'
            });
          }
          break;
        }
        case 'return_to_hand': {
          if (!context.source) {
            break;
          }
          const criteria = this.buildReturnCriteria(context.source, operation);
          if (criteria.globalAll) {
            const globalTargets = this.collectReturnTargets(caster, criteria);
            if (globalTargets.length === 0) {
              this.addDuelLogEntry({
                playerId: caster.playerId,
                message: `${context.source.name} finds no cards to return.`,
                tone: 'info'
              });
              break;
            }
            globalTargets.forEach((target) => this.returnCardToOwnerHand(target, context));
            break;
          }
          const resolvedTargets = resolveBoardTargets().filter((target) =>
            this.matchesReturnCriteria(target, caster, criteria)
          );
          if (resolvedTargets.length === 0) {
            if (
              this.deferTargetSelectionForOperation(operations, index, caster, context, {
                scope: 'unit',
                min: criteria.minTargets,
                max: criteria.maxTargets,
                allowFriendly: !criteria.enemyOnly,
                allowOpponent: !criteria.friendlyOnly
              })
            ) {
              return;
            }
            break;
          }
          const limit =
            criteria.maxTargets > 0 ? resolvedTargets.slice(0, criteria.maxTargets) : resolvedTargets;
          limit.forEach((target) => this.returnCardToOwnerHand(target, context));
          break;
        }
        case 'gain_resource': {
          const recipient = this.resolveOperationPlayer(operation, caster, context);
          const amount = operation.magnitudeHint ?? 1;
          if (amount > 0) {
            const normalized = Math.max(1, Math.round(amount));
            this.channelRunes(recipient, normalized);
            this.logRuneChange(recipient, normalized, {
              direction: 'channel',
              exhausted: false,
              context
            });
          } else if (amount < 0) {
            const normalized = Math.max(1, Math.round(Math.abs(amount)));
            this.exhaustRunes(recipient, normalized);
            this.logRuneChange(recipient, normalized, {
              direction: 'exhaust',
              context
            });
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
          const recipient = this.resolveOperationPlayer(operation, caster, context);
          const amount = Math.max(1, operation.magnitudeHint ?? 1);
          const enterTapped =
            typeof operation.metadata === 'object' && operation.metadata
              ? Boolean((operation.metadata as { enterTapped?: boolean }).enterTapped)
              : false;
          this.channelRunes(recipient, amount, { tapped: enterTapped });
          this.logRuneChange(recipient, amount, {
            direction: 'channel',
            exhausted: enterTapped,
            context
          });
          break;
        }
        case 'move_unit': {
          const unitTargets = resolveBoardTargets();
          const unitsToMove =
            unitTargets.length > 0
              ? unitTargets
              : this.isBoardCard(context.source) && context.source.type === CardType.CREATURE
                ? [(context.source as BoardCard)]
                : [];
          if (unitsToMove.length === 0) {
            break;
          }
          const destination =
            typeof operation.metadata === 'object' && operation.metadata
              ? (operation.metadata as { destination?: 'base' | 'battlefield' }).destination
              : undefined;
          const prefersBattlefield =
            destination === 'battlefield' ||
            (destination === undefined &&
              unitsToMove[0].location.zone === 'base' &&
              operation.targetHint !== 'enemy');
          unitsToMove.forEach((unit) => {
            const owner = this.getPlayerByCard(unit.instanceId);
            if (prefersBattlefield && context.battlefieldTarget) {
              if (
                unit.location.zone !== 'battlefield' ||
                unit.location.battlefieldId !== context.battlefieldTarget.battlefieldId
              ) {
                this.moveUnitToBattlefield(owner, unit, context.battlefieldTarget);
              }
            } else if (unit.location.zone !== 'base') {
              this.moveUnitToBase(owner, unit);
            }
          });
          break;
        }
        case 'recycle_card': {
          const iterations = Math.max(1, operation.magnitudeHint ?? 1);
          const targetPlayer = this.resolveOperationPlayer(operation, caster, context);
          for (let i = 0; i < iterations; i++) {
            const recovered = targetPlayer.graveyard.shift();
            if (!recovered) {
              break;
            }
            targetPlayer.deck.push(recovered);
            this.logRuleUsage(context.source, 'recycle-card');
          }
          this.shuffle(targetPlayer.deck);
          break;
        }
        case 'search_deck': {
          const viewer = operation.targetHint === 'enemy' ? this.getOtherPlayer(caster) : caster;
          const peekCount = Math.max(1, operation.magnitudeHint ?? 1);
          const preview = viewer.deck.slice(0, peekCount).map((card) => card.name);
          const previewSnippet = preview.slice(0, 3).join(', ');
          this.addDuelLogEntry({
            playerId: viewer.playerId,
            message: `${this.resolvePlayerName(viewer.playerId) ?? 'Player'} inspects their deck${
              previewSnippet ? ` (${previewSnippet}${preview.length > 3 ? '…' : ''})` : ''
            }.`,
            tone: 'info'
          });
          this.logRuleUsage(context.source, 'search-deck');
          break;
        }
        case 'manipulate_priority': {
          const baseType =
            this.gameState.currentPhase === GamePhase.COMBAT ? 'combat' : 'main';
          const windowHolder =
            operation.targetHint === 'enemy'
              ? this.getOtherPlayer(caster).playerId
              : caster.playerId;
          this.gameState.focusPlayerId = windowHolder;
          this.openPriorityWindow(baseType, windowHolder, `effect-${context.source.id}`);
          break;
        }
        case 'interact_legend': {
          const player =
            operation.targetHint === 'enemy' ? this.getOtherPlayer(caster) : caster;
          this.addDuelLogEntry({
            playerId: player.playerId,
            message: `${this.resolvePlayerName(player.playerId) ?? 'Player'}'s legend reacts to ${
              context.source.name
            }.`,
            tone: 'info'
          });
          this.logRuleUsage(context.source, 'legend-interaction');
          break;
        }
        case 'attach_gear': {
          this.addDuelLogEntry({
            playerId: caster.playerId,
            message: `${this.resolvePlayerName(caster.playerId) ?? 'Player'} equips a gear via ${
              context.source.name
            }.`,
            tone: 'info'
          });
          this.logRuleUsage(context.source, 'attach-gear');
          break;
        }
        case 'transform': {
          this.addDuelLogEntry({
            playerId: caster.playerId,
            message: `${context.source.name} transforms a target.`,
            tone: 'info'
          });
          this.logRuleUsage(context.source, 'transform');
          break;
        }
        case 'adjust_mulligan': {
          caster.firstTurnRuneBoost += Math.max(0, operation.magnitudeHint ?? 0);
          this.addDuelLogEntry({
            playerId: caster.playerId,
            message: `${this.resolvePlayerName(caster.playerId) ?? 'Player'} modifies their mulligan options.`,
            tone: 'info'
          });
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

  private handleSpecialSpell(spell: Card, caster: PlayerState, targets?: string[]): boolean {
    const effectText = (spell.text ?? '').toLowerCase();
    if (!effectText) {
      return false;
    }
    if (this.tryHandleChannelFallbackSpell(spell, caster, effectText)) {
      return true;
    }
    if (this.tryHandleGraveyardReturnSpell(spell, caster, effectText, targets)) {
      return true;
    }
    if (this.tryHandlePlayFromGraveyardSpell(spell, caster, effectText, targets)) {
      return true;
    }
    if (this.tryHandleMultiTargetDamageSpell(spell, caster, effectText, targets)) {
      return true;
    }
    return false;
  }

  private tryHandleChannelFallbackSpell(spell: Card, caster: PlayerState, effectText: string): boolean {
    const channelMatch = effectText.match(/channel\s+(\d+)\s+rune/i);
    const fallbackMatch = effectText.match(/if you can'?t,\s*draw\s+(\d+)/i);
    if (!channelMatch || !fallbackMatch) {
      return false;
    }
    const channelAmount = Math.max(1, parseInt(channelMatch[1], 10) || 1);
    const drawAmount = Math.max(1, parseInt(fallbackMatch[1], 10) || 1);
    const exhausted = /\bexhausted\b/.test(effectText);
    const before = caster.channeledRunes.length;
    const channeled = this.channelRunes(caster, channelAmount, exhausted ? { tapped: true } : undefined);
    const after = caster.channeledRunes.length;
    const actual = channeled || after - before;
    if (actual < channelAmount) {
      this.drawCards(caster, drawAmount);
      this.addDuelLogEntry({
        playerId: caster.playerId,
        message: `${spell.name} channels ${actual} rune${actual === 1 ? '' : 's'} before drawing ${drawAmount}.`,
        tone: 'info'
      });
    } else {
      this.addDuelLogEntry({
        playerId: caster.playerId,
        message: `${spell.name} channels ${channelAmount} rune${channelAmount === 1 ? '' : 's'}.`,
        tone: 'success'
      });
    }
    return true;
  }

  private tryHandleGraveyardReturnSpell(
    spell: Card,
    caster: PlayerState,
    effectText: string,
    targets?: string[]
  ): boolean {
    if (spell.effectProfile?.operations?.some((op) => op.type === 'return_from_graveyard')) {
      return false;
    }
    if (!/\breturn\b/.test(effectText) || !/\b(hand|hands)\b/.test(effectText)) {
      return false;
    }
    if (!/\bgraveyard\b/.test(effectText) && !/\btrash\b/.test(effectText)) {
      return false;
    }
    const requireUnit = /\bunit\b/.test(effectText);
    const candidates = caster.graveyard.filter((card) =>
      requireUnit ? card.type === CardType.CREATURE : true
    );
    if (candidates.length === 0) {
      this.addDuelLogEntry({
        playerId: caster.playerId,
        message: `${spell.name} fizzles with no valid cards in the graveyard.`,
        tone: 'warning'
      });
      return true;
    }
    if (targets && targets.length > 0) {
      const moved = this.tryReturnGraveyardCards(spell, caster, targets, requireUnit);
      if (!moved) {
        this.addDuelLogEntry({
          playerId: caster.playerId,
          message: `${spell.name} failed to find the chosen card in the graveyard.`,
          tone: 'warning'
        });
      }
      return true;
    }
    this.deferTargetPrompt({
      caster,
      spell,
      scope: 'graveyard',
      min: 1,
      max: 1,
      allowFriendly: true,
      allowOpponent: false,
      handler: 'graveyard_return',
      metadata: {
        requireUnit
      }
    });
    return true;
  }

  private tryHandlePlayFromGraveyardSpell(
    spell: Card,
    caster: PlayerState,
    effectText: string,
    targets?: string[]
  ): boolean {
    if (!/\bplay\b/.test(effectText) || !/\bfrom your\b/.test(effectText)) {
      return false;
    }
    if (!/\bgraveyard\b/.test(effectText) && !/\btrash\b/.test(effectText)) {
      return false;
    }
    const requireUnit = /\bunit\b/.test(effectText) || /\bcreature\b/.test(effectText);
    const ignoreEnergy = /ignore[s]? its energy cost/i.test(effectText);
    const eligible = caster.graveyard.filter((card) =>
      requireUnit ? card.type === CardType.CREATURE : true
    );
    if (eligible.length === 0) {
      this.addDuelLogEntry({
        playerId: caster.playerId,
        message: `${spell.name} fizzles with no valid cards to play from the graveyard.`,
        tone: 'warning'
      });
      return true;
    }
    if (targets && targets.length > 0) {
      const success = this.playCardFromGraveyard(caster, targets, {
        requireUnit,
        ignoreEnergy,
        source: spell
      });
      if (!success) {
        this.addDuelLogEntry({
          playerId: caster.playerId,
          message: `${spell.name} failed to play the selected card from the graveyard.`,
          tone: 'warning'
        });
      }
      return true;
    }
    this.deferTargetPrompt({
      caster,
      spell,
      scope: 'graveyard',
      min: 1,
      max: 1,
      allowFriendly: true,
      allowOpponent: false,
      handler: 'play_from_graveyard',
      metadata: {
        requireUnit,
        ignoreEnergy
      }
    });
    return true;
  }

  private tryReturnGraveyardCards(
    spell: Card,
    caster: PlayerState,
    selectionIds: string[],
    requireUnit: boolean,
    context?: EffectOperationContext
  ): boolean {
    const uniqueSelections = Array.from(new Set(selectionIds.filter(Boolean)));
    if (uniqueSelections.length === 0) {
      return false;
    }
    const recovered: Card[] = [];
    for (const chosenId of uniqueSelections) {
      const index = caster.graveyard.findIndex((card) => card.instanceId === chosenId);
      const card =
        index >= 0
          ? caster.graveyard[index]
          : caster.graveyard.find(
              (entry) =>
                entry.id === chosenId && (!requireUnit || entry.type === CardType.CREATURE)
            );
      if (!card || (requireUnit && card.type !== CardType.CREATURE)) {
        continue;
      }
      const removalIndex = index >= 0 ? index : caster.graveyard.indexOf(card);
      if (removalIndex >= 0) {
        caster.graveyard.splice(removalIndex, 1);
      }
      card.isTapped = false;
      recovered.push(card);
    }
    if (recovered.length === 0) {
      return false;
    }
    recovered.forEach((card) => caster.hand.push(card));
    const playerName = this.resolvePlayerName(caster.playerId) ?? 'Player';
    const suffix = context
      ? this.describeEffectSuffix(context)
      : ` with ${spell.name}`;
    const label =
      recovered.length === 1
        ? recovered[0].name ?? 'a card'
        : `${recovered.length} card${recovered.length === 1 ? '' : 's'}`;
    this.addDuelLogEntry({
      playerId: caster.playerId,
      message: `${playerName} returns ${label} to their hand${suffix}.`,
      tone: 'success'
    });
    return true;
  }

  private playCardFromGraveyard(
    player: PlayerState,
    selectionIds: string[],
    options: { requireUnit: boolean; ignoreEnergy?: boolean; source?: Card }
  ): boolean {
    const chosenId = selectionIds.find(Boolean);
    if (!chosenId) {
      return false;
    }
    const index = player.graveyard.findIndex((card) => card.instanceId === chosenId);
    if (index === -1) {
      return false;
    }
    const card = player.graveyard[index];
    if (!card || (options.requireUnit && card.type !== CardType.CREATURE)) {
      return false;
    }
    const cost: CardCost = {
      energy: options.ignoreEnergy ? 0 : card.energyCost ?? card.manaCost ?? 0,
      power: this.normalizePowerCost(card.powerCost)
    };
    if (!this.tryAllocateRunesForCost(player, cost, true)) {
      this.addDuelLogEntry({
        playerId: player.playerId,
        message: `${this.resolvePlayerName(player.playerId) ?? 'Player'} lacks the resources to play ${
          card.name ?? 'a card'
        } from their graveyard.`,
        tone: 'warning'
      });
      return false;
    }
    player.graveyard.splice(index, 1);
    this.deployPermanentCard(player, card, {});
    const suffix = options.source ? ` due to ${options.source.name}` : '';
    this.addDuelLogEntry({
      playerId: player.playerId,
      message: `${this.resolvePlayerName(player.playerId) ?? 'Player'} plays ${
        card.name ?? 'a card'
      } from their graveyard${suffix}.`,
      tone: 'success'
    });
    return true;
  }

  private tryHandleMultiTargetDamageSpell(
    spell: Card,
    caster: PlayerState,
    effectText: string,
    targets?: string[]
  ): boolean {
    const pattern = /deal\s+(\d+)\s+to\s+each\s+of\s+up to\s+(\d+)\s+units?/;
    const match = effectText.match(pattern);
    if (!match) {
      return false;
    }
    const damage = Math.max(1, parseInt(match[1], 10) || 1);
    const maxTargets = Math.max(1, parseInt(match[2], 10) || 1);
    if (targets && targets.length > 0) {
      this.applySpellDamageToTargets(spell, caster, damage, targets);
      return true;
    }
    this.deferTargetPrompt({
      caster,
      spell,
      scope: 'unit',
      min: 1,
      max: maxTargets,
      allowFriendly: true,
      allowOpponent: true,
      handler: 'multi_damage',
      metadata: {
        damage
      }
    });
    return true;
  }

  private applySpellDamageToTargets(
    spell: Card,
    caster: PlayerState,
    damage: number,
    selectionIds: string[]
  ): void {
    const appliedTargets = new Set<string>();
    for (const targetId of selectionIds) {
      if (!targetId || appliedTargets.has(targetId)) {
        continue;
      }
      const boardTarget = this.findCardInstance(targetId);
      if (!boardTarget) {
        continue;
      }
      const damageTarget = this.ensureDamageableTarget(boardTarget, spell);
      this.damageCreature(damageTarget, damage, spell);
      appliedTargets.add(targetId);
    }
    if (appliedTargets.size > 0) {
      this.addDuelLogEntry({
        playerId: caster.playerId,
        message: `${spell.name} deals ${damage} damage to ${appliedTargets.size} unit${
          appliedTargets.size === 1 ? '' : 's'
        }.`,
        tone: 'success'
      });
    } else {
      this.addDuelLogEntry({
        playerId: caster.playerId,
        message: `${spell.name} has no valid targets to damage.`,
        tone: 'warning'
      });
    }
  }


  /**
   * Damage a creature
   */
  private damageCreature(creature: BoardCard, amount: number, source: Card): void {
    if (creature.type !== CardType.CREATURE) {
      throw new Error('Only units (non-gears) can be dealt damage.');
    }

    creature.currentToughness -= amount;

    if (creature.currentToughness <= 0) {
      this.destroyUnit(creature, 'effect', source);
    }
  }

  private destroyUnit(creature: BoardCard, cause: 'combat' | 'effect', source?: Card): void {
    const player = this.getPlayerByCard(creature.instanceId);
    const index = player.board.creatures.findIndex((entry) => entry.instanceId === creature.instanceId);
    if (index === -1) {
      return;
    }
    const removed = player.board.creatures.splice(index, 1)[0];
    this.updateActivationState(removed, false, 'destroyed');
    if (removed.location.zone === 'battlefield' && removed.location.battlefieldId) {
      this.removeContestant(removed.location.battlefieldId, player.playerId);
    }
    const tokenUnit = this.isTokenCard(removed);
    if (!tokenUnit) {
      player.graveyard.push(removed);
    }
    this.announceUnitDeath(removed, player, { cause, source, token: tokenUnit });
    this.triggerAbilities(removed, 'death', player);
    if (cause === 'combat') {
      this.triggerAbilities(removed, 'death_combat', player);
    }
  }

  private announceUnitDeath(
    unit: BoardCard,
    owner: PlayerState,
    context: { cause: 'combat' | 'effect'; source?: Card; token?: boolean }
  ): void {
    const cardName = unit.name ?? 'Unit';
    const ownerName = this.resolvePlayerName(owner.playerId);
    const ownerSuffix = ownerName ? ` (${ownerName})` : '';
    let causeSuffix = '';
    if (context.source && context.source.id !== unit.id) {
      causeSuffix = ` due to ${context.source.name}`;
    } else if (context.cause === 'combat') {
      causeSuffix = ' in combat';
    }
    const tokenDescriptor = context.token ? ' token' : '';
    const removalClause = context.token
      ? 'is destroyed and removed from play (tokens do not enter the graveyard)'
      : 'is sent to the graveyard';
    this.addDuelLogEntry({
      playerId: owner.playerId,
      message: `${cardName}${tokenDescriptor}${ownerSuffix} ${removalClause}${causeSuffix}.`,
      tone: 'warning'
    });
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

  private stripTriggerPrefix(text: string): string {
    return text.replace(/^(when|whenever|after|before|while|during)\b[^,]*,\s*/i, '').trim();
  }

  private shouldDefaultDiscardToSelf(text: string): boolean {
    const normalized = text.toLowerCase();
    if (!/\bdiscard\b/.test(normalized)) {
      return false;
    }
    if (/\b(opponent|enemy)\b/.test(normalized)) {
      return false;
    }
    if (/\b(each|both)\s+players?\b/.test(normalized)) {
      return false;
    }
    if (/\b(target|choose|select)\b/.test(normalized)) {
      return false;
    }
    return true;
  }

  private normalizeEffectOperations(
    text: string,
    operations?: EffectOperation[]
  ): EffectOperation[] | undefined {
    if (!operations || operations.length === 0) {
      return operations;
    }
    if (!this.shouldDefaultDiscardToSelf(text)) {
      return operations;
    }
    return operations.map((operation) => {
      if (operation.type !== 'discard_cards' || operation.targetHint !== 'enemy') {
        return { ...operation };
      }
      return {
        ...operation,
        targetHint: 'self'
      };
    });
  }

  private normalizeAbilityOperations(ability: CardAbility): EffectOperation[] | undefined {
    if (!ability.operations || ability.operations.length === 0) {
      return ability.operations;
    }
    const description = ability.description ?? '';
    const normalizedDescription = description.toLowerCase();
    const effectText = this.stripTriggerPrefix(normalizedDescription);
    let operations = ability.operations.map((operation) => ({
      ...operation,
      metadata: operation.metadata ? { ...operation.metadata } : undefined
    }));
    const isMoveTrigger =
      ability.triggerType === 'move' ||
      ability.triggerType === 'move_to_battlefield' ||
      ability.triggerType === 'move_from_battlefield';
    if (isMoveTrigger && !/\b(move|relocate|swap)\b/.test(effectText)) {
      operations = operations.filter((operation) => operation.type !== 'move_unit');
    }
    if (this.shouldDefaultDiscardToSelf(normalizedDescription)) {
      operations = operations.map((operation) => {
        if (operation.type !== 'discard_cards' || operation.targetHint !== 'enemy') {
          return operation;
        }
        return {
          ...operation,
          targetHint: 'self'
        };
      });
    }
    return operations;
  }

  private deriveCardAbilities(record: EnrichedCardRecord): CardAbility[] {
    if (!record.rules || record.rules.length === 0) {
      return [];
    }
    const abilities: CardAbility[] = [];
    const isBattlefield = (record.type ?? '').toLowerCase() === 'battlefield';
    for (const clause of record.rules) {
      const clauseText = clause.text ?? '';
      if (!clauseText) {
        continue;
      }
      const match = clauseText.match(ABILITY_KEYWORD_PATTERN);
      let keyword: string | null = null;
      let rawBody: string | null = null;
      if (match) {
        keyword = (match.groups?.keyword ?? '').trim();
        rawBody = (match.groups?.body ?? '').trim();
      } else if (isBattlefield) {
        keyword = this.deriveBattlefieldAbilityKeyword(clauseText);
        rawBody = clauseText;
      } else if (this.clauseSuggestsTriggeredAbility(clauseText)) {
        keyword = this.deriveImplicitAbilityKeyword(clauseText, abilities.length + 1);
        rawBody = clauseText;
      }
      if (!rawBody) {
        continue;
      }
      if (!keyword) {
        keyword = `Ability ${abilities.length + 1}`;
      }
      const description = this.stripRichText(rawBody);
      if (!description) {
        continue;
      }
      const normalizedKeyword = keyword.toLowerCase();
      const supportedTrigger = SUPPORTED_KEYWORD_TRIGGERS[normalizedKeyword];
      const clauseActivation = buildActivation(description);
      const clauseTokenSpecs = parseTokenSpecs(description);
      const clauseProfile = buildEffectProfile(description, clauseActivation, clauseTokenSpecs);
      const baseOperations =
        clauseProfile.operations.length > 0
          ? this.enhanceAbilityOperationsFromText(clauseProfile.operations, description)
          : [];
      let operations = this.supplementOperationsFromText(baseOperations, description);
      operations =
        this.ensureTokenOperationMetadata(description, operations) ?? operations;
      const triggerType =
        supportedTrigger ?? this.inferAbilityTriggerFromText(keyword, description);
      if (!triggerType) {
        continue;
      }
      abilities.push({
        name: keyword,
        keyword,
        description,
        triggerType,
        timing: clauseActivation.timing,
        requiresTarget: clauseActivation.requiresTarget,
        triggerWindows: clauseActivation.triggers,
        reactionWindows: clauseActivation.reactionWindows,
        effectClasses: clauseProfile.classes,
        references: clauseProfile.references,
        priorityHint: clauseProfile.priority,
        targeting: clauseProfile.targeting,
        operations: operations.length > 0 ? operations : undefined
      });
    }
    return abilities;
  }

  private championCostToCardCost(cost: ChampionAbilityCost): CardCost {
    const power: DomainCost = {};
    Object.entries(cost.runes).forEach(([key, value]) => {
      const numeric = Number(value ?? 0);
      if (!Number.isFinite(numeric) || numeric <= 0) {
        return;
      }
      const normalized = key.toLowerCase();
      switch (normalized) {
        case 'fury':
          power[Domain.FURY] = (power[Domain.FURY] ?? 0) + numeric;
          break;
        case 'calm':
          power[Domain.CALM] = (power[Domain.CALM] ?? 0) + numeric;
          break;
        case 'mind':
          power[Domain.MIND] = (power[Domain.MIND] ?? 0) + numeric;
          break;
        case 'body':
          power[Domain.BODY] = (power[Domain.BODY] ?? 0) + numeric;
          break;
        case 'chaos':
          power[Domain.CHAOS] = (power[Domain.CHAOS] ?? 0) + numeric;
          break;
        case 'order':
          power[Domain.ORDER] = (power[Domain.ORDER] ?? 0) + numeric;
          break;
        case 'rainbow':
          power[Domain.CHAOS] = (power[Domain.CHAOS] ?? 0) + numeric;
          break;
        default:
          break;
      }
    });
    return {
      energy: cost.energy,
      power
    };
  }

  private cardCostToChampionAbilityCost(cost: CardCost): ChampionAbilityCost {
    const powerEntries = Object.entries(cost.power ?? {});
    const runes: Partial<Record<DomainKey, number>> = {};
    for (const [domainKey, amount] of powerEntries) {
      const numeric = Number(amount ?? 0);
      if (!Number.isFinite(numeric) || numeric <= 0) {
        continue;
      }
      const normalized = domainKey.toLowerCase() as DomainKey;
      runes[normalized] = (runes[normalized] ?? 0) + numeric;
    }
    return {
      energy: cost.energy ?? 0,
      runes,
      requiresExhaust: false,
      rawText: ''
    };
  }

  private evaluateChampionAbility(
    player: PlayerState,
    champion: Card | null
  ): ChampionAbilityRuntimeState | null {
    if (!champion) {
      return null;
    }
    const championText = champion.text ?? '';
    const isManuallyActivatable = hasManualActivation(championText);
    const abilityCost = parseChampionAbilityCost(championText);
    const reasons: string[] = [];
    
    // If the champion doesn't have a manual activation, it can never be activated
    if (!isManuallyActivatable) {
      reasons.push('Passive ability only');
    }
    
    if (abilityCost.requiresExhaust && champion.isTapped) {
      reasons.push('Champion is exhausted');
    }
    const canAfford = canSatisfyChampionCost(player.channeledRunes, abilityCost);
    if (!canAfford && isManuallyActivatable) {
      reasons.push('Insufficient energy');
    }
    return {
      canActivate: reasons.length === 0 && isManuallyActivatable,
      hasManualActivation: isManuallyActivatable,
      reason: reasons.length ? reasons.join('; ') : null,
      cost: abilityCost,
      costSummary: isManuallyActivatable ? summarizeChampionCost(abilityCost) : 'Passive'
    };
  }

  private evaluateChampionLeader(
    player: PlayerState,
    champion: Card | null
  ): ChampionAbilityRuntimeState | null {
    if (!champion) {
      return null;
    }
    const reasons: string[] = [];
    const cardCost = this.getCardCost(champion);
    if (player.championLeaderDeployed) {
      reasons.push('Already deployed');
    }
    if (this.gameState.status !== GameStatus.IN_PROGRESS) {
      reasons.push('Match not in progress');
    }
    const hasCombatPriority = this.hasCombatPriority(player.playerId);
    const isCurrentPlayer = player.playerId === this.getCurrentPlayer().playerId;
    if (!hasCombatPriority && !isCurrentPlayer) {
      reasons.push('Not your turn');
    }
    const isMainPhase =
      this.currentPhase === GamePhase.MAIN_1 || this.currentPhase === GamePhase.MAIN_2;
    if (!hasCombatPriority && !isMainPhase) {
      reasons.push(`Waiting for main phase`);
    }
    if (!this.canPayCost(player, cardCost)) {
      reasons.push('Insufficient resources');
    }
    const pseudoCost = this.cardCostToChampionAbilityCost(cardCost);
    return {
      canActivate: reasons.length === 0,
      hasManualActivation: true, // Leaders are always deployable (manual action)
      reason: reasons.length ? reasons.join('; ') : null,
      cost: pseudoCost,
      costSummary: summarizeChampionCost(pseudoCost)
    };
  }

  private refreshChampionAvailability(): void {
    for (const player of this.gameState.players) {
      player.championLegendStatus = this.evaluateChampionAbility(player, player.championLegend ?? null);
      player.championLeaderStatus = this.evaluateChampionLeader(player, player.championLeader ?? null);
    }
  }

  private getTokenSpec(operation: EffectOperation, source?: Card): TokenSpec | null {
    if (operation.metadata && typeof operation.metadata === 'object') {
      const candidate = (operation.metadata as { tokenSpec?: TokenSpec }).tokenSpec;
      if (candidate) {
        return candidate;
      }
    }
    if (
      (operation.type === 'create_token' || operation.type === 'summon_unit') &&
      source?.text
    ) {
      const derived = parseTokenSpecs(source.text);
      if (derived.length > 0) {
        return derived[0];
      }
    }
    return null;
  }

  private isTokenCard(card?: Card | BoardCard | null): boolean {
    if (!card) {
      return false;
    }
    const tagMatch = (card.tags ?? []).some(
      (tag) => typeof tag === 'string' && tag.trim().toLowerCase() === 'token'
    );
    if (tagMatch) {
      return true;
    }
    const name = (card.name ?? '').toLowerCase();
    return name.includes('token');
  }

  private resolveTokenPlacement(
    spec: TokenSpec,
    context: {
      boardTarget?: BoardCard;
      battlefieldTarget?: BattlefieldState;
    }
  ): CardLocation {
    if (spec.location === 'here' && context.boardTarget) {
      if (context.boardTarget.location.zone === 'battlefield' && context.boardTarget.location.battlefieldId) {
        return { zone: 'battlefield', battlefieldId: context.boardTarget.location.battlefieldId };
      }
      return { zone: 'base' };
    }
    if (spec.location === 'battlefield') {
      const battlefield =
        context.battlefieldTarget ??
        (context.boardTarget?.location.zone === 'battlefield'
          ? this.findBattlefieldState(context.boardTarget.location.battlefieldId)
          : null);
      if (battlefield) {
        return { zone: 'battlefield', battlefieldId: battlefield.battlefieldId };
      }
    }
    return { zone: 'base' };
  }

  private buildTokenCard(spec: TokenSpec, source: Card): Card {
    return {
      id: `token_${spec.slug}_${Date.now()}`,
      slug: spec.slug,
      name: `${spec.name}`,
      type: CardType.CREATURE,
      rarity: CardRarity.COMMON,
      setName: 'Generated',
      colors: source.colors ?? [],
      tags: ['Token', spec.name],
      keywords: spec.keywords ?? [],
      manaCost: 0,
      energyCost: 0,
      power: spec.might,
      toughness: spec.might,
      text: `${spec.name} token created by ${source.name}`,
      effectProfile: source.effectProfile,
      activationProfile: source.activationProfile
    };
  }

  private spawnTokenUnits(
    player: PlayerState,
    spec: TokenSpec,
    context: EffectOperationContext
  ): void {
    if (spec.variableCount || spec.flexiblePlacement) {
      this.logRuleUsage(context.source, 'token-manual-resolution');
      return;
    }
    const count = Math.max(1, spec.count || 1);
    for (let i = 0; i < count; i++) {
      const tokenCard = this.buildTokenCard(spec, context.source);
      const boardCard = this.createBoardCard(tokenCard);
      boardCard.power = spec.might;
      boardCard.toughness = spec.might;
      boardCard.currentToughness = spec.might;
      boardCard.isTapped = !spec.entersReady;
      const location = this.resolveTokenPlacement(spec, context);
      boardCard.location = location;
      player.board.creatures.push(boardCard);
      if (location.zone === 'battlefield' && location.battlefieldId) {
        const battlefieldState = this.findBattlefieldState(location.battlefieldId);
        if (battlefieldState) {
          this.markBattlefieldContested(battlefieldState, player.playerId);
        }
      }
    }
    const effectSuffix = this.describeEffectSuffix(context);
    const playerName = this.resolvePlayerName(player.playerId) ?? 'Player';
    this.addDuelLogEntry({
      playerId: player.playerId,
      message: `${playerName} creates ${count} ${spec.name} token${count > 1 ? 's' : ''}${effectSuffix}.`,
      tone: 'info'
    });
  }

  private detectReturnCountFromText(text: string): number | null {
    const match = text.match(/return\s+(?:up to\s+)?(one|two|three|four|five|six|seven|eight|nine|ten|\d+)/i);
    if (!match || !match[1]) {
      return null;
    }
    const token = match[1].toLowerCase();
    const wordMap: Record<string, number> = {
      one: 1,
      two: 2,
      three: 3,
      four: 4,
      five: 5,
      six: 6,
      seven: 7,
      eight: 8,
      nine: 9,
      ten: 10
    };
    if (wordMap[token]) {
      return wordMap[token];
    }
    const numeric = Number(token);
    return Number.isFinite(numeric) ? numeric : null;
  }

  private buildReturnCriteria(source: Card, operation: EffectOperation): ReturnCriteria {
    const text = this.stripRichText(source.text ?? '');
    const normalized = text.toLowerCase();
    const includesGear = /\bgear\b/.test(normalized);
    const includesUnit = /\bunit\b|\bcreature\b/.test(normalized);
    const friendlyOnly = /\bfriendly\b|\byou control\b/.test(normalized);
    const enemyOnly = /\benemy\b|\bopponent'?s\b/.test(normalized);
    const battlefieldOnly =
      /\bat\b\s*(?:a|the)?\s*battlefield\b/.test(normalized) ||
      /\bon\b\s*(?:a|the)?\s*battlefield\b/.test(normalized);
    const optional = /\bup to\b/i.test(normalized) || /\bmay\b/i.test(normalized);
    const globalAll =
      /\breturn\b[\s\S]+\ball\b/i.test(normalized) || /\breturn\b[\s\S]+\beach\b/i.test(normalized);
    const magnitude =
      operation.magnitudeHint && operation.magnitudeHint > 0
        ? operation.magnitudeHint
        : this.detectReturnCountFromText(normalized);
    const maxTargets = globalAll ? 0 : Math.max(1, magnitude ?? 1);
    let maxMight: number | null = null;
    const mightMatch = normalized.match(
      /(\d+)\s*(?:[:]?rb_might:?|might)\s*(?:or less|or fewer|and under|or lower)?/
    );
    if (mightMatch) {
      maxMight = Number(mightMatch[1]);
    }
    return {
      allowUnits: !includesGear || includesUnit,
      allowGear: includesGear,
      friendlyOnly,
      enemyOnly,
      battlefieldOnly,
      maxMight,
      optional,
      globalAll,
      minTargets: optional ? 0 : 1,
      maxTargets
    };
  }

  private matchesReturnCriteria(
    card: BoardCard,
    caster: PlayerState,
    criteria: ReturnCriteria
  ): boolean {
    const owner = this.getPlayerByCard(card.instanceId);
    const isFriendly = owner.playerId === caster.playerId;
    if (criteria.friendlyOnly && !isFriendly) {
      return false;
    }
    if (criteria.enemyOnly && isFriendly) {
      return false;
    }
    if (criteria.battlefieldOnly && card.location.zone !== 'battlefield') {
      return false;
    }
    const isGear = this.isGearCard(card);
    if (!criteria.allowGear && isGear) {
      return false;
    }
    if (!criteria.allowUnits && card.type === CardType.CREATURE) {
      return false;
    }
    if (!isGear && card.type !== CardType.CREATURE) {
      return false;
    }
    if (criteria.maxMight != null && card.type === CardType.CREATURE) {
      const cardMight = card.power ?? card.currentToughness ?? 0;
      if (cardMight > criteria.maxMight) {
        return false;
      }
    }
    return true;
  }

  private collectReturnTargets(caster: PlayerState, criteria: ReturnCriteria): BoardCard[] {
    const matches: BoardCard[] = [];
    for (const player of this.gameState.players) {
      const pool = [
        ...player.board.creatures,
        ...player.board.artifacts,
        ...player.board.enchantments
      ];
      pool.forEach((card) => {
        if (this.matchesReturnCriteria(card, caster, criteria)) {
          matches.push(card);
        }
      });
    }
    return matches;
  }

  private returnCardToOwnerHand(target: BoardCard, context: EffectOperationContext): void {
    const owner = this.getPlayerByCard(target.instanceId);
    this.removeCardFromBoard(owner, target);
    if (target.location.zone === 'battlefield' && target.location.battlefieldId) {
      this.removeContestant(target.location.battlefieldId, owner.playerId);
    }
    const tokenUnit = this.isTokenCard(target);
    this.updateActivationState(target, false, 'return-hand');
    const suffix = this.describeEffectSuffix(context);
    if (tokenUnit) {
      this.addDuelLogEntry({
        playerId: owner.playerId,
        message: `${target.name ?? 'Token'} dissipates instead of returning${suffix}.`,
        tone: 'warning'
      });
      return;
    }
    target.isTapped = false;
    target.summoned = true;
    target.location = { zone: 'base' };
    owner.hand.push(target);
    const ownerName = this.resolvePlayerName(owner.playerId) ?? 'Player';
    this.addDuelLogEntry({
      playerId: owner.playerId,
      message: `${ownerName} returns ${target.name ?? 'a card'} to their hand${suffix}.`,
      tone: 'info'
    });
  }

  private removeCardFromBoard(player: PlayerState, card: BoardCard): void {
    const pools = [player.board.creatures, player.board.artifacts, player.board.enchantments];
    for (const pool of pools) {
      const index = pool.findIndex((entry) => entry.instanceId === card.instanceId);
      if (index !== -1) {
        pool.splice(index, 1);
        break;
      }
    }
  }

  private isGearCard(card: Card | BoardCard): boolean {
    return (card.tags ?? []).some(
      (tag) => typeof tag === 'string' && tag.trim().toLowerCase() === 'gear'
    );
  }

  private requiresUnitForGraveyardReturn(source?: Card): boolean {
    if (!source) {
      return true;
    }
    const text = this.stripRichText(source.text ?? '');
    return /\bunit\b|\bcreature\b/i.test(text);
  }

  private describeEffectAttribution(context: EffectOperationContext): string | null {
    const abilityLabel = (context.abilityName ?? '').trim();
    const sourceName = context.source?.name ?? null;
    if (abilityLabel && sourceName) {
      return `${sourceName}'s ${abilityLabel}`;
    }
    if (abilityLabel) {
      return abilityLabel;
    }
    if (context.triggerType === 'death' && sourceName) {
      return `${sourceName}'s death trigger`;
    }
    return sourceName;
  }

  private describeEffectSuffix(context: EffectOperationContext): string {
    const attribution = this.describeEffectAttribution(context);
    return attribution ? ` due to ${attribution}` : '';
  }

  private logRuneChange(
    player: PlayerState,
    amount: number,
    options: { direction: 'channel' | 'exhaust'; exhausted?: boolean; context: EffectOperationContext }
  ): void {
    if (amount <= 0) {
      return;
    }
    const playerName = this.resolvePlayerName(player.playerId) ?? 'Player';
    const runeLabel = amount === 1 ? 'rune' : 'runes';
    const suffix = this.describeEffectSuffix(options.context);
    const verb = options.direction === 'channel' ? 'channels' : 'exhausts';
    const stateNote =
      options.direction === 'channel' && options.exhausted ? ' exhausted' : '';
    this.addDuelLogEntry({
      playerId: player.playerId,
      message: `${playerName} ${verb} ${amount} ${runeLabel}${stateNote}${suffix}.`,
      tone: 'info'
    });
  }

  private logCardDraw(player: PlayerState, count: number, context: EffectOperationContext): void {
    if (count <= 0) {
      return;
    }
    const playerName = this.resolvePlayerName(player.playerId) ?? 'Player';
    const suffix = this.describeEffectSuffix(context);
    const cardLabel = count === 1 ? 'a card' : `${count} cards`;
    this.addDuelLogEntry({
      playerId: player.playerId,
      message: `${playerName} draws ${cardLabel}${suffix}.`,
      tone: 'info'
    });
  }

  private resolveOperationPlayer(
    operation: EffectOperation,
    caster: PlayerState,
    context: EffectOperationContext,
    options?: { defaultToOpponent?: boolean }
  ): PlayerState {
    if (context.playerTarget) {
      return context.playerTarget;
    }
    const hint = (operation.targetHint ?? '').toString().toLowerCase();
    switch (hint) {
      case 'enemy':
      case 'opponent':
        return this.getOtherPlayer(caster);
      case 'self':
      case 'ally':
      case 'friendly':
      case 'controller':
      case 'owner':
        return caster;
      default:
        return options?.defaultToOpponent ? this.getOtherPlayer(caster) : caster;
    }
  }

  private stripRichText(text: string): string {
    return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private inferAbilityTriggerFromText(
    keyword: string,
    clauseText: string
  ): CardAbility['triggerType'] | undefined {
    const normalizedKeyword = (keyword ?? '').toLowerCase();
    if (SUPPORTED_KEYWORD_TRIGGERS[normalizedKeyword]) {
      return SUPPORTED_KEYWORD_TRIGGERS[normalizedKeyword];
    }
    const normalizedText = clauseText.toLowerCase();
    if (/\bwhen i die in combat\b/.test(normalizedText)) {
      return 'death_combat';
    }
    if (/\bwhen i die\b/.test(normalizedText) || /\bdeathknell\b/.test(normalizedText)) {
      return 'death';
    }
    if (/\bwhen i enter\b|\bwhen this enters\b|\bwhen you play\b/.test(normalizedText)) {
      return 'play';
    }
    if (/when i attack or defend one on one/.test(normalizedText)) {
      return 'duel';
    }
    if (/when i attack or defend/.test(normalizedText)) {
      return 'attack_defend';
    }
    if (/when i attack\b/.test(normalizedText)) {
      return 'attack';
    }
    if (/when i defend\b/.test(normalizedText)) {
      return 'defend';
    }
    if (/when i win a combat/.test(normalizedText)) {
      return 'combat_win';
    }
    if (/when i conquer after an attack/.test(normalizedText)) {
      return 'conquer_after_attack';
    }
    if (/when i conquer an open battlefield/.test(normalizedText)) {
      return 'conquer_open';
    }
    if (/when i conquer\b/.test(normalizedText)) {
      return 'conquer';
    }
    if (/\bwhen (?:i|you)\s+hold\b/.test(normalizedText)) {
      return 'hold';
    }
    if (/when i move to [^.,;]+battlefield/.test(normalizedText)) {
      return 'move_to_battlefield';
    }
    if (/when i move from [^.,;]+battlefield/.test(normalizedText)) {
      return 'move_from_battlefield';
    }
    if (/\bwhen i move\b/.test(normalizedText)) {
      return 'move';
    }
    if (/\bwhen (?:a|any) unit moves from here\b/.test(normalizedText)) {
      return 'unit_move_from';
    }
    if (/\bwhile you control this battlefield\b/.test(normalizedText)) {
      return 'control';
    }
    if (/\bat the start of each player'?s first beginning phase\b/.test(normalizedText)) {
      return 'turn_start';
    }
    if (/\bat the start of each player'?s beginning phase\b/.test(normalizedText)) {
      return 'turn_start';
    }
    if (/\bincrease the points needed to win the game\b/.test(normalizedText)) {
      return 'setup';
    }
    if (/\byou may hide an additional card here\b/.test(normalizedText)) {
      return 'setup';
    }
    return undefined;
  }

  private enhanceAbilityOperationsFromText(
    operations: EffectOperation[],
    description: string
  ): EffectOperation[] {
    const requiresExhausted = /\bexhausted\b/i.test(description);
    const normalized = description.toLowerCase();
    return operations.map((operation) => {
      if (operation.type === 'channel_rune' && requiresExhausted) {
        return {
          ...operation,
          metadata: {
            ...(operation.metadata ?? {}),
            enterTapped: true
          }
        };
      }
      if (operation.type === 'move_unit') {
        const metadata = {
          ...(operation.metadata ?? {})
        };
        if (/\bbase\b/i.test(normalized)) {
          Object.assign(metadata, { destination: 'base' });
        } else if (/\bbattlefield\b/i.test(normalized) || /\bhere\b/i.test(normalized)) {
          Object.assign(metadata, { destination: 'battlefield' });
        }
        if (Object.keys(metadata).length > 0) {
          return {
            ...operation,
            metadata
          };
        }
      }
      return { ...operation };
    });
  }

  private deriveBattlefieldAbilityKeyword(clauseText: string): string {
    const normalized = this.stripRichText(clauseText).toLowerCase();
    if (/when you hold/.test(normalized)) {
      return 'Hold';
    }
    if (/when you conquer/.test(normalized)) {
      return 'Conquer';
    }
    if (/when you defend/.test(normalized)) {
      return 'Defend';
    }
    if (/at the start/.test(normalized)) {
      return 'Start';
    }
    if (/while you control/.test(normalized)) {
      return 'Control';
    }
    return 'Battlefield';
  }

  private clauseSuggestsTriggeredAbility(clauseText: string): boolean {
    const normalized = this.stripRichText(clauseText).toLowerCase();
    return (
      /\bwhen\b/.test(normalized) ||
      /\bwhenever\b/.test(normalized) ||
      /\bafter\b/.test(normalized) ||
      /\bdeathknell\b/.test(normalized)
    );
  }

  private deriveImplicitAbilityKeyword(clauseText: string, sequence: number): string {
    const normalized = this.stripRichText(clauseText).toLowerCase();
    if (/when you play\b/.test(normalized) || /when i play\b/.test(normalized)) {
      return 'Play';
    }
    if (/when you hold\b/.test(normalized) || /when i hold\b/.test(normalized)) {
      return 'Hold';
    }
    if (/when you conquer\b/.test(normalized) || /when i conquer\b/.test(normalized)) {
      return 'Conquer';
    }
    if (/when you attack\b/.test(normalized) || /when i attack\b/.test(normalized)) {
      return 'Attack';
    }
    if (/when you defend\b/.test(normalized) || /when i defend\b/.test(normalized)) {
      return 'Defend';
    }
    if (/when you move\b/.test(normalized) || /when i move\b/.test(normalized)) {
      return 'Move';
    }
    if (/when you win a combat\b/.test(normalized) || /when i win a combat\b/.test(normalized)) {
      return 'Combat';
    }
    if (/when i die\b/.test(normalized) || /\bdeathknell\b/.test(normalized)) {
      return 'Death';
    }
    return `Triggered ${sequence}`;
  }

  private supplementOperationsFromText(
    operations: EffectOperation[],
    description: string
  ): EffectOperation[] {
    const extras: EffectOperation[] = [];
    const normalized = description.toLowerCase();
    if (
      !operations.some((operation) => operation.type === 'mill_cards') &&
      /put the top\s+(\d+)\s+cards?\s+of your (?:main\s+)?deck into your trash/.test(normalized)
    ) {
      const match = normalized.match(
        /put the top\s+(\d+)\s+cards?\s+of your (?:main\s+)?deck into your trash/
      );
      const count = match ? Math.max(1, parseInt(match[1], 10) || 1) : 1;
      extras.push({
        type: 'mill_cards',
        targetHint: 'self',
        automated: true,
        ruleRefs: ['400'],
        magnitudeHint: count,
        metadata: {
          count
        }
      });
    }
    const hasTokenOperation = operations.some(
      (operation) => operation.type === 'create_token' || operation.type === 'summon_unit'
    );
    if (!hasTokenOperation) {
      const tokenSpecs = parseTokenSpecs(description);
      tokenSpecs.forEach((spec) => {
        extras.push({
          type: 'create_token',
          targetHint: 'ally',
          zone: 'board',
          automated: false,
          ruleRefs: ['340-360'],
          magnitudeHint: spec.variableCount ? undefined : spec.count,
          metadata: {
            tokenSpec: spec
          }
        });
      });
    }
    if (extras.length === 0) {
      return operations;
    }
    return operations.concat(extras);
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
    targets?: string[],
    options?: { battlefield?: BattlefieldState; boardTarget?: BoardCard; playerTarget?: PlayerState }
  ): void {
    const abilities = card.abilities ?? [];
    if (abilities.length === 0) {
      if (triggerType === 'play') {
        this.logRuleUsage(card, 'static-entry');
      }
      return;
    }

    let resolved = false;
    for (const ability of abilities) {
      if (!this.abilityMatchesTrigger(ability.triggerType, triggerType)) {
        continue;
      }
      resolved = true;
      if (ability.operations && ability.operations.length > 0) {
        const boardSource = this.isBoardCard(card) ? (card as BoardCard) : undefined;
        const boardTarget = options?.boardTarget ?? boardSource;
        const battlefieldTarget =
          options?.battlefield ??
          (boardTarget?.location.zone === 'battlefield'
            ? this.findBattlefieldState(boardTarget.location.battlefieldId)
            : undefined);
        this.executeEffectOperations(ability.operations, player, {
          source: card,
          boardTarget,
          playerTarget: options?.playerTarget,
          battlefieldTarget,
          abilityName: ability.name,
          triggerType: ability.triggerType ?? null
        });
        this.logRuleUsage(card, `ability-${ability.name}`);
        if (boardSource) {
          this.updateActivationState(boardSource, true, `ability-${ability.name}`);
        }
        continue;
      }
      this.resolveAbility(ability, card, player, targets);
      if (this.isBoardCard(card)) {
        this.updateActivationState(card, true, `ability-${ability.name}`);
      }
    }

    if (!resolved && triggerType === 'play') {
      this.logRuleUsage(card, 'static-entry');
    }
  }

  private abilityMatchesTrigger(
    abilityTrigger: string | undefined,
    triggerType: string
  ): boolean {
    if (!abilityTrigger) {
      return triggerType === 'play';
    }
    if (abilityTrigger === triggerType) {
      return true;
    }
    switch (abilityTrigger) {
      case 'attack_defend':
        return triggerType === 'attack' || triggerType === 'defend';
      case 'move':
        return (
          triggerType === 'move_to_battlefield' || triggerType === 'move_from_battlefield'
        );
      default:
        return false;
    }
  }

  private deferDiscardOperation(
    operation: EffectOperation,
    operations: EffectOperation[],
    index: number,
    caster: PlayerState,
    targetPlayer: PlayerState,
    context: EffectOperationContext
  ): boolean {
    if (!context.battlefieldTarget || !context.source) {
      return false;
    }
    const count = Math.max(1, operation.magnitudeHint ?? 1);
    const prompt = this.enqueuePrompt('discard', targetPlayer.playerId, {
      count,
      sourceCardId: context.source.id ?? null,
      sourceCardName: context.source.name ?? null,
      battlefieldId: context.battlefieldTarget.battlefieldId,
      battlefieldName: context.battlefieldTarget.name
    });
    const snapshot = this.snapshotEffectContext(context);
    this.gameState.pendingEffects.push({
      id: prompt.id,
      type: 'discard',
      casterId: caster.playerId,
      targetPlayerId: targetPlayer.playerId,
      operations: operations.map((op) => ({ ...op })),
      nextIndex: index,
      context: snapshot,
      metadata: {
        count
      }
    });
    return true;
  }

  private deferTargetSelectionForOperation(
    operations: EffectOperation[],
    index: number,
    caster: PlayerState,
    context: EffectOperationContext,
    options: {
      scope: 'unit' | 'graveyard';
      min: number;
      max: number;
      allowFriendly?: boolean;
      allowOpponent?: boolean;
      metadata?: Record<string, unknown>;
    }
  ): boolean {
    const prompt = this.enqueuePrompt('target', caster.playerId, {
      sourceCardId: context.source?.id ?? null,
      sourceCardName: context.source?.name ?? null,
      scope: options.scope,
      min: options.min,
      max: options.max,
      allowFriendly: options.allowFriendly !== false,
      allowOpponent: options.allowOpponent !== false
    });
    const snapshot = this.snapshotEffectContext(context);
    this.gameState.pendingEffects.push({
      id: prompt.id,
      type: 'target',
      casterId: caster.playerId,
      targetPlayerId: caster.playerId,
      operations: operations.map((op) => ({ ...op })),
      nextIndex: index,
      context: snapshot,
      metadata: options.metadata
    });
    return true;
  }

  private deferTargetPrompt(options: {
    caster: PlayerState;
    spell: Card;
    scope: 'unit' | 'graveyard';
    min: number;
    max: number;
    allowFriendly?: boolean;
    allowOpponent?: boolean;
    handler: string;
    metadata?: Record<string, unknown>;
  }): void {
    const prompt = this.enqueuePrompt('target', options.caster.playerId, {
      sourceCardId: options.spell.id ?? null,
      sourceCardName: options.spell.name ?? null,
      scope: options.scope,
      min: options.min,
      max: options.max,
      allowFriendly: options.allowFriendly !== false,
      allowOpponent: options.allowOpponent !== false
    });
    this.gameState.pendingEffects.push({
      id: prompt.id,
      type: 'target',
      casterId: options.caster.playerId,
      targetPlayerId: options.caster.playerId,
      metadata: {
        handler: options.handler,
        sourceCardId: options.spell.id,
        sourceCardName: options.spell.name,
        ...(options.metadata ?? {})
      }
    });
  }

  private snapshotEffectContext(context: EffectOperationContext): EffectContextSnapshot {
    return {
      sourceCardId: context.source?.id ?? null,
      sourceInstanceId:
        context.source && 'instanceId' in context.source
          ? ((context.source as BoardCard).instanceId ?? null)
          : null,
      boardTargetInstanceId: context.boardTarget?.instanceId ?? null,
      battlefieldId: context.battlefieldTarget?.battlefieldId ?? null,
      targetIds: context.targets ? [...context.targets] : null
    };
  }

  private restoreEffectContext(snapshot: EffectContextSnapshot): EffectOperationContext {
    const rebuilt: Partial<EffectOperationContext> = {};
    if (snapshot.battlefieldId) {
      rebuilt.battlefieldTarget = this.findBattlefieldState(snapshot.battlefieldId);
    }
    if (snapshot.sourceInstanceId) {
      const boardCard = this.findCardInstance(snapshot.sourceInstanceId);
      if (boardCard) {
        rebuilt.source = boardCard;
      }
    }
    if (!rebuilt.source) {
      if (rebuilt.battlefieldTarget?.card) {
        rebuilt.source = rebuilt.battlefieldTarget.card;
      } else if (snapshot.sourceCardId) {
        rebuilt.source = this.lookupCatalogCard(snapshot.sourceCardId);
      }
    }
    if (snapshot.boardTargetInstanceId) {
      rebuilt.boardTarget = this.findCardInstance(snapshot.boardTargetInstanceId) ?? undefined;
    }
    if (snapshot.targetIds) {
      rebuilt.targets = [...snapshot.targetIds];
    }
    if (!rebuilt.source) {
      throw new Error('Unable to restore effect context for pending operation.');
    }
    return rebuilt as EffectOperationContext;
  }

  private triggerUnits(units: BoardCard[], triggerType: string): void {
    units.forEach((unit) => {
      const owner = this.getPlayerByCard(unit.instanceId);
      this.triggerAbilities(unit, triggerType, owner);
    });
  }

  private triggerUnitsOnBattlefield(
    battlefieldId: string,
    ownerId: string,
    triggerType: string
  ): void {
    const units = this.getUnitsOnBattlefield(battlefieldId).filter(
      (unit) => this.getPlayerByCard(unit.instanceId).playerId === ownerId
    );
    if (units.length === 0) {
      return;
    }
    this.triggerUnits(units, triggerType);
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

    this.applyLegendEndOfTurnEffects(player);
  }

  private applyLegendEndOfTurnEffects(player: PlayerState): void {
    const legend = player.championLegend;
    if (!legend) {
      return;
    }
    const effectText = legend.text ?? '';
    if (!effectText) {
      return;
    }
    const readyMatch =
      /ready\s+(?<count>a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:of\s+their\s+|your\s+)?runes?/i.exec(
        effectText
      );
    if (!readyMatch?.groups?.count) {
      return;
    }
    const desired = this.parseWordNumber(readyMatch.groups.count);
    const readied = this.readyRunes(player, desired);
    if (readied <= 0) {
      return;
    }
    const playerName = this.resolvePlayerName(player.playerId) ?? 'Player';
    this.addDuelLogEntry({
      playerId: player.playerId,
      message: `${playerName} readies ${readied} rune${readied === 1 ? '' : 's'} due to ${legend.name}.`,
      tone: 'info'
    });
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

  private parseWordNumber(token?: string | null): number {
    if (!token) {
      return 1;
    }
    const numeric = Number(token);
    if (Number.isFinite(numeric) && numeric > 0) {
      return Math.floor(numeric);
    }
    const normalized = token.toLowerCase();
    switch (normalized) {
      case 'a':
      case 'an':
      case 'one':
        return 1;
      case 'two':
        return 2;
      case 'three':
        return 3;
      case 'four':
        return 4;
      case 'five':
        return 5;
      case 'six':
        return 6;
      case 'seven':
        return 7;
      case 'eight':
        return 8;
      case 'nine':
        return 9;
      case 'ten':
        return 10;
      case 'eleven':
        return 11;
      case 'twelve':
        return 12;
      default:
        return 1;
    }
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
      if (!card) {
        return null;
      }
      const cloned = this.cloneCard(card);
      cloned.isTapped = false;
      return cloned;
    } catch {
      return null;
    }
  }

  private materializeDeckEntry(entry: DeckCardEntry): Card[] {
    if (typeof entry === 'string') {
      return [this.lookupCatalogCard(entry)];
    }

    if (this.isDeckCard(entry)) {
      const candidates = [
        (entry as any).cardId,
        entry.id,
        entry.slug,
        entry.name
      ].filter(Boolean) as string[];
      for (const candidate of candidates) {
        try {
          const catalogCard = this.lookupCatalogCard(candidate);
          return [this.cloneCard(catalogCard)];
        } catch {
          // continue to next candidate
        }
      }
      const cloned = this.cloneCard(entry);
      cloned.powerCost = undefined;
      return [cloned];
    }

    if (this.isDeckReference(entry)) {
      const snapshot = (entry as any).cardSnapshot ?? null;
      const candidates = [
        entry.cardId,
        entry.slug,
        snapshot?.cardId,
        snapshot?.slug,
        snapshot?.name
      ].filter(Boolean) as string[];
      if (!candidates.length) {
        throw new Error('Deck entry is missing a card reference');
      }
      for (const candidate of candidates) {
        try {
          const catalogCard = this.lookupCatalogCard(candidate);
          const quantity = Math.max(1, entry.quantity ?? 1);
          return Array.from({ length: quantity }).map(() =>
            this.applyOverrides(catalogCard, entry.overrides)
          );
        } catch {
          // try next candidate
        }
      }
      const quantity = Math.max(1, entry.quantity ?? 1);
      return Array.from({ length: quantity }).map(() => {
        const fallback: Card = {
          id: candidates[0],
          name: snapshot?.name ?? 'Unknown Card',
          type: this.mapCardType(snapshot?.type ?? 'creature'),
          text: snapshot?.effect ?? 'Unknown effect',
          power: snapshot?.power ?? undefined,
          toughness: snapshot?.toughness ?? undefined,
          powerCost: undefined
        };
        return this.applyOverrides(fallback, entry.overrides);
      });
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

    const record =
      findCardById(identifier) ?? findCardBySlug(identifier) ?? findCardByName(identifier);
    if (!record) {
      throw new Error(`Card not found for identifier: ${identifier}`);
    }

    const card = this.convertRecordToCard(record);
    this.catalogCardCache.set(record.id.toLowerCase(), this.cloneCard(card));
    if (record.slug) {
      this.catalogCardCache.set(record.slug.toLowerCase(), this.cloneCard(card));
    }
    this.catalogCardCache.set(record.name.toLowerCase(), this.cloneCard(card));

    return card;
  }

  private buildSpellReference(sourceCardId?: string | null, sourceCardName?: string | null): Card {
    if (sourceCardId) {
      try {
        return this.lookupCatalogCard(sourceCardId);
      } catch {
        // Fall through to generate a minimal reference if lookup fails
      }
    }
    return {
      id: sourceCardId ?? `spell_${Date.now()}`,
      name: sourceCardName ?? 'Spell',
      type: CardType.SPELL,
      text: sourceCardName ?? 'Spell effect'
    };
  }

  private convertRecordToCard(record: EnrichedCardRecord): Card {
    const domain =
      record.colors && record.colors.length > 0 ? this.mapDomain(record.colors[0]) : undefined;
    let powerCost = this.resolvePowerCost(record.cost);
    const rawCost = (record.cost?.raw ?? '').toString();
    const hasExplicitRuneSymbols = /\[[A-Za-z]+\]/.test(rawCost);
    if (!hasExplicitRuneSymbols && !record.cost?.powerCost) {
      powerCost = undefined;
    }
    const assaultSources: Array<string | null | undefined> = [
      record.effect,
      ...(record.rules ?? []).map((rule) => rule.text)
    ];
    const assaultBonus =
      assaultSources.reduce<number | null>((value, text) => {
        if (value != null) {
          return value;
        }
        return parseAssaultBonus(text);
      }, null) ?? null;
    const metadata: Record<string, unknown> = {
      setName: record.setName,
      rarity: record.rarity,
      ...(record.behaviorHints ?? {})
    };
    if (assaultBonus != null) {
      metadata.assaultBonus = assaultBonus;
    }
    const baseCard: Card = {
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
      metadata,
      text: record.effect,
      flavorText: record.flavor,
      effectProfile: record.effectProfile
    };
    const abilitySource =
      record.abilities && record.abilities.length > 0
        ? record.abilities
        : this.deriveCardAbilities(record);
    if (abilitySource.length > 0) {
      baseCard.abilities = abilitySource.map((ability) => {
        const normalized = {
          ...ability,
          operations: this.normalizeAbilityOperations(ability)
        };
        return this.cloneAbility(normalized);
      });
    }
    if (baseCard.effectProfile?.operations) {
      const effectText = record.effect ?? baseCard.text ?? '';
      const enrichedOperations =
        this.ensureTokenOperationMetadata(effectText, baseCard.effectProfile.operations) ??
        baseCard.effectProfile.operations;
      baseCard.effectProfile = {
        ...baseCard.effectProfile,
        operations: this.normalizeEffectOperations(effectText, enrichedOperations) ?? enrichedOperations
      };
    }
    return baseCard;
  }

  private cloneCard(card: Card): Card {
    return {
      ...card,
      instanceId: card.instanceId,
      powerCost: card.powerCost ? { ...card.powerCost } : undefined,
      abilities: card.abilities
        ? card.abilities.map((ability) => this.cloneAbility(ability))
        : undefined,
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

  private cloneAbility(ability: CardAbility): CardAbility {
    return {
      ...ability,
      triggerWindows: ability.triggerWindows ? [...ability.triggerWindows] : undefined,
      reactionWindows: ability.reactionWindows ? [...ability.reactionWindows] : undefined,
      effectClasses: ability.effectClasses ? [...ability.effectClasses] : undefined,
      references: ability.references ? [...ability.references] : undefined,
      targeting: ability.targeting ? { ...ability.targeting } : undefined,
      operations: ability.operations
        ? ability.operations.map((operation) => ({
            ...operation,
            metadata: operation.metadata ? { ...operation.metadata } : undefined
          }))
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

    if (!Array.isArray(this.gameState.snapshots)) {
      this.gameState.snapshots = [];
    }
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

    if (!boardCard.activationState || typeof boardCard.activationState !== 'object') {
      const activationTemplate = this.cardActivationTemplates[boardCard.id];
      const fallbackStateful =
        activationTemplate?.isStateful ?? Boolean(boardCard.activationProfile?.stateful);
      boardCard.activationState = {
        cardId: boardCard.id,
        isStateful: fallbackStateful,
        active: fallbackStateful,
        lastChangedAt: Date.now(),
        history: []
      };
    } else if (!Array.isArray(boardCard.activationState.history)) {
      boardCard.activationState.history = [];
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
    if (!Array.isArray(card.ruleLog)) {
      card.ruleLog = [];
    }
    card.ruleLog.push(
      ...card.rules.map((clause) => ({
        clauseId: clause.id,
        resolvedAt: timestamp,
        context
      }))
    );
  }

  private isBoardCard(card: Card | BoardCard): card is BoardCard {
    const candidate = card as BoardCard;
    return (
      typeof candidate.instanceId === 'string' &&
      Boolean(candidate.activationState && typeof candidate.activationState === 'object')
    );
  }

  private cardHasMechanic(card: Card | BoardCard | undefined, mechanic: string): boolean {
    if (!card || !mechanic) {
      return false;
    }
    const normalized = mechanic.trim().toLowerCase();
    if (!normalized) {
      return false;
    }
    if (normalized === 'assault') {
      const assaultBonus = this.resolveAssaultBonusValue(card);
      if (assaultBonus && assaultBonus > 0) {
        return true;
      }
    }
    const matchesList = (values?: (string | null | undefined)[]) =>
      (values ?? []).some((value) => (value ?? '').toLowerCase() === normalized);
    if (matchesList(card.keywords) || matchesList(card.tags)) {
      return true;
    }
    if (normalized === 'assault') {
      return false;
    }
    return (card.text ?? '').toLowerCase().includes(normalized);
  }

  private resolveAssaultBonusValue(card: Card | BoardCard): number | null {
    const metadata = card.metadata as { assaultBonus?: unknown } | undefined;
    if (metadata && typeof metadata.assaultBonus === 'number') {
      const stored = Number(metadata.assaultBonus);
      if (Number.isFinite(stored)) {
        return stored;
      }
    }
    const text = (card.text ?? '').toLowerCase();
    if (!text.includes('assault')) {
      return null;
    }
    if (/\bassault\b[^.]{0,80}\bequal to\b/.test(text)) {
      return null;
    }
    const bracketMatch = text.match(/\[assault(?:\s*(\d+))?\]/);
    if (bracketMatch) {
      if (bracketMatch[1]) {
        const parsed = Number(bracketMatch[1]);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
      const plusMatch = text.match(/\+(\d+)\s*(?:rb[\s_]*might|might)/);
      if (plusMatch && plusMatch[1]) {
        const parsed = Number(plusMatch[1]);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
      return 1;
    }
    const inlineMatch = text.match(/assault\s+(\d+)/);
    if (inlineMatch && inlineMatch[1]) {
      const parsed = Number(inlineMatch[1]);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return null;
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

  private deployPermanentCard(
    player: PlayerState,
    card: Card,
    options?: { destinationId?: string | null; targets?: string[] | null; accelerated?: boolean }
  ): BoardCard {
    const destinationId = options?.destinationId ?? null;
    const targets = options?.targets ?? [];
    const boardCard = this.createBoardCard(card);
    const cardType = (card.type ?? '').toLowerCase() as CardType;
    const entersZoneTapped =
      cardType === CardType.CREATURE ||
      cardType === CardType.ARTIFACT ||
      cardType === CardType.ENCHANTMENT;
    if (entersZoneTapped) {
      boardCard.isTapped = !this.cardEntersUntapped(card);
    }
    if (options?.accelerated) {
      boardCard.isTapped = false;
    }
    
    // Track if we deployed to an open battlefield (for triggering combat)
    let deployedToOpenBattlefield: BattlefieldState | null = null;
    
    switch (cardType) {
      case CardType.CREATURE:
        boardCard.location = this.resolveDeploymentLocation(player, destinationId, card);
        
        // Check if deploying to an open battlefield
        if (boardCard.location.zone === 'battlefield' && boardCard.location.battlefieldId) {
          const battlefield = this.findBattlefieldState(boardCard.location.battlefieldId);
          if (battlefield && !battlefield.controller) {
            deployedToOpenBattlefield = battlefield;
          }
        }
        
        player.board.creatures.push(boardCard);
        break;
      case CardType.ARTIFACT:
        boardCard.location = { zone: 'base' };
        player.board.artifacts.push(boardCard);
        break;
      case CardType.ENCHANTMENT:
        boardCard.location = { zone: 'base' };
        player.board.enchantments.push(boardCard);
        break;
      default:
        throw new Error('Only permanent card types can be deployed.');
    }
    this.logRuleUsage(boardCard, 'enter-play');
    this.triggerAbilities(boardCard, 'play', player, targets);
    
    // If deployed to an open battlefield, trigger combat engagement
    // This gives the opponent priority to respond before the unit conquers
    if (deployedToOpenBattlefield) {
      this.addDuelLogEntry({
        playerId: player.playerId,
        message: `${this.resolvePlayerName(player.playerId) ?? 'Player'} deploys ${boardCard.name ?? 'a unit'} directly to ${deployedToOpenBattlefield.name}.`,
        tone: 'info'
      });
      this.initiateBattlefieldEngagement(player, deployedToOpenBattlefield, boardCard.instanceId);
    }
    
    return boardCard;
  }

  private cardEntersUntapped(card: Card): boolean {
    const type = (card.type ?? '').toLowerCase().trim();
    if (type === 'gear' || type === 'artifact' || type === 'equipment') {
      return true;
    }
    const tags = (card.tags ?? []).map((tag) => tag?.toLowerCase().trim());
    if (tags.some((tag) => tag === 'gear' || tag === 'artifact' || tag === 'equipment')) {
      return true;
    }
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

  /**
   * Check what battlefield deployment options a card has.
   * This analyzes card text for phrases like:
   * - "You may play me to an open battlefield"
   * - "You may play me to an occupied enemy battlefield"
   * - "Friendly units may be played to open battlefields" (grants ability to others)
   */
  private getCardBattlefieldDeploymentPermissions(card: Card): {
    canPlayToOpenBattlefield: boolean;
    canPlayToOccupiedEnemyBattlefield: boolean;
    grantsOpenBattlefieldPlayToAllies: boolean;
  } {
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
    const normalizedText = textFragments.join(' ').toLowerCase();
    
    // "You may play me to an open battlefield"
    const canPlayToOpenBattlefield = /you may play me to an open battlefield/i.test(normalizedText);
    
    // "You may play me to an occupied enemy battlefield"
    const canPlayToOccupiedEnemyBattlefield = /you may play me to an occupied enemy battlefield/i.test(normalizedText);
    
    // "Friendly units may be played to open battlefields" (for cards that grant this to allies)
    const grantsOpenBattlefieldPlayToAllies = /friendly units may be played to open battlefields/i.test(normalizedText);
    
    return {
      canPlayToOpenBattlefield,
      canPlayToOccupiedEnemyBattlefield,
      grantsOpenBattlefieldPlayToAllies
    };
  }

  /**
   * Check if any ally on the board grants "friendly units may be played to open battlefields"
   */
  private hasAllyGrantingOpenBattlefieldDeploy(player: PlayerState): boolean {
    for (const creature of player.board.creatures) {
      // BoardCard extends Card, so we can pass creature directly
      const perms = this.getCardBattlefieldDeploymentPermissions(creature);
      if (perms.grantsOpenBattlefieldPlayToAllies) {
        return true;
      }
    }
    return false;
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
      lastCombatTurn: undefined,
      combatTurnByPlayer: {},
      effectState: {}
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
      lastCombatTurn: state.lastCombatTurn,
      lastHoldScoreTurn: state.lastHoldScoreTurn,
      combatTurnByPlayer: { ...(state.combatTurnByPlayer ?? {}) },
      effectState: state.effectState ? { ...state.effectState } : undefined
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
    options?: { points?: number; sourceCardId?: string; initiatedAttack?: boolean }
  ): void {
    const previousController = battlefield.controller ?? null;
    const alreadyControlled = previousController === player.playerId;
    battlefield.controller = player.playerId;
    battlefield.contestedBy = [];
    if (alreadyControlled) {
      battlefield.lastHoldTurn = this.turnNumber;
      return;
    }
    battlefield.lastConqueredTurn = this.turnNumber;
    battlefield.lastHoldTurn = undefined;
    const sourceCard = options?.sourceCardId ?? battlefield.card?.id ?? battlefield.battlefieldId;
    const amount = Math.max(1, options?.points ?? 1);
    const playerName = this.resolvePlayerName(player.playerId) ?? 'Player';
    const verb =
      reason === 'combat'
        ? 'conquers'
        : reason === 'objective'
          ? 'claims'
          : 'controls';
    this.addDuelLogEntry({
      playerId: player.playerId,
      message: `${playerName} ${verb} ${battlefield.name}.`,
      tone: 'success'
    });
    this.awardVictoryPoints(player, amount, reason, sourceCard);
    this.triggerBattlefieldAbility(battlefield, 'control', player);
    this.triggerUnitsOnBattlefield(battlefield.battlefieldId, player.playerId, 'conquer');
    if (!previousController) {
      this.triggerUnitsOnBattlefield(battlefield.battlefieldId, player.playerId, 'conquer_open');
    }
    if (reason === 'combat' && options?.initiatedAttack) {
      this.triggerUnitsOnBattlefield(
        battlefield.battlefieldId,
        player.playerId,
        'conquer_after_attack'
      );
    }
    this.triggerBattlefieldAbility(battlefield, 'conquer', player);
  }

  private checkBattlefieldHoldBonuses(player: PlayerState): void {
    for (const battlefield of this.gameState.battlefields) {
      if (battlefield.controller !== player.playerId) {
        continue;
      }
      if (battlefield.lastHoldScoreTurn === this.turnNumber) {
        continue;
      }
      const units = this.getUnitsOnBattlefield(battlefield.battlefieldId);
      if (units.length === 0) {
        continue;
      }
      const exclusivelyControlled = units.every((unit) => {
        const owner = this.getPlayerByCard(unit.instanceId);
        return owner.playerId === player.playerId;
      });
      if (!exclusivelyControlled) {
        continue;
      }
      battlefield.lastHoldScoreTurn = this.turnNumber;
      battlefield.lastHoldTurn = this.turnNumber;
      const sourceCardId = battlefield.card?.id ?? battlefield.battlefieldId;
      this.awardVictoryPoints(player, 1, 'hold', sourceCardId);
      this.addDuelLogEntry({
        playerId: player.playerId,
        message: `${this.resolvePlayerName(player.playerId) ?? 'Player'} holds ${battlefield.name}.`,
        tone: 'success'
      });
      this.triggerUnitsOnBattlefield(battlefield.battlefieldId, player.playerId, 'hold');
      this.triggerBattlefieldAbility(battlefield, 'hold', player);
    }
  }

  private triggerBattlefieldAbility(
    battlefield: BattlefieldState,
    triggerType: CardAbility['triggerType'] | string,
    player: PlayerState,
    context?: { boardTarget?: BoardCard; playerTarget?: PlayerState }
  ): void {
    const card = battlefield.card;
    if (!card) {
      return;
    }
    const normalizedTrigger = (triggerType ?? 'play').toLowerCase();
    const handled = this.handleSpecialBattlefieldEffect(
      battlefield,
      normalizedTrigger,
      player,
      context
    );
    if (handled) {
      return;
    }
    if (!card.abilities || card.abilities.length === 0) {
      return;
    }
    this.triggerAbilities(card, normalizedTrigger, player, undefined, {
      battlefield,
      boardTarget: context?.boardTarget,
      playerTarget: context?.playerTarget
    });
  }

  private handleSpecialBattlefieldEffect(
    battlefield: BattlefieldState,
    triggerType: string,
    player: PlayerState,
    context?: { boardTarget?: BoardCard }
  ): boolean {
    const cardId = battlefield.card?.id ?? battlefield.battlefieldId;
    switch (cardId) {
      case 'OGN-276': {
        if (triggerType !== 'setup') {
          return false;
        }
        const state = this.ensureBattlefieldEffectState(battlefield);
        if (state.victoryBoostApplied) {
          return true;
        }
        state.victoryBoostApplied = true;
        this.gameState.victoryScore += 1;
        this.gameState.players.forEach((entry) => {
          entry.victoryScore += 1;
        });
        const ownerName = this.resolvePlayerName(player.playerId) ?? 'Player';
        this.addDuelLogEntry({
          playerId: player.playerId,
          message: `${ownerName} raises the victory threshold via ${battlefield.name}.`,
          tone: 'info'
        });
        return true;
      }
      case 'OGN-293': {
        if (triggerType !== 'hold' || this.gameState.status !== GameStatus.IN_PROGRESS) {
          return false;
        }
        const friendlyUnits = this.getUnitsOnBattlefield(battlefield.battlefieldId).filter(
          (unit) => this.getPlayerByCard(unit.instanceId).playerId === player.playerId
        );
        if (friendlyUnits.length < 7) {
          return true;
        }
        const opponent = this.getOtherPlayer(player);
        this.addDuelLogEntry({
          playerId: player.playerId,
          message: `${this.resolvePlayerName(player.playerId) ?? 'Player'} commands seven units at ${
            battlefield.name
          } and claims an immediate victory!`,
          tone: 'success'
        });
        this.endGame(player, opponent, 'victory_points');
        return true;
      }
      case 'SFD-219': {
        if (triggerType !== 'hold') {
          return false;
        }
        const sourceCard = battlefield.card;
        const effectContext: EffectOperationContext | undefined = sourceCard
          ? {
              source: sourceCard,
              battlefieldTarget: battlefield,
              abilityName: sourceCard.name,
              triggerType: 'hold'
            }
          : undefined;
        for (const target of this.gameState.players) {
          const before = target.channeledRunes.length;
          this.channelRunes(target, 1, { tapped: true });
          const gained = target.channeledRunes.length - before;
          if (gained > 0 && sourceCard && effectContext) {
            this.logRuneChange(target, gained, {
              direction: 'channel',
              exhausted: true,
              context: effectContext
            });
          }
        }
        this.addDuelLogEntry({
          playerId: player.playerId,
          message: `${battlefield.name} floods both players with exhausted runes.`,
          tone: 'info'
        });
        return true;
      }
      case 'OGN-284': {
        if (triggerType !== 'turn_start') {
          return false;
        }
        const state = this.ensureBattlefieldEffectState(battlefield);
        const recipients = (state.turnStartChannel as Record<string, boolean>) ?? {};
        if (recipients[player.playerId]) {
          return true;
        }
        recipients[player.playerId] = true;
        state.turnStartChannel = recipients;
        const before = player.channeledRunes.length;
        this.channelRunes(player, 1);
        const gained = player.channeledRunes.length - before;
        if (gained > 0 && battlefield.card) {
          this.logRuneChange(player, gained, {
            direction: 'channel',
            context: {
              source: battlefield.card,
              battlefieldTarget: battlefield,
              abilityName: battlefield.card.name,
              triggerType: 'turn_start'
            }
          });
        }
        return true;
      }
      case 'OGN-290': {
        if (triggerType !== 'turn_start' || this.gameState.status !== GameStatus.IN_PROGRESS) {
          return false;
        }
        const state = this.ensureBattlefieldEffectState(battlefield);
        const rewarded = (state.turnStartPoints as Record<string, boolean>) ?? {};
        if (rewarded[player.playerId]) {
          return true;
        }
        rewarded[player.playerId] = true;
        state.turnStartPoints = rewarded;
        this.awardVictoryPoints(player, 1, 'objective', battlefield.card?.id);
        return true;
      }
      default:
        break;
    }
    if (triggerType === 'unit_move_from' && cardId === 'OGN-277' && context?.boardTarget) {
      // Back-Alley Bar grants +1 might to the moving unit for the turn.
      this.applyTemporaryEffect(context.boardTarget.instanceId, {
        id: `back_alley_${Date.now()}`,
        affectedCards: [context.boardTarget.instanceId],
        duration: 1,
        effect: {
          type: 'damage_boost',
          value: 1
        }
      });
      this.addDuelLogEntry({
        playerId: player.playerId,
        message: `${context.boardTarget.name ?? 'Unit'} leaves ${battlefield.name} invigorated.`,
        tone: 'info'
      });
      return true;
    }
    return false;
  }

  private ensureBattlefieldEffectState(battlefield: BattlefieldState): Record<string, any> {
    if (!battlefield.effectState) {
      battlefield.effectState = {};
    }
    return battlefield.effectState;
  }

  private markBattlefieldContested(battlefield: BattlefieldState, contestantId: string): void {
    if (!Array.isArray(battlefield.contestedBy)) {
      battlefield.contestedBy = [];
    }
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

  private hasCombatPriority(playerId: string): boolean {
    return (
      this.gameState.priorityWindow?.type === 'combat' &&
      this.gameState.priorityWindow?.holder === playerId &&
      Boolean(this.gameState.combatContext)
    );
  }

  private tapMovedUnit(creature: BoardCard): void {
    creature.isTapped = true;
    this.updateActivationState(creature, true, 'move');
  }

  private moveUnitToBase(
    player: PlayerState,
    creature: BoardCard,
    options?: { tap?: boolean }
  ): void {
    if (creature.location.zone === 'base') {
      throw new Error('Unit is already at your base');
    }
    const previousBattlefieldId = creature.location.battlefieldId;
    const previousBattlefield = previousBattlefieldId
      ? this.findBattlefieldState(previousBattlefieldId)
      : undefined;
    creature.location = { zone: 'base' };
    // Pass the previous battlefield context so move triggers can properly defer discard prompts
    this.triggerAbilities(creature, 'move_from_battlefield', player, undefined, {
      battlefield: previousBattlefield
    });
    if (previousBattlefield) {
      this.triggerBattlefieldAbility(previousBattlefield, 'unit_move_from', player, {
        boardTarget: creature
      });
    }
    if (options?.tap !== false) {
      this.tapMovedUnit(creature);
    } else {
      creature.isTapped = false;
      this.updateActivationState(creature, false, 'move');
    }
    if (previousBattlefieldId) {
      this.removeContestant(previousBattlefieldId, player.playerId);
    }
  }

  private moveUnitToBattlefield(
    player: PlayerState,
    creature: BoardCard,
    battlefield: BattlefieldState,
    options?: { autoEngage?: boolean; tap?: boolean }
  ): void {
    if (
      creature.location.zone === 'battlefield' &&
      creature.location.battlefieldId === battlefield.battlefieldId
    ) {
      throw new Error('Unit is already at that battlefield');
    }

    const previousLocation =
      creature.location.zone === 'battlefield' ? creature.location.battlefieldId : null;

    // Note: We skip move_from_battlefield trigger here when move_to_battlefield will also fire
    // This prevents double-triggering of "When I move" abilities for a single move action.
    // The move_from_battlefield trigger is only used when moving to base (no move_to_battlefield).
    if (previousLocation) {
      const previousBattlefield = this.findBattlefieldState(previousLocation);
      if (previousBattlefield) {
        this.triggerBattlefieldAbility(previousBattlefield, 'unit_move_from', player, {
          boardTarget: creature
        });
      }
    }

    creature.location = {
      zone: 'battlefield',
      battlefieldId: battlefield.battlefieldId
    };
    
    // Only trigger move_to_battlefield abilities if this is an auto-engage (actual combat entry)
    // This prevents effects from triggering before the player clicks "Finish moving units"
    if (options?.autoEngage !== false) {
      this.triggerAbilities(creature, 'move_to_battlefield', player);
    }
    
    this.triggerBattlefieldAbility(battlefield, 'unit_move_to', player, {
      boardTarget: creature
    });
    if (options?.tap !== false) {
      this.tapMovedUnit(creature);
    } else {
      creature.isTapped = false;
      this.updateActivationState(creature, false, 'move');
    }

    if (previousLocation) {
      this.removeContestant(previousLocation, player.playerId);
    }

    const enemyUnits = this.getUnitsOnBattlefield(battlefield.battlefieldId).filter((unit) => {
      const owner = this.getPlayerByCard(unit.instanceId);
      return owner.playerId !== player.playerId;
    });
    if (enemyUnits.length > 0) {
      this.markBattlefieldContested(battlefield, player.playerId);
      enemyUnits.forEach((unit) => {
        const owner = this.getPlayerByCard(unit.instanceId);
        this.markBattlefieldContested(battlefield, owner.playerId);
      });
    }
    if (options?.autoEngage !== false) {
      // Pass the creature's instanceId to skip triggering its move ability again
      // (it was already triggered above when autoEngage is true)
      this.initiateBattlefieldEngagement(player, battlefield, creature.instanceId);
    }
  }

  private untapAllPermanents(player: PlayerState): void {
    const untapPermanent = (permanent: BoardCard) => {
      const wasTapped = Boolean(permanent.isTapped);
      if (wasTapped) {
        permanent.isTapped = false;
      }
      if (permanent.activationState.active || wasTapped) {
        this.updateActivationState(permanent, false, 'turn-awaken');
      }
    };
    player.board.creatures.forEach(untapPermanent);
    player.board.artifacts.forEach(untapPermanent);
    player.board.enchantments.forEach(untapPermanent);
  }

  private ensureTokenOperationMetadata(
    effectText: string,
    operations?: EffectOperation[]
  ): EffectOperation[] | undefined {
    if (!operations || operations.length === 0) {
      return operations;
    }
    const needsMetadata = operations.some(
      (operation) =>
        (operation.type === 'create_token' || operation.type === 'summon_unit') &&
        !(operation.metadata && (operation.metadata as { tokenSpec?: TokenSpec }).tokenSpec)
    );
    if (!needsMetadata) {
      return operations;
    }
    const tokenSpecs = parseTokenSpecs(effectText ?? '');
    if (!tokenSpecs.length) {
      return operations;
    }
    let cursor = 0;
    return operations.map((operation) => {
      if (
        (operation.type === 'create_token' || operation.type === 'summon_unit') &&
        !(operation.metadata && (operation.metadata as { tokenSpec?: TokenSpec }).tokenSpec) &&
        cursor < tokenSpecs.length
      ) {
        const tokenSpec = tokenSpecs[cursor++];
        const metadata = {
          ...(operation.metadata ?? {}),
          tokenSpec
        };
        const magnitudeHint =
          operation.magnitudeHint == null && !tokenSpec.variableCount
            ? tokenSpec.count
            : operation.magnitudeHint;
        return {
          ...operation,
          metadata,
          magnitudeHint
        };
      }
      return { ...operation };
    });
  }

  private initiateBattlefieldEngagement(
    player: PlayerState,
    battlefield: BattlefieldState,
    skipTriggerForUnitId?: string
  ): void {
    if (
      this.gameState.combatContext &&
      this.gameState.combatContext.battlefieldId !== battlefield.battlefieldId
    ) {
      this.completeCombatEngagement();
    }
    const contestingUnits = this.getUnitsOnBattlefield(battlefield.battlefieldId);
    const attackers: BoardCard[] = [];
    const defenders: BoardCard[] = [];
    let defendingPlayerId: string | null = null;
    if (contestingUnits.length > 0) {
      contestingUnits.forEach((unit) => {
        const owner = this.getPlayerByCard(unit.instanceId);
        if (owner.playerId === player.playerId) {
          attackers.push(unit);
        } else {
          defenders.push(unit);
          defendingPlayerId = defendingPlayerId ?? owner.playerId;
        }
      });
    }
    this.currentPhase = GamePhase.COMBAT;
    this.gameState.combatContext = {
      battlefieldId: battlefield.battlefieldId,
      initiatedBy: player.playerId,
      defendingPlayerId,
      attackingUnitIds: attackers.map((unit) => unit.instanceId),
      defendingUnitIds: defenders.map((unit) => unit.instanceId),
      priorityStage: 'action',
      actionPasses: 0
    };
    this.gameState.focusPlayerId = player.playerId;
    this.openPriorityWindow('combat', player.playerId, 'battlefield-engagement');
    this.addDuelLogEntry({
      playerId: player.playerId,
      message: `${this.resolvePlayerName(player.playerId) ?? 'Player'} contests ${
        battlefield.name
      }.`
    });
    
    // Trigger move_to_battlefield abilities for units entering combat
    // Skip any unit passed via skipTriggerForUnitId (already triggered in moveUnitToBattlefield)
    // This happens before attack/defend triggers
    if (contestingUnits.length > 0) {
      contestingUnits.forEach((unit) => {
        // Skip the unit that initiated this engagement - it already had its trigger fired
        if (unit.instanceId === skipTriggerForUnitId) {
          return;
        }
        const owner = this.getPlayerByCard(unit.instanceId);
        this.triggerAbilities(unit, 'move_to_battlefield', owner);
      });
    }
    
    if (contestingUnits.length > 0) {
      if (attackers.length > 0) {
        this.triggerUnits(attackers, 'attack');
      }
      if (defenders.length > 0) {
        this.triggerUnits(defenders, 'defend');
        const defenderOwners = Array.from(
          new Set(defenders.map((unit) => this.getPlayerByCard(unit.instanceId).playerId))
        );
        defenderOwners.forEach((ownerId) => {
          const defenderPlayer = this.getPlayerById(ownerId);
          this.triggerBattlefieldAbility(battlefield, 'defend', defenderPlayer);
        });
      }
      if (attackers.length === 1 && defenders.length === 1) {
        this.triggerUnits(attackers, 'duel');
        this.triggerUnits(defenders, 'duel');
      }
    }
  }

  private completeCombatEngagement(): void {
    const context = this.gameState.combatContext;
    if (!context) {
      this.resetCombatContext();
      return;
    }
    const battlefield = this.findBattlefieldState(context.battlefieldId);
    if (!battlefield) {
      this.resetCombatContext();
      return;
    }
    this.addDuelLogEntry({
      message: `Combat at ${battlefield.name} resolves.`,
      tone: 'info'
    });
    this.resolveBattlefieldOutcome(battlefield);
    if (context.initiatedBy) {
      this.registerBattlefieldBattleForPlayer(context.initiatedBy, battlefield);
    }
    this.resetCombatContext();
    this.currentPhase = GamePhase.MAIN_1;
    const currentPlayer = this.getCurrentPlayer();
    this.openPriorityWindow('main', currentPlayer.playerId, 'post-combat');
  }

  private resetCombatContext(): void {
    this.gameState.combatContext = null;
    this.gameState.focusPlayerId = null;
    if (this.gameState.priorityWindow?.type === 'combat') {
      this.closePriorityWindow();
    }
  }

  private describeUnitList(units: BoardCard[]): string {
    if (units.length === 0) {
      return 'forces';
    }
    const names = units.map((unit) => unit.name ?? 'unit');
    if (names.length === 1) {
      return names[0];
    }
    if (names.length === 2) {
      return `${names[0]} and ${names[1]}`;
    }
    return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
  }

  private getAssaultBonus(unit: BoardCard): number {
    const context = this.gameState.combatContext;
    if (!context) {
      return 0;
    }
    const bonus = this.resolveAssaultBonusValue(unit);
    if (!bonus || bonus <= 0) {
      return 0;
    }
    const attackers = context.attackingUnitIds ?? [];
    return attackers.includes(unit.instanceId) ? bonus : 0;
  }

  private resolveBattlefieldOutcome(battlefield: BattlefieldState): void {
    const context = this.gameState.combatContext;
    const attackInitiator = context?.initiatedBy ?? null;
    const defendersPresent = Boolean(context?.defendingUnitIds?.length);
    const didInitiateAttack = (playerId: string): boolean =>
      Boolean(defendersPresent && attackInitiator && attackInitiator === playerId);
    const presence = new Map<
      string,
      { player: PlayerState; units: BoardCard[]; totalMight: number }
    >();
    const units = this.getUnitsOnBattlefield(battlefield.battlefieldId);
    units.forEach((unit) => {
      const owner = this.getPlayerByCard(unit.instanceId);
      const entry =
        presence.get(owner.playerId) ?? { player: owner, units: [], totalMight: 0 };
      entry.units.push(unit);
      const might =
        typeof unit.power === 'number'
          ? unit.power
          : typeof unit.currentToughness === 'number'
            ? unit.currentToughness
            : 0;
      if (Number.isFinite(might)) {
        entry.totalMight += might;
      }
      const assaultBonus = this.getAssaultBonus(unit);
      if (assaultBonus > 0) {
        entry.totalMight += assaultBonus;
      }
      presence.set(owner.playerId, entry);
    });
    if (presence.size === 0) {
      battlefield.controller = undefined;
      battlefield.contestedBy = [];
      return;
    }
    const groups = Array.from(presence.values()).sort((a, b) => b.totalMight - a.totalMight);
    if (groups.length === 1) {
      const uncontested = groups[0];
      const playerName = this.resolvePlayerName(uncontested.player.playerId) ?? 'Player';
      const unitsLabel = this.describeUnitList(uncontested.units);
      this.addDuelLogEntry({
        playerId: uncontested.player.playerId,
        message: `${playerName}'s ${unitsLabel} secure ${battlefield.name} uncontested (${uncontested.totalMight} might).`,
        tone: 'info'
      });
      this.triggerUnits(uncontested.units, 'combat_win');
      this.applyBattlefieldControl(groups[0].player, battlefield, 'combat', {
        sourceCardId: battlefield.card?.id ?? battlefield.battlefieldId,
        initiatedAttack: didInitiateAttack(uncontested.player.playerId)
      });
      return;
    }
    if (groups[0].totalMight === groups[1].totalMight) {
      groups.forEach((group) =>
        group.units.forEach((unit) => {
          this.destroyUnit(unit, 'combat');
        })
      );
      battlefield.controller = undefined;
      battlefield.contestedBy = [];
      this.addDuelLogEntry({
        message: `${battlefield.name} remains contested after a stalemate.`,
        tone: 'warning'
      });
      return;
    }
    const winner = groups[0];
    const losers = groups.slice(1);
    const opposingMight = losers.reduce((sum, group) => sum + group.totalMight, 0);
    const winnerName = this.resolvePlayerName(winner.player.playerId) ?? 'Player';
    const winnerUnits = this.describeUnitList(winner.units);
    this.addDuelLogEntry({
      playerId: winner.player.playerId,
      message: `${winnerName}'s ${winnerUnits} overpower the opposition ${winner.totalMight} to ${opposingMight} at ${battlefield.name}.`,
      tone: 'success'
    });
    losers.forEach((group) =>
      group.units.forEach((unit) => {
        this.destroyUnit(unit, 'combat');
      })
    );
    this.triggerUnits(winner.units, 'combat_win');
    this.applyBattlefieldControl(winner.player, battlefield, 'combat', {
      sourceCardId: battlefield.card?.id ?? battlefield.battlefieldId,
      initiatedAttack: didInitiateAttack(winner.player.playerId)
    });
  }

  private handleCombatPriorityPass(player: PlayerState): void {
    const context = this.gameState.combatContext;
    if (!context) {
      return;
    }
    this.addDuelLogEntry({
      playerId: player.playerId,
      message: `${this.resolvePlayerName(player.playerId) ?? 'Player'} passes priority.`,
      tone: 'info'
    });
    if (context.priorityStage === 'reaction') {
      const nextHolder =
        context.lastActionPlayerId ?? this.getOtherPlayer(player).playerId;
      context.priorityStage = 'action';
      this.gameState.focusPlayerId = nextHolder;
      this.openPriorityWindow('combat', nextHolder, 'battlefield-engagement');
      return;
    }
    context.actionPasses += 1;
    if (context.actionPasses >= 2) {
      this.completeCombatEngagement();
      return;
    }
    const opponent = this.getOtherPlayer(player);
    this.gameState.focusPlayerId = opponent.playerId;
    this.openPriorityWindow('combat', opponent.playerId, 'battlefield-engagement');
  }

  private advanceCombatPriorityAfterPlay(
    player: PlayerState,
    stage: 'action' | 'reaction' | null
  ): void {
    if (!stage || !this.gameState.combatContext) {
      return;
    }
    const playerName = this.resolvePlayerName(player.playerId) ?? 'Player';
    const timingLabel = stage === 'reaction' ? 'reaction' : 'action';
    this.addDuelLogEntry({
      playerId: player.playerId,
      message: `${playerName} resolves a ${timingLabel}.`,
      tone: 'info'
    });
    if (stage === 'action') {
      this.gameState.combatContext.lastActionPlayerId = player.playerId;
      this.gameState.combatContext.priorityStage = 'reaction';
      this.gameState.combatContext.actionPasses = 0;
      const opponent = this.getOtherPlayer(player);
      this.gameState.focusPlayerId = player.playerId;
      this.openPriorityWindow('combat', opponent.playerId, 'battlefield-engagement');
      return;
    }
    const lastActor =
      this.gameState.combatContext.lastActionPlayerId ?? this.getOtherPlayer(player).playerId;
    this.gameState.combatContext.priorityStage = 'action';
    this.gameState.focusPlayerId = lastActor;
    this.openPriorityWindow('combat', lastActor, 'battlefield-engagement');
  }

  private readySummonedCreatures(player: PlayerState): void {
    for (const creature of player.board.creatures) {
      if (creature.summoned) {
        creature.summoned = false;
      }
    }
  }

  private readyChampions(player: PlayerState): void {
    if (player.championLegend) {
      player.championLegend.isTapped = false;
    }
    if (player.championLeader) {
      player.championLeader.isTapped = false;
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
    this.refreshChampionAvailability();
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
