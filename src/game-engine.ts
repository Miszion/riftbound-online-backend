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
  LEGENDARY = 'legendary'
}

export interface Card {
  id: string;
  name: string;
  type: CardType;
  rarity: CardRarity;
  manaCost: number;
  power?: number;
  toughness?: number;
  abilities?: CardAbility[];
  text: string;
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

export interface BoardCard extends Card {
  instanceId: string;
  currentToughness: number;
  isTapped: boolean;
  summoned: boolean; // Can't attack same turn it's summoned
  counters?: Record<string, number>;
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
  health: number;
  maxHealth: number;
  mana: number;
  maxMana: number;
  deck: Card[];
  hand: Card[];
  graveyard: Card[];
  exile: Card[];
  board: PlayerBoard;
  temporaryEffects: TemporaryEffect[];
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
  reason: 'health_depletion' | 'deck_empty' | 'concede' | 'timeout';
  duration: number;
  turns: number;
  moves: GameMove[];
}

// ============================================================================
// GAME ENGINE CLASS
// ============================================================================

export class RiftboundGameEngine {
  private gameState: GameState;
  private readonly MAX_HAND_SIZE = 10;
  private readonly STARTING_HEALTH = 20;
  private readonly STARTING_MANA = 3;
  private readonly MAX_MANA = 10;
  private readonly DECK_SIZE = 60;

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
      timestamp: Date.now()
    };
  }

  // ========================================================================
  // INITIALIZATION
  // ========================================================================

  private createPlayerState(playerId: string): PlayerState {
    return {
      playerId,
      name: playerId,
      health: this.STARTING_HEALTH,
      maxHealth: this.STARTING_HEALTH,
      mana: 0,
      maxMana: this.STARTING_MANA,
      deck: [],
      hand: [],
      graveyard: [],
      exile: [],
      board: {
        playerId,
        creatures: [],
        artifacts: [],
        enchantments: []
      },
      temporaryEffects: []
    };
  }

  /**
   * Initialize the game with player decks
   */
  public initializeGame(decksByPlayerId: Record<string, Card[]>): void {
    if (this.gameState.status !== GameStatus.SETUP) {
      throw new Error('Game already initialized');
    }

    for (const player of this.gameState.players) {
      const deck = decksByPlayerId[player.playerId];
      if (!deck || deck.length !== this.DECK_SIZE) {
        throw new Error(`Invalid deck size for player ${player.playerId}`);
      }
      player.deck = [...deck];
      this.drawCards(player, 7);
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

    // Draw a card (except on turn 1)
    if (this.turnNumber > 1) {
      this.drawCards(currentPlayer, 1);
    }

    // Restore mana
    currentPlayer.maxMana = Math.min(currentPlayer.maxMana + 1, this.MAX_MANA);
    currentPlayer.mana = currentPlayer.maxMana;

    // Untap all permanents
    this.untapAllPermanents(currentPlayer);

    // Resolve temporary effects that expire at turn start
    this.resolveTemporaryEffects(currentPlayer);

    this.currentPhase = GamePhase.MAIN_1;
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

    if (player.mana < card.manaCost) {
      throw new Error('Insufficient mana');
    }

    // Validate targets
    if (targets) {
      this.validateTargets(card, targets);
    }

    // Remove from hand
    player.hand.splice(cardIndex, 1);
    player.mana -= card.manaCost;

    // Place on board based on card type
    const boardCard = this.createBoardCard(card);
    switch (card.type) {
      case CardType.CREATURE:
        player.board.creatures.push(boardCard);
        this.triggerAbilities(card, 'play', player, targets);
        break;
      case CardType.SPELL:
        this.resolveSpell(card, player, targets);
        player.graveyard.push(card);
        break;
      case CardType.ARTIFACT:
        player.board.artifacts.push(boardCard);
        this.triggerAbilities(card, 'play', player, targets);
        break;
      case CardType.ENCHANTMENT:
        player.board.enchantments.push(boardCard);
        this.triggerAbilities(card, 'play', player, targets);
        break;
    }

    this.recordMove('play_card', String(cardIndex), targets?.[0]);
  }

  /**
   * Validate that targets are legal
   */
  private validateTargets(_card: Card, targets: string[]): void {
    // Implementation depends on specific card abilities
    // This is a placeholder for target validation
    if (targets.length > 0 && !targets[0]) {
      throw new Error('Invalid target');
    }
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
      this.damagePlayer(defender, damage, attacker);
    }
  }

  // ========================================================================
  // DAMAGE AND HEALING
  // ========================================================================

  /**
   * Deal damage to a player
   */
  private damagePlayer(player: PlayerState, amount: number, source: Card): void {
    let actualDamage = amount;

    // Check for damage prevention effects
    for (const effect of player.temporaryEffects) {
      if (effect.effect.type === 'prevent_damage') {
        const prevented = Math.min(actualDamage, effect.effect.value || 0);
        actualDamage -= prevented;
        effect.duration--;
      }
    }

    player.health -= actualDamage;

    // Check for lethal
    if (player.health <= 0) {
      this.endGame(this.getOtherPlayer(player), player, 'health_depletion');
    }

    this.triggerAbilities(source, 'damage', this.getPlayerById(source.id), [player.playerId]);
  }

  /**
   * Heal a player
   */
  public healPlayer(playerId: string, amount: number): void {
    const player = this.getPlayerById(playerId);
    player.health = Math.min(player.health + amount, player.maxHealth);
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
        // Mill the player (deck is empty)
        this.endGame(this.getOtherPlayer(player), player, 'deck_empty');
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
    const spellName = spell.name.toLowerCase();

    // DAMAGE SPELLS
    if (spellName.includes('fireball') || spellName.includes('bolt')) {
      const target = targets?.[0];
      if (target) {
        const targetCard = this.findCardInstance(target);
        if (targetCard && targetCard.type === CardType.CREATURE) {
          const damage = 3; // Standard damage amount
          this.damageCreature(targetCard, damage, spell);
        }
      }
    }

    // DRAW SPELLS
    if (spellName.includes('draw') || spellName.includes('cycle')) {
      this.drawCards(caster, 1);
    }

    // BUFF SPELLS
    if (spellName.includes('buff') || spellName.includes('boost')) {
      const target = targets?.[0];
      if (target) {
        this.applyTemporaryEffect(target, {
          id: `buff_${Date.now()}`,
          affectedCards: [target],
          duration: 1,
          effect: {
            type: 'damage_boost',
            value: 2
          }
        });
      }
    }

    // HEAL SPELLS
    if (spellName.includes('heal') || spellName.includes('recover')) {
      this.healPlayer(caster.playerId, 3);
    }
  }

  /**
   * Damage a creature
   */
  private damageCreature(creature: BoardCard, amount: number, _source: Card): void {
    creature.currentToughness -= amount;

    if (creature.currentToughness <= 0) {
      // Destroy the creature
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
    if (!card.abilities) return;

    for (const ability of card.abilities) {
      if (ability.triggerType === triggerType) {
        this.resolveAbility(ability, card, player, targets);
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
    // Ability resolution logic based on ability name
    const abilityName = ability.name.toLowerCase();

    if (abilityName.includes('draw')) {
      this.drawCards(player, 1);
    }

    if (abilityName.includes('damage')) {
      if (targets?.[0]) {
        const targetPlayer = this.getPlayerById(targets[0]);
        this.damagePlayer(targetPlayer, 2, card);
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
  }

  /**
   * Resolve temporary effects that expire
   */
  private resolveTemporaryEffects(player: PlayerState): void {
    player.temporaryEffects = player.temporaryEffects.filter((effect) => {
      effect.duration--;
      return effect.duration > 0;
    });
  }

  /**
   * Resolve end-of-turn effects
   */
  private resolveEndOfTurnEffects(player: PlayerState): void {
    // Trigger end-of-turn abilities
    for (const _creature of player.board.creatures) {
      // Check for end-of-turn triggers
    }
  }

  // ========================================================================
  // HELPERS
  // ========================================================================

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
    return {
      ...card,
      instanceId: `${card.id}_${Date.now()}_${Math.random()}`,
      currentToughness: card.toughness || 0,
      isTapped: false,
      summoned: true,
      counters: {}
    };
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
    _reason: 'health_depletion' | 'deck_empty' | 'concede' | 'timeout'
  ): void {
    this.gameState.status = GameStatus.WINNER_DETERMINED;
    this.gameState.winner = winner.playerId;
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
      reason: 'health_depletion',
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
