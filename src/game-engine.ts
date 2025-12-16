import {
  ActivationProfile,
  CardActivationState,
  CardAssetInfo,
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
  ENCHANTMENT = 'enchantment'
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
}

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
}

export interface ResourcePool {
  energy: number;
  power: Record<Domain, number>;
  universalPower: number;
}

export interface PlayerDeckConfig {
  mainDeck: DeckCardEntry[];
  runeDeck?: RuneCard[];
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

export interface ScoreEvent {
  playerId: string;
  amount: number;
  reason: ScoreReason;
  sourceCardId?: string;
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
  IN_PROGRESS = 'in_progress',
  WINNER_DETERMINED = 'winner_determined',
  COMPLETED = 'completed'
}

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
}

export interface GameMove {
  playerIndex: number;
  turn: number;
  phase: GamePhase;
  action: 'play_card' | 'attack' | 'pass' | 'activate_ability' | 'end_turn';
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

// ============================================================================
// GAME ENGINE CLASS
// ============================================================================

export class RiftboundGameEngine {
  private gameState: GameState;
  private readonly MAX_HAND_SIZE = 7;
  private readonly INITIAL_HAND_SIZE = 4;
  private readonly VICTORY_SCORE = 8;
  private readonly COMBAT_POINTS_PER_DAMAGE = 3;
  private readonly SUPPORT_POINTS_PER_VALUE = 5;
  private readonly MIN_DECK_SIZE = 39;
  private readonly RUNE_DECK_SIZE = 12;
  private readonly RUNES_PER_TURN = 2;
  private readonly cardActivationTemplates = buildActivationStateIndex();
  private readonly catalogCardCache = new Map<string, Card>();

  constructor(matchId: string, players: string[]) {
    if (players.length !== 2) {
      throw new Error('Riftbound requires exactly 2 players');
    }

    this.gameState = {
      matchId,
      players: players.map((playerId) => this.createPlayerState(playerId)),
      currentPlayerIndex: 0,
      currentPhase: GamePhase.BEGIN,
      turnNumber: 1,
      status: GameStatus.SETUP,
      moveHistory: [],
      timestamp: Date.now(),
      victoryScore: this.VICTORY_SCORE,
      scoreLog: []
    };
  }

  // ========================================================================
  // INITIALIZATION
  // ========================================================================

  private createPlayerState(playerId: string): PlayerState {
    return {
      playerId,
      name: playerId,
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
      temporaryEffects: []
    };
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

      const mainDeckInput = Array.isArray(deckConfig) ? deckConfig : deckConfig.mainDeck;
      const normalizedMainDeck = this.buildDeckFromConfig(mainDeckInput);
      if (!normalizedMainDeck || normalizedMainDeck.length < this.MIN_DECK_SIZE) {
        throw new Error(`Invalid deck size for player ${player.playerId} (min ${this.MIN_DECK_SIZE})`);
      }

      const runeDeckConfig = Array.isArray(deckConfig) ? undefined : deckConfig.runeDeck;
      const runeDeck = runeDeckConfig && runeDeckConfig.length > 0
        ? runeDeckConfig
        : this.generateFallbackRuneDeck();

      if (runeDeck.length < this.RUNE_DECK_SIZE) {
        throw new Error(`Invalid rune deck for player ${player.playerId} (requires ${this.RUNE_DECK_SIZE})`);
      }

      player.deck = [...normalizedMainDeck];
      player.runeDeck = [...runeDeck];
      player.channeledRunes = [];
      this.shuffle(player.deck);
      this.shuffle(player.runeDeck);
      this.drawCards(player, this.INITIAL_HAND_SIZE);
    }

    this.gameState.status = GameStatus.IN_PROGRESS;
  }

  // ========================================================================
  // PHASE MANAGEMENT
  // ========================================================================

