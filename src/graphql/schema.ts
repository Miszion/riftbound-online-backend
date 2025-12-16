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

  type CardLocationState {
    zone: String!
    battlefieldId: ID
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
    history: [ActivationHistoryEntry!]!
  }

  type ActivationHistoryEntry {
    at: DateTime
    reason: String!
    active: Boolean!
  }

  type DeckCard {
    cardId: ID
    slug: String
    quantity: Int!
    cardSnapshot: CardSnapshot
  }

  type Decklist {
    deckId: ID!
    userId: ID!
    name: String!
    description: String
    heroSlug: String
    format: String
    tags: [String!]
    isPublic: Boolean!
    isDefault: Boolean!
    cardCount: Int!
    cards: [DeckCard!]!
    runeDeck: [DeckCard!]
    battlefields: [DeckCard!]
    sideDeck: [DeckCard!]
    championLegend: DeckCard
    championLeader: DeckCard
    createdAt: DateTime
    updatedAt: DateTime
  }

  enum MatchMode {
    ranked
    free
  }

  type MatchmakingParticipant {
    userId: ID!
    mmr: Int!
    deckId: ID
  }

  type MatchmakingResult {
    mode: MatchMode!
    queued: Boolean!
    matchFound: Boolean!
    matchId: ID
    opponentId: ID
    opponentName: String
    mmr: Int!
    estimatedWaitSeconds: Int!
  }

  type MatchmakingStatus {
    mode: MatchMode!
    state: String!
    queued: Boolean!
    mmr: Int
    queuedAt: DateTime
    estimatedWaitSeconds: Int
    matchId: ID
    opponentId: ID
    opponentName: String
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

  type RecentMatchSummary {
    matchId: ID!
    players: [ID!]
    winner: ID
    loser: ID
    duration: Int
    turns: Int
    createdAt: DateTime
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

  type TemporaryEffectState {
    id: ID!
    affectedCards: [ID!]
    affectedPlayer: ID
    duration: Int!
    effect: TemporaryEffectEffect!
  }

  type TemporaryEffectEffect {
    type: String!
    value: Int
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

    # Deckbuilder
    decklists(userId: ID!): [Decklist!]!
    decklist(deckId: ID!): Decklist

    # Matchmaking
    matchmakingStatus(userId: ID!, mode: MatchMode!): MatchmakingStatus!

    # Spectator / Replay
    matchReplay(matchId: ID!): MatchReplay
    recentMatches(limit: Int): [RecentMatchSummary!]!
  }

  input CardCatalogFilter {
    search: String
    type: String
    domain: String
    rarity: String
    limit: Int
  }

  input DeckCardInput {
    cardId: ID
    slug: String
    quantity: Int!
    cardSnapshot: CardSnapshotInput
  }

  input CardAssetInfoInput {
    remote: String
    localPath: String
  }

  input CardSnapshotInput {
    cardId: String
    slug: String
    name: String
    type: String
    rarity: String
    colors: [String!]
    keywords: [String!]
    effect: String
    assets: CardAssetInfoInput
  }

  input DecklistInput {
    deckId: ID
    userId: ID!
    name: String!
    description: String
    heroSlug: String
    format: String
    tags: [String!]
    isPublic: Boolean
    isDefault: Boolean
    cards: [DeckCardInput!]!
    runeDeck: [DeckCardInput!]
    battlefields: [DeckCardInput!]
    sideDeck: [DeckCardInput!]
    championLegend: DeckCardInput
    championLeader: DeckCardInput
  }

  input MatchmakingQueueInput {
    userId: ID!
    mode: MatchMode!
    deckId: ID
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

    submitInitiativeChoice(
      matchId: ID!
      playerId: ID!
      choice: Int!
    ): GameState!

    submitMulligan(
      matchId: ID!
      playerId: ID!
      indices: [Int!]
    ): GameState!

    selectBattlefield(
      matchId: ID!
      playerId: ID!
      battlefieldId: ID!
    ): GameState!

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
      destinationId: String!
    ): ActionResponse!

    moveUnit(
      matchId: ID!
      playerId: ID!
      creatureInstanceId: String!
      destinationId: String!
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

    # Deckbuilding
    saveDecklist(input: DecklistInput!): Decklist!
    deleteDecklist(userId: ID!, deckId: ID!): Boolean!

    # Matchmaking
    joinMatchmakingQueue(input: MatchmakingQueueInput!): MatchmakingResult!
    leaveMatchmakingQueue(userId: ID!, mode: MatchMode!): Boolean!
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
    destinationId: String!
    timestamp: DateTime!
  }

  type PhaseChangeEvent {
    matchId: ID!
    newPhase: String!
    turnNumber: Int!
    timestamp: DateTime!
  }
`;
