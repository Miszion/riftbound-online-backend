export const typeDefs = `#graphql
  # ============================================================================
  # SCALAR TYPES
  # ============================================================================
  scalar DateTime
  scalar JSON

  # ============================================================================
  # USER TYPES
  # ============================================================================
  type User {
    userId: ID!
    username: String
    email: String
    userLevel: Int
    wins: Int
    totalMatches: Int
    lastLogin: DateTime
    createdAt: DateTime
  }

  # ============================================================================
  # MATCH HISTORY TYPES
  # ============================================================================
  type MatchHistory {
    matchId: ID!
    timestamp: DateTime!
    players: [String!]!
    winner: String!
    loser: String
    duration: Int!
    turns: Int
    moveCount: Int
    status: String!
  }

  # ============================================================================
  # GAME STATE & MATCH TYPES
  # ============================================================================
  type Card {
    cardId: String!
    name: String!
    cost: Int!
    power: Int!
    toughness: Int!
    abilities: [String!]
    type: String!
  }

  # ============================================================================
  # CARD CATALOG TYPES
  # ============================================================================
  type CardCostProfile {
    energy: Int
    powerSymbols: [String!]!
    raw: String
  }

  type ActivationProfile {
    timing: String!
    triggers: [String!]!
    actions: [String!]!
    requiresTarget: Boolean!
    reactionWindows: [String!]!
    stateful: Boolean!
  }

  type RuleClause {
    id: ID!
    text: String!
    tags: [String!]!
  }

  type CardAssetInfo {
    remote: String
    localPath: String!
  }

  type CardPricing {
    price: Float
    foilPrice: Float
    currency: String!
  }

  type CardReferenceInfo {
    marketUrl: String
    source: String!
  }

  type CatalogCard {
    id: ID!
    slug: String!
    name: String!
    type: String
    rarity: String
    setName: String
    colors: [String!]
    cost: CardCostProfile!
    might: Int
    tags: [String!]
    effect: String!
    flavor: String
    keywords: [String!]
    activation: ActivationProfile!
    rules: [RuleClause!]!
    assets: CardAssetInfo!
    pricing: CardPricing!
    references: CardReferenceInfo!
  }

  type CardImageEntry {
    id: ID!
    name: String!
    remote: String
    localPath: String!
  }

  type CardActivationStateEntry {
    cardId: ID!
    isStateful: Boolean!
    active: Boolean!
    lastChangedAt: DateTime
  }

  type PlayerState {
    playerId: ID!
    health: Int!
    maxHealth: Int!
    mana: Int!
    maxMana: Int!
    hand: [Card!]!
    board: [Card!]!
    graveyard: [Card!]!
  }

  type GameState {
    matchId: ID!
    players: [PlayerState!]!
    currentPhase: String!
    turnNumber: Int!
    currentPlayerIndex: Int!
    status: String!
    moveHistory: [JSON!]
    timestamp: DateTime!
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

  type PlayerView {
    matchId: ID!
    currentPlayer: PlayerState!
    opponent: OpponentView!
    gameState: GameStateView!
  }

  type OpponentView {
    playerId: ID
    health: Int
    handSize: Int
    board: [Card!]
  }

  type GameStateView {
    matchId: ID!
    currentPhase: String!
    turnNumber: Int!
    currentPlayerIndex: Int!
    canAct: Boolean!
  }

  # ============================================================================
  # LEADERBOARD TYPES
  # ============================================================================
  type LeaderboardEntry {
    userId: ID!
    username: String
    wins: Int!
    totalMatches: Int!
    winRate: Float!
  }

  # ============================================================================
  # QUERIES
  # ============================================================================
  type Query {
    # User queries
    user(userId: ID!): User
    leaderboard(limit: Int): [LeaderboardEntry!]!

    # Match queries
    match(matchId: ID!): GameState
    playerMatch(matchId: ID!, playerId: ID!): PlayerView
    matchHistory(userId: ID!, limit: Int): [MatchHistory!]!
    matchResult(matchId: ID!): MatchResult

    # Card catalog queries
    cardCatalog(filter: CardCatalogFilter): [CatalogCard!]!
    cardById(id: ID!): CatalogCard
    cardBySlug(slug: String!): CatalogCard
    cardImageManifest: [CardImageEntry!]!
    cardActivationStates: [CardActivationStateEntry!]!
  }

  input CardCatalogFilter {
    search: String
    type: String
    domain: String
    rarity: String
    limit: Int
  }

  # ============================================================================
  # MUTATIONS
  # ============================================================================
  type Mutation {
    # User mutations
    updateUser(
      userId: ID!
      username: String
      userLevel: Int
      wins: Int
      totalMatches: Int
    ): User!

    # Match mutations
    initMatch(
      matchId: ID!
      player1: ID!
      player2: ID!
      decks: JSON!
    ): MatchInitResponse!

    playCard(
      matchId: ID!
      playerId: ID!
      cardIndex: Int!
      targets: [String!]
    ): ActionResponse!

    attack(
      matchId: ID!
      playerId: ID!
      creatureInstanceId: String!
      defenderId: String
    ): ActionResponse!

    nextPhase(
      matchId: ID!
      playerId: ID!
    ): ActionResponse!

    reportMatchResult(
      matchId: ID!
      winner: ID!
      reason: String!
    ): MatchResultResponse!

    concedeMatch(
      matchId: ID!
      playerId: ID!
    ): MatchResultResponse!
  }

  # ============================================================================
  # SUBSCRIPTIONS
  # ============================================================================
  type Subscription {
    # Real-time game state updates
    gameStateChanged(matchId: ID!): GameState!
    
    # Player-specific updates
    playerGameStateChanged(
      matchId: ID!
      playerId: ID!
    ): PlayerView!

    # Match completion
    matchCompleted(matchId: ID!): MatchResult!

    # Leaderboard updates
    leaderboardUpdated: [LeaderboardEntry!]!

    # Real-time card played notification
    cardPlayed(matchId: ID!): CardPlayedEvent!

    # Real-time attack declaration
    attackDeclared(matchId: ID!): AttackEvent!

    # Real-time phase change
    phaseChanged(matchId: ID!): PhaseChangeEvent!
  }

  # ============================================================================
  # RESPONSE TYPES
  # ============================================================================
  type MatchInitResponse {
    matchId: ID!
    status: String!
    players: [ID!]!
    gameState: GameState!
  }

  type ActionResponse {
    success: Boolean!
    gameState: GameState!
    currentPhase: String!
  }

  type MatchResultResponse {
    success: Boolean!
    matchResult: MatchResult!
  }

  type CardPlayedEvent {
    matchId: ID!
    playerId: ID!
    card: Card!
    timestamp: DateTime!
  }

  type AttackEvent {
    matchId: ID!
    playerId: ID!
    creatureInstanceId: String!
    defenderId: String
    timestamp: DateTime!
  }

  type PhaseChangeEvent {
    matchId: ID!
    newPhase: String!
    turnNumber: Int!
    timestamp: DateTime!
  }
`;