  /**
   * Begin turn: restore mana and draw a card
   */
  public beginTurn(): void {
    const currentPlayer = this.getCurrentPlayer();

    // Channel runes to generate resources
    this.channelRunes(currentPlayer, this.RUNES_PER_TURN);

    // Draw a card
    this.drawCards(currentPlayer, 1);

    // Untap all permanents
    this.untapAllPermanents(currentPlayer);
    this.readySummonedCreatures(currentPlayer);

    // Resolve temporary effects that expire at turn start
    this.resolveTemporaryEffects(currentPlayer);

    this.currentPhase = GamePhase.MAIN_1;
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

      player.channeledRunes.push(rune);

      const energyValue = rune.energyValue ?? 1;
      player.resources.energy += energyValue;

      if (rune.domain) {
        const powerGain = rune.powerValue ?? 1;
        player.resources.power[rune.domain] += powerGain;
      } else {
        player.resources.universalPower += rune.powerValue ?? 1;
      }
    }
    this.syncLegacyMana(player);
  }

  /**
   * Proceed to next phase
   */
  public proceedToNextPhase(): void {
    switch (this.currentPhase) {
      case GamePhase.BEGIN:
        this.beginTurn();
        break;
      case GamePhase.MAIN_1:
        this.currentPhase = GamePhase.COMBAT;
        break;
      case GamePhase.COMBAT:
        this.currentPhase = GamePhase.MAIN_2;
        break;
      case GamePhase.MAIN_2:
        this.currentPhase = GamePhase.END;
        this.resolveEndOfTurnEffects(this.getCurrentPlayer());
        break;
      case GamePhase.END:
        this.currentPhase = GamePhase.CLEANUP;
        this.discardDownToHandSize(this.getCurrentPlayer());
        this.endTurn();
        break;
      case GamePhase.CLEANUP:
        break;
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
  }

  // ========================================================================
  // CARD PLAY RULES
  // ========================================================================

  /**
   * Play a card from hand to board
   */
  public playCard(playerId: string, cardIndex: number, targets?: string[]): void {
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
    switch (card.type) {
      case CardType.CREATURE:
        player.board.creatures.push(boardCard);
        this.logRuleUsage(boardCard, 'enter-play');
        this.triggerAbilities(boardCard, 'play', player, targets);
        break;
      case CardType.SPELL:
        this.resolveSpell(card, player, targets);
        player.graveyard.push(card);
        break;
      case CardType.ARTIFACT:
        player.board.artifacts.push(boardCard);
        this.logRuleUsage(boardCard, 'enter-play');
        this.triggerAbilities(boardCard, 'play', player, targets);
        break;
      case CardType.ENCHANTMENT:
        player.board.enchantments.push(boardCard);
        this.logRuleUsage(boardCard, 'enter-play');
        this.triggerAbilities(boardCard, 'play', player, targets);
        break;
    }

    this.recordMove('play_card', card.id, targets?.[0]);
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
      if (!boardTarget && !playerTarget) {
        throw new Error('Target not found on board or among players');
      }
    }
  }

  private getCardCost(card: Card): CardCost {
    const energy = card.energyCost ?? card.manaCost ?? 0;
    const power =
      card.powerCost ??
      (card.domain
        ? {
            [card.domain]: 1
          }
        : {});

    return {
      energy,
      power
    };
  }

  private canPayCost(player: PlayerState, cost: CardCost): boolean {
    if (player.resources.energy < cost.energy) {
      return false;
    }

    let universal = player.resources.universalPower;
    for (const domainKey of Object.keys(cost.power) as Domain[]) {
      const required = cost.power[domainKey] ?? 0;
      if (required === 0) {
        continue;
      }
      const available = player.resources.power[domainKey] ?? 0;
      if (available >= required) {
        continue;
      }
      const deficit = required - available;
      universal -= deficit;
      if (universal < 0) {
        return false;
      }
    }

    return true;
  }

  private payCardCost(player: PlayerState, cost: CardCost): void {
    player.resources.energy = Math.max(0, player.resources.energy - cost.energy);

    let universal = player.resources.universalPower;
    for (const domainKey of Object.keys(cost.power) as Domain[]) {
      let required = cost.power[domainKey] ?? 0;
      if (required === 0) {
        continue;
      }

      const available = player.resources.power[domainKey] ?? 0;
      const spendFromDomain = Math.min(available, required);
      player.resources.power[domainKey] = available - spendFromDomain;
      required -= spendFromDomain;

      if (required > 0) {
        universal -= required;
        required = 0;
      }
    }

    player.resources.universalPower = Math.max(0, universal);
    this.syncLegacyMana(player);
  }

  // ========================================================================
  // COMBAT
  // ========================================================================

  /**
   * Declare an attacker
   */
  public declareAttacker(playerId: string, creatureInstanceId: string, defenderId?: string): void {
    const player = this.getPlayerById(playerId);
    if (player.playerId !== this.getCurrentPlayer().playerId) {
      throw new Error('Not your turn');
    }

    if (this.currentPhase !== GamePhase.COMBAT) {
      throw new Error('Cannot attack outside combat phase');
    }

    const creature = player.board.creatures.find((c) => c.instanceId === creatureInstanceId);
    if (!creature) {
      throw new Error('Creature not found');
    }

    if (creature.isTapped) {
      throw new Error('Creature is tapped');
    }

    if (creature.summoned) {
      throw new Error('Creature cannot attack the turn it was summoned');
    }

    creature.isTapped = true;
    this.recordMove('attack', creature.id, defenderId);
  }

  /**
   * Resolve combat damage
   */
  public resolveCombat(
    attackerInstanceId: string,
    defenderPlayerId: string,
    blocked: boolean
  ): void {
    const attacker = this.findCardInstance(attackerInstanceId);
    if (!attacker || attacker.type !== CardType.CREATURE) {
      throw new Error('Invalid attacker');
    }

    const defender = this.getPlayerById(defenderPlayerId);
    const damage = (attacker as any).power || 0;

    if (blocked) {
      // Combat between creatures - would need blocker info
      // Simplified for now
    } else {
      // Direct damage to player
      const controller = this.getPlayerByCard(attacker.instanceId);
      this.damagePlayer(defender, damage, attacker, controller);
    }
  }

  // ========================================================================
  // DAMAGE AND HEALING
  // ========================================================================

  /**
   * Deal damage to a player
   */
  private damagePlayer(
    player: PlayerState,
    amount: number,
    source: Card,
    controller?: PlayerState
  ): void {
    let actualDamage = amount;

    // Check for damage prevention effects
    for (const effect of player.temporaryEffects) {
      if (effect.effect.type === 'prevent_damage') {
        const prevented = Math.min(actualDamage, effect.effect.value || 0);
        actualDamage -= prevented;
        effect.duration--;
      }
    }

    const scoringPlayer =
      controller ??
      (this.isBoardCard(source) ? this.getPlayerByCard(source.instanceId) : this.getOtherPlayer(player));
    if (actualDamage > 0) {
      const pointsEarned = this.pointsFromCombat(actualDamage);
      if (pointsEarned > 0) {
        this.awardVictoryPoints(scoringPlayer, pointsEarned, 'combat', source.id);
      }
    }

    this.triggerAbilities(source, 'damage', scoringPlayer, [player.playerId]);
  }

  /**
   * Heal a player
   */
  public healPlayer(playerId: string, amount: number): void {
    const player = this.getPlayerById(playerId);
    if (amount <= 0) return;
    const supportPoints = Math.floor(amount / this.SUPPORT_POINTS_PER_VALUE);
    if (supportPoints > 0) {
      this.awardVictoryPoints(player, supportPoints, 'support');
    }
  }

  private pointsFromCombat(amount: number): number {
    if (amount <= 0) return 0;
    if (amount < this.COMBAT_POINTS_PER_DAMAGE) {
      return 1;
    }
    return Math.floor(amount / this.COMBAT_POINTS_PER_DAMAGE);
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
        if (player.hand.length >= this.MAX_HAND_SIZE) {
          // Discard if hand is full
          player.graveyard.push(card);
        } else {
          player.hand.push(card);
        }
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

  /**
   * Discard down to hand size limit
   */
  private discardDownToHandSize(player: PlayerState): void {
    while (player.hand.length > this.MAX_HAND_SIZE) {
      const cardIndex = Math.floor(Math.random() * player.hand.length);
      const card = player.hand.splice(cardIndex, 1)[0];
      player.graveyard.push(card);
    }
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
    const profile = spell.activationProfile;

    if (profile) {
      if (profile.actions.includes('draw')) {
        this.drawCards(caster, 1);
      }

      if (profile.actions.includes('heal')) {
        const recipient = playerTarget ?? caster;
        this.healPlayer(recipient.playerId, 3);
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

      if (profile.actions.includes('recover')) {
        this.healPlayer(caster.playerId, 2);
      }
    } else {
      const spellName = spell.name.toLowerCase();

      if (spellName.includes('fireball') || spellName.includes('bolt')) {
        if (boardTarget && boardTarget.type === CardType.CREATURE) {
          const damage = 3;
          this.damageCreature(boardTarget, damage, spell);
        }
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

      if (spellName.includes('heal') || spellName.includes('recover')) {
        this.healPlayer(caster.playerId, 3);
      }
    }

    this.logRuleUsage(spell, 'spell-resolution');
  }

  /**
   * Damage a creature
   */
  private damageCreature(creature: BoardCard, amount: number, _source: Card): void {
    creature.currentToughness -= amount;

    if (creature.currentToughness <= 0) {
      // Destroy the creature
      this.updateActivationState(creature, false, 'destroyed');
      const player = this.getPlayerByCard(creature.instanceId);
      const typeArray =
        creature.type === CardType.CREATURE
          ? player.board.creatures
          : creature.type === CardType.ARTIFACT
            ? player.board.artifacts
            : player.board.enchantments;

      const index = typeArray.findIndex((c) => c.instanceId === creature.instanceId);
      if (index !== -1) {
        const destroyed = typeArray.splice(index, 1)[0];
        player.graveyard.push(destroyed);
        this.triggerAbilities(destroyed, 'death', player);
      }
    }
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
      if (targets?.[0]) {
        const targetPlayer = this.getPlayerById(targets[0]);
        this.damagePlayer(targetPlayer, 2, card, player);
      }
    }

    if (abilityName.includes('heal')) {
      this.healPlayer(player.playerId, 2);
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
      materialized.forEach((card) => cards.push(this.cloneCard(card)));
    }
    return cards;
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
      powerCost: this.mapPowerSymbols(record.cost.powerSymbols),
      domain,
      power: record.might ?? undefined,
      toughness: record.might ?? undefined,
      activationProfile: record.activation,
      rules: record.rules,
      assets: record.assets,
      metadata: {
        setName: record.setName,
        rarity: record.rarity
      },
      text: record.effect,
      flavorText: record.flavor
    };
  }

  private cloneCard(card: Card): Card {
    return {
      ...card,
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
      assets: card.assets ? { ...card.assets } : undefined
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

  private mapPowerSymbols(symbols: string[]): DomainCost {
    return symbols.reduce<DomainCost>((acc, symbol) => {
      const domain = this.symbolToDomain(symbol);
      if (domain) {
        acc[domain] = (acc[domain] ?? 0) + 1;
      }
      return acc;
    }, {});
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

  private createBoardCard(card: Card): BoardCard {
    const activationTemplate = this.cardActivationTemplates[card.id];
    const initialActive = activationTemplate?.isStateful ?? Boolean(card.activationProfile?.stateful);
    const timestamp = Date.now();
    return {
      ...this.cloneCard(card),
      instanceId: `${card.id}_${timestamp}_${Math.random()}`,
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
      ruleLog: []
    };
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
