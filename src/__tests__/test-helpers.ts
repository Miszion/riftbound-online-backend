/**
 * Shared test helpers and fixtures for Riftbound game engine tests.
 */
import {
  RiftboundGameEngine,
  Card,
  CardType,
  CardRarity,
  Domain,
  RuneCard,
  PlayerDeckConfig,
  GameStatus,
  GamePhase,
  GameState
} from '../game-engine';

// ---------------------------------------------------------------------------
// Card Factories
// ---------------------------------------------------------------------------

let cardCounter = 0;

export function makeCreature(overrides: Partial<Card> = {}): Card {
  cardCounter++;
  return {
    id: `test-creature-${cardCounter}`,
    slug: `test-creature-${cardCounter}`,
    name: `Test Creature ${cardCounter}`,
    type: CardType.CREATURE,
    rarity: CardRarity.COMMON,
    setName: 'Test',
    colors: [],
    tags: [],
    keywords: [],
    manaCost: 0,
    energyCost: 2,
    powerCost: undefined,
    domain: Domain.FURY,
    power: 3,
    toughness: 3,
    abilities: [],
    activationProfile: undefined,
    rules: [],
    assets: undefined,
    metadata: {},
    text: 'A test creature.',
    flavorText: null,
    effectProfile: undefined,
    ...overrides
  };
}

export function makeSpell(overrides: Partial<Card> = {}): Card {
  cardCounter++;
  return {
    id: `test-spell-${cardCounter}`,
    slug: `test-spell-${cardCounter}`,
    name: `Test Spell ${cardCounter}`,
    type: CardType.SPELL,
    rarity: CardRarity.COMMON,
    setName: 'Test',
    colors: [],
    tags: [],
    keywords: [],
    manaCost: 0,
    energyCost: 1,
    powerCost: undefined,
    domain: Domain.MIND,
    power: undefined,
    toughness: undefined,
    abilities: [],
    activationProfile: undefined,
    rules: [],
    assets: undefined,
    metadata: {},
    text: 'A test spell.',
    flavorText: null,
    effectProfile: undefined,
    ...overrides
  };
}

export function makeArtifact(overrides: Partial<Card> = {}): Card {
  cardCounter++;
  return {
    id: `test-artifact-${cardCounter}`,
    slug: `test-artifact-${cardCounter}`,
    name: `Test Artifact ${cardCounter}`,
    type: CardType.ARTIFACT,
    rarity: CardRarity.RARE,
    setName: 'Test',
    colors: [],
    tags: [],
    keywords: [],
    manaCost: 0,
    energyCost: 3,
    powerCost: undefined,
    domain: Domain.ORDER,
    power: undefined,
    toughness: undefined,
    abilities: [],
    activationProfile: undefined,
    rules: [],
    assets: undefined,
    metadata: {},
    text: 'A test artifact.',
    flavorText: null,
    effectProfile: undefined,
    ...overrides
  };
}

export function makeRuneCard(index: number, domain?: Domain): RuneCard {
  const d = domain ?? Object.values(Domain)[index % 6];
  return {
    id: `test-rune-${index}`,
    name: `Test Rune ${index}`,
    domain: d,
    energyValue: 1,
    powerValue: 1,
    slug: `test-rune-${index}`,
    assets: null,
    isTapped: false,
    cardSnapshot: null
  };
}

// ---------------------------------------------------------------------------
// Deck Factories
// ---------------------------------------------------------------------------

/** Build a valid main deck of N creature cards (default 40 to meet the 39 minimum). */
export function buildMainDeck(size = 40): Card[] {
  return Array.from({ length: size }, (_, i) =>
    makeCreature({ id: `deck-creature-${i}`, name: `Deck Creature ${i}` })
  );
}

/** Build a valid rune deck of 12 runes. */
export function buildRuneDeck(): RuneCard[] {
  return Array.from({ length: 12 }, (_, i) => makeRuneCard(i));
}

