import { queryResolvers } from './resolvers';

export const matchServiceTypeDefs = `#graphql
  scalar DateTime
  scalar JSON

  type CardAssetInfo {
    remote: String
    localPath: String!
  }

  type CardLocationState {
    zone: String!
    battlefieldId: ID
  }

  type CardActivationStateEntry {
    cardId: ID!
    isStateful: Boolean!
    active: Boolean!
    lastChangedAt: DateTime
    history: [ActivationHistoryEntry!]!
  }

  type ActivationHistoryEntry {
    at: DateTime
    reason: String!
    active: Boolean!
  }

  type Card {
    cardId: String!
    instanceId: ID
    name: String!
    type: String!
    rarity: String
    cost: Int
    power: Int
    toughness: Int
    currentToughness: Int
    keywords: [String!]
    tags: [String!]
    abilities: [String!]
    text: String
    assets: CardAssetInfo
    isTapped: Boolean
    summoned: Boolean
    counters: JSON
    activationState: CardActivationStateEntry
    location: CardLocationState
  }

  type CardSnapshot {
    cardId: String
    slug: String
    name: String
    type: String
    rarity: String
    colors: [String!]
    keywords: [String!]
    effect: String
    assets: CardAssetInfo
  }

  type BattlefieldState {
    battlefieldId: ID!
    slug: String
    name: String!
    ownerId: ID!
    controller: ID
    contestedBy: [ID!]!
    lastConqueredTurn: Int
    lastHoldTurn: Int
    card: CardSnapshot
  }

  type RuneCardState {
    runeId: ID!
    name: String!
    domain: String
    energyValue: Int
    powerValue: Int
  }

  type PlayerBoardState {
    creatures: [Card!]!
    artifacts: [Card!]!
    enchantments: [Card!]!
  }

  type ResourcePoolState {
    energy: Int!
    universalPower: Int!
    power: JSON!
  }

  type TemporaryEffectEffect {
    type: String!
    value: Int
  }

  type TemporaryEffectState {
    id: ID!
    affectedCards: [ID!]
    affectedPlayer: ID
    duration: Int!
    effect: TemporaryEffectEffect!
  }

  type GamePrompt {
    id: ID!
    type: String!
    playerId: ID!
    data: JSON
    resolved: Boolean!
    createdAt: DateTime
    resolvedAt: DateTime
    resolution: JSON
  }

  type PriorityWindow {
    id: ID!
    type: String!
    holder: ID!
    openedAt: DateTime
    expiresAt: DateTime
    event: String
  }

  type GameStateSnapshot {
    turn: Int!
    phase: String!
    timestamp: DateTime
    reason: String!
    summary: String!
  }

  type PlayerState {
    playerId: ID!
    name: String!
    victoryPoints: Int!
    victoryScore: Int!
    mana: Int!
    maxMana: Int!
    handSize: Int!
    deckCount: Int!
    runeDeckSize: Int!
    hand: [Card!]!
    board: PlayerBoardState!
    graveyard: [Card!]!
    exile: [Card!]!
    channeledRunes: [RuneCardState!]!
    runeDeck: [RuneCardState!]!
    resources: ResourcePoolState!
    temporaryEffects: [TemporaryEffectState!]!
  }

  type ScoreEvent {
    playerId: ID!
    amount: Int!
    reason: String!
    sourceCardId: String
    timestamp: DateTime!
  }

  type GameState {
    matchId: ID!
    players: [PlayerState!]!
    currentPhase: String!
    turnNumber: Int!
    currentPlayerIndex: Int!
    status: String!
    winner: ID
    initiativeWinner: ID
    initiativeLoser: ID
    initiativeSelections: JSON
    initiativeDecidedAt: DateTime
    moveHistory: [JSON!]
    timestamp: DateTime!
    victoryScore: Int!
    scoreLog: [ScoreEvent!]!
    endReason: String
    prompts: [GamePrompt!]!
    priorityWindow: PriorityWindow
    snapshots: [GameStateSnapshot!]!
    battlefields: [BattlefieldState!]!
  }

  type OpponentView {
    playerId: ID
    victoryPoints: Int
    victoryScore: Int
    handSize: Int
    board: PlayerBoardState
  }

  type GameStateView {
    matchId: ID!
    currentPhase: String!
    turnNumber: Int!
    currentPlayerIndex: Int!
    canAct: Boolean!
  }

  type PlayerView {
    matchId: ID!
    currentPlayer: PlayerState!
    opponent: OpponentView!
    gameState: GameStateView!
  }

  type MatchResult {
    matchId: ID!
    winner: ID!
    loser: ID!
    reason: String!
    duration: Int!
    turns: Int!
    moves: [JSON!]
  }

  type MatchReplay {
    matchId: ID!
    players: [ID!]!
    winner: ID
    loser: ID
    duration: Int
    turns: Int
    moves: [JSON!]
    finalState: JSON
    createdAt: DateTime
  }

  type Query {
    match(matchId: ID!): GameState
    playerMatch(matchId: ID!, playerId: ID!): PlayerView
    matchResult(matchId: ID!): MatchResult
    matchReplay(matchId: ID!): MatchReplay
  }
`;

export const matchServiceResolvers = {
  Query: {
    match: queryResolvers.match,
    playerMatch: queryResolvers.playerMatch,
    matchResult: queryResolvers.matchResult,
    matchReplay: queryResolvers.matchReplay,
  },
};