/** Build a full PlayerDeckConfig with main deck, rune deck, and battlefields. */
export function buildDeckConfig(overrides: Partial<PlayerDeckConfig> = {}): PlayerDeckConfig {
  return {
    mainDeck: buildMainDeck(),
    runeDeck: buildRuneDeck(),
    battlefields: [
      makeCreature({
        id: 'battlefield-1',
        name: 'Test Battlefield Alpha',
        type: CardType.ENCHANTMENT,
        tags: ['Battlefield'],
        text: 'A test battlefield.'
      })
    ],
    championLegend: null,
    championLeader: null,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Engine Helpers
// ---------------------------------------------------------------------------

/** Create a new engine with two players and initialized decks. */
export function createInitializedEngine(
  matchId = 'test-match-1',
  p1 = 'player-1',
  p2 = 'player-2'
): RiftboundGameEngine {
  const engine = new RiftboundGameEngine(matchId, [p1, p2]);
  engine.initializeGame({
    [p1]: buildDeckConfig(),
    [p2]: buildDeckConfig()
  });
  return engine;
}

/**
 * Advance the engine through coin flip phase.
 * Both players pick choice 0 and 1 respectively to guarantee a winner.
 */
export function advancePastCoinFlip(engine: RiftboundGameEngine, p1 = 'player-1', p2 = 'player-2'): void {
  if (engine.status !== GameStatus.COIN_FLIP) return;
  // Choice 0 beats choice 1 (Blade beats Shield)
  engine.submitInitiativeChoice(p1, 0);
  engine.submitInitiativeChoice(p2, 1);
  // If it was a tie, try again with different choices
  if (engine.status === GameStatus.COIN_FLIP) {
    engine.submitInitiativeChoice(p1, 2);
    engine.submitInitiativeChoice(p2, 0);
  }
}

/** Advance past battlefield selection by having both players pick their first available. */
export function advancePastBattlefieldSelection(engine: RiftboundGameEngine, p1 = 'player-1', p2 = 'player-2'): void {
  if (engine.status !== GameStatus.BATTLEFIELD_SELECTION) return;
  const state = engine.getGameState();
  const p1Prompts = state.prompts.filter(p => p.type === 'battlefield' && p.playerId === p1 && !p.resolved);
  const p2Prompts = state.prompts.filter(p => p.type === 'battlefield' && p.playerId === p2 && !p.resolved);

  if (p1Prompts.length > 0) {
    const options = (p1Prompts[0].data as any).options;
    if (options && options.length > 0) {
      engine.selectBattlefield(p1, options[0].id || options[0].battlefieldId);
    }
  }
  if (engine.status === GameStatus.BATTLEFIELD_SELECTION && p2Prompts.length > 0) {
    const options = (p2Prompts[0].data as any).options;
    if (options && options.length > 0) {
      engine.selectBattlefield(p2, options[0].id || options[0].battlefieldId);
    }
  }
}

/** Advance past mulligan by keeping all cards. */
export function advancePastMulligan(engine: RiftboundGameEngine, p1 = 'player-1', p2 = 'player-2'): void {
  if (engine.status !== GameStatus.MULLIGAN) return;
  engine.submitMulligan(p1, []);
  engine.submitMulligan(p2, []);
}

/**
 * Create a fully set up engine in IN_PROGRESS state.
 * Skips coin flip, battlefield selection, and mulligan phases.
 */
export function createInProgressEngine(
  matchId = 'test-match-1',
  p1 = 'player-1',
  p2 = 'player-2'
): RiftboundGameEngine {
  const engine = createInitializedEngine(matchId, p1, p2);
  advancePastCoinFlip(engine, p1, p2);
  advancePastBattlefieldSelection(engine, p1, p2);
  advancePastMulligan(engine, p1, p2);
  return engine;
}

/** Reset the card counter between tests to keep IDs predictable. */
export function resetCardCounter(): void {
  cardCounter = 0;
}
