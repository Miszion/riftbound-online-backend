# Riftbound Match Service

## Overview

The Match Service is a **standalone ECS service** that manages individual TCG matches. Each match spins up its own ECS Fargate task that:

- **Maintains game state in memory** for fast gameplay
- **Enforces Riftbound TCG rules** through the game engine
- **Handles all game logic** in a single, auditable file
- **Saves state snapshots** to DynamoDB for persistence
- **Terminates gracefully** when the match ends

This architecture ensures **isolated, auditable, and scalable** match instances.

## Architecture

### Components

```
Main Server (Game Backend)
         ↓
    Create Match
         ↓
   ECS Task #1 (Match A)  │  ECS Task #2 (Match B)  │  ... ECS Task #N
   - Game Engine         │  - Game Engine          │
   - Game State (RAM)    │  - Game State (RAM)     │
   - Rules Engine        │  - Rules Engine         │
         ↓               │        ↓                │
    State Snapshots → DynamoDB ← State Snapshots
    Match Results    (Persistence)
         ↓               │        ↓                │
    Graceful Shutdown   │  Graceful Shutdown
```

### One Task Per Match

- **Isolation**: Each match is completely isolated from others
- **Performance**: Game state is in-memory for fast decisions
- **Scalability**: Can run 100+ matches simultaneously
- **Auditability**: All moves are recorded in DynamoDB
- **Graceful Termination**: Task shuts down cleanly when match ends

## Game Engine (`src/game-engine.ts`)

All game logic is kept in a **single file** for full traceability.

### Core Features

#### 1. Card System
```typescript
Card {
  id: string
  name: string
  type: 'creature' | 'spell' | 'artifact' | 'enchantment'
  manaCost: number
  power?: number
  toughness?: number
  abilities?: CardAbility[]
}
```

#### 2. Player State
```typescript
PlayerState {
  health: 20
  maxMana: 3 (increases each turn)
  hand: Card[]
  deck: Card[]
  board: { creatures, artifacts, enchantments }
  graveyard: Card[]
}
```

#### 3. Game Phases
- **BEGIN**: Draw card, restore mana
- **MAIN_1**: Play lands/spells
- **COMBAT**: Attack with creatures
- **MAIN_2**: Play more spells
- **END**: Discard down to hand size
- **CLEANUP**: Reset for next turn

#### 4. Core Rules Implemented
- ✅ Mana system (costs, restoration)
- ✅ Card play validation
- ✅ Combat system (attack/block)
- ✅ Damage calculation
- ✅ Health tracking
- ✅ Win conditions (lethal, deck empty)
- ✅ Summoning sickness (can't attack same turn)
- ✅ Temporary effects (buffs, debuffs)
- ✅ Ability triggers (on play, on attack, on damage)
- ✅ Hand size limits (10 cards max)
- ✅ Deck validation (60 cards minimum)

### Example Usage

```typescript
// Create new game
const engine = new RiftboundGameEngine('match-123', ['player1', 'player2']);

// Initialize with decks
engine.initializeGame({
  player1: [...deck1Cards],
  player2: [...deck2Cards]
});

// Players take actions
engine.playCard('player1', 0); // Play card at index 0
engine.proceedToNextPhase();   // Next phase
engine.declareAttacker('player1', 'creature-instance-id');

// Get game state
const state = engine.getGameState();
const playerView = engine.getPlayerState('player1');
```

## Match Service API

### Base URL
`http://riftbound-match-service-<env>.internal:80`

### Endpoints

#### Health Check
```
GET /health

Response:
{
  "status": "healthy",
  "activeMatches": 5,
  "timestamp": "2025-12-14T10:30:00Z"
}
```

#### Initialize Match
```
POST /matches/init

Body:
{
  "matchId": "match-123",
  "player1": "player-1-id",
  "player2": "player-2-id",
  "decks": {
    "player-1-id": [{ Card }, ...],
    "player-2-id": [{ Card }, ...]
  }
}

Response:
{
  "matchId": "match-123",
  "status": "initialized",
  "players": ["player-1-id", "player-2-id"],
  "gameState": { GameState }
}
```

#### Get Game State
```
GET /matches/:matchId

Response:
{
  "matchId": "match-123",
  "players": [{ PlayerState }, { PlayerState }],
  "currentPlayerIndex": 0,
  "currentPhase": "main_1",
  "turnNumber": 3,
  "status": "in_progress",
  "moveHistory": [{ GameMove }, ...]
}
```

#### Get Player View
```
GET /matches/:matchId/player/:playerId

Response:
{
  "matchId": "match-123",
  "currentPlayer": { PlayerState },
  "opponent": {
    "playerId": "...",
    "health": 15,
    "handSize": 7,
    "board": { BoardState }
  },
  "gameState": {
    "currentPhase": "main_1",
    "turnNumber": 3,
    "canAct": true
  }
}
```

#### Play Card
```
POST /matches/:matchId/actions/play-card

Body:
{
  "playerId": "player-1-id",
  "cardIndex": 0,
  "targets": ["creature-instance-id"] (optional)
}

Response:
{
  "success": true,
  "gameState": { GameState },
  "currentPhase": "main_1"
}
```

#### Attack
```
POST /matches/:matchId/actions/attack

Body:
{
  "playerId": "player-1-id",
  "creatureInstanceId": "creature-instance-id",
  "destinationId": "battlefield-id"
}

Response:
{
  "success": true,
  "gameState": { GameState }
}

#### Move Unit
```
POST /matches/:matchId/actions/move

Body:
{
  "playerId": "player-1-id",
  "creatureInstanceId": "creature-instance-id",
  "destinationId": "battlefield-id or base"
}

Response:
{
  "success": true,
  "gameState": { GameState }
}
```
```

#### Next Phase
```
POST /matches/:matchId/actions/next-phase

Body:
{
  "playerId": "player-1-id"
}

Response:
{
  "success": true,
  "currentPhase": "combat",
  "gameState": { GameState }
}
```

#### Report Result
```
POST /matches/:matchId/result

Body:
{
  "winner": "player-1-id",
  "reason": "health_depletion"
}

Response:
{
  "success": true,
  "matchResult": {
    "matchId": "match-123",
    "winner": "player-1-id",
    "loser": "player-2-id",
    "reason": "health_depletion",
    "duration": 300000,
    "turns": 15,
    "moves": [{ GameMove }, ...]
  }
}

Behavior: Container gracefully shuts down after 1 second
```

#### Concede Match
```
POST /matches/:matchId/concede

Body:
{
  "playerId": "player-1-id"
}

Response:
{
  "success": true,
  "matchResult": { MatchResult }
}

Behavior: Other player wins, container shuts down
```

#### Get Match History
```
GET /matches/:matchId/history

Response:
{
  "matchId": "match-123",
  "moves": [{ GameMove }, ...],
  "turnCount": 15,
  "status": "completed"
}
```

## Deployment

### CloudFormation Resources

The `MatchServiceStack` creates:

1. **DynamoDB Tables**
   - `riftbound-online-matches-<env>`: Completed match results
   - `riftbound-online-match-states-<env>`: In-progress game states (TTL enabled)

2. **ECS Cluster**
   - Fargate cluster for match tasks
   - Container insights enabled
   - Multi-AZ deployment

3. **Task Definition**
   - CPU: 512 (0.5 vCPU per match)
   - Memory: 1024 MB per match
   - Health check: `/health` endpoint every 30s
   - Logging: CloudWatch logs

4. **Load Balancer**
   - Internal ALB (not internet-facing)
   - Health check on `/health`
   - Target group with 30s deregistration delay

5. **IAM Roles**
   - DynamoDB read/write permissions
   - CloudWatch Logs access

### Scaling

- **Min Capacity**: 0 (scale down when no matches)
- **Max Capacity**: 100 concurrent matches
- **Scaling Metric**: CPU utilization at 70%

## Workflow: Creating and Running a Match

### 1. Main Server Initiates Match
```typescript
// Main server (src/server.ts) calls match service
const matchConfig = {
  matchId: uuidv4(),
  player1: 'player-uuid-1',
  player2: 'player-uuid-2',
  decks: {
    'player-uuid-1': deck1,
    'player-uuid-2': deck2
  }
};

const response = await fetch(
  'http://riftbound-match-service.internal/matches/init',
  {
    method: 'POST',
    body: JSON.stringify(matchConfig)
  }
);
```

### 2. Match Task Starts
- ECS spins up new Fargate task
- Match service initializes game engine
- Game state stored in task memory
- State snapshots saved to DynamoDB

### 3. Players Play Game
- Players call match service endpoints to make moves
- All actions validated against Riftbound rules
- State changes immediately reflected in memory
- Move history recorded in DynamoDB

### 4. Match Ends
- Main server calls `POST /matches/:matchId/result`
- Match result saved to DynamoDB
- Task exits gracefully (within 1 second)
- ALB deregisters task
- New tasks can be created immediately

## State Persistence

### In-Memory State
- **Fast**: Game decisions are instant
- **Real-time**: All players see immediate updates
- **Isolated**: Each match is independent

### DynamoDB Snapshots
- **Saved**: After each move
- **Used for**: Replay, audit trail, recovery
- **TTL**: Old states auto-deleted 24 hours after match

### Match Results
- **Stored permanently**: MatchId, Winner, Loser, Reason, Duration, Turn Count, Move Count
- **Indexed by**: Winner (for leaderboards)
- **Queryable**: For match history and replays

## Error Handling

### Invalid Moves
```
Status: 400
Body: { "error": "Insufficient mana" }
```

### Player Disconnection
- Match state preserved in DynamoDB
- Can reconnect to same match
- Auto-timeout after 5 minutes of inactivity

### Container Crash
- ECS detects unhealthy task (failed health checks)
- Auto-restarts or replaces task
- Game state recoverable from DynamoDB
- Players reconnect automatically

## Monitoring

### CloudWatch Logs
```bash
aws logs tail /ecs/riftbound-match-service-dev --follow
```

### Metrics
- Task count (number of active matches)
- CPU utilization (game calculation load)
- Memory utilization
- Network I/O (state snapshots)

### Alarms
- Unhealthy task count > 0
- Task startup failures
- DynamoDB throttling

## Examples

### Starting a Match from Main Server

```typescript
import { v4 as uuidv4 } from 'uuid';

async function startMatch(player1Id: string, player2Id: string) {
  const matchId = uuidv4();
  
  // Get player decks from database
  const deck1 = await getUserDeck(player1Id);
  const deck2 = await getUserDeck(player2Id);
  
  // Call match service
  const response = await fetch(
    `http://riftbound-match-service.internal/matches/init`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        matchId,
        player1: player1Id,
        player2: player2Id,
        decks: {
          [player1Id]: deck1,
          [player2Id]: deck2
        }
      })
    }
  );
  
  const result = await response.json();
  
  // Store match in users table
  await dynamodb.update({
    TableName: 'users',
    Key: { UserId: player1Id },
    UpdateExpression: 'SET CurrentMatch = :m',
    ExpressionAttributeValues: { ':m': matchId }
  }).promise();
  
  return matchId;
}
```

### Playing a Card

```typescript
async function playCard(
  matchId: string,
  playerId: string,
  cardIndex: number
) {
  const response = await fetch(
    `http://riftbound-match-service.internal/matches/${matchId}/actions/play-card`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId,
        cardIndex
      })
    }
  );
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error);
  }
  
  return response.json();
}
```

### Conceding a Match

```typescript
async function concedeMatch(matchId: string, playerId: string) {
  const response = await fetch(
    `http://riftbound-match-service.internal/matches/${matchId}/concede`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId })
    }
  );
  
  const result = await response.json();
  
  // Update user
  const opponent = result.matchResult.winner;
  await dynamodb.update({
    TableName: 'users',
    Key: { UserId: playerId },
    UpdateExpression: 'REMOVE CurrentMatch'
  }).promise();
  
  return result.matchResult;
}
```

## Future Enhancements

### Immediate
- [ ] WebSocket support for real-time game state sync
- [ ] Spectator mode (read-only connections)
- [ ] Elo rating updates after match
- [ ] Replay system (replay moves from history)

### Medium-term
- [ ] More card types and abilities
- [ ] Advanced combat (blocking, evasion)
- [ ] Card draw effects
- [ ] Deck validation service
- [ ] Card pool management

### Long-term
- [ ] Tournament support
- [ ] Matchmaking queue
- [ ] Seasonal ranked ladder
- [ ] Pro player analytics
- [ ] Regional servers

## Debugging

### Check Active Matches
```bash
aws ecs list-tasks \
  --cluster riftbound-match-service-dev \
  --desired-status RUNNING
```

### View Match Logs
```bash
aws logs tail /ecs/riftbound-match-service-dev --follow
```

### Query Match Results
```bash
aws dynamodb scan \
  --table-name riftbound-online-matches-dev \
  --limit 10
```

### Simulate Match Locally
```typescript
const engine = new RiftboundGameEngine('local-test', ['p1', 'p2']);
engine.initializeGame(testDecks);
// Play through game
const result = engine.getMatchResult();
```

## Architecture Decisions

### Why One Task Per Match?

1. **Isolation**: Bug in one match doesn't affect others
2. **Scaling**: Horizontal scaling is trivial (just start more tasks)
3. **Memory**: Each task has dedicated memory
4. **Graceful Shutdown**: Task exits when match ends
5. **Cost**: Only pay for active matches

### Why In-Memory State?

1. **Speed**: Sub-second game decisions
2. **Real-time**: Instant player feedback
3. **Simplicity**: No locking or synchronization needed
4. **Snapshots**: DynamoDB provides durability

### Why Single Game Engine File?

1. **Traceability**: All logic in one place
2. **Auditability**: Easy to see all rule implementations
3. **Debugging**: Simple to trace decision path
4. **Testing**: All rules in one test file
5. **No Dependencies**: Self-contained logic

## FAQ

**Q: Can a player disconnect and reconnect?**
A: Yes, the task stays running and state is preserved. Player can reconnect and resume.

**Q: What happens if a task crashes?**
A: ECS restarts it. Game state is recovered from DynamoDB.

**Q: How much does each match cost?**
A: Roughly $0.01/hour for Fargate + minimal DynamoDB writes.

**Q: Can I replay matches?**
A: Yes, all moves are stored in DynamoDB move history.

**Q: How many matches can run simultaneously?**
A: Up to 100 per configuration (adjustable max capacity).

**Q: Is the game state persisted immediately?**
A: Snapshots are saved after each move. Match results are saved at end.

## Resources

- [Riftbound TCG Rules](../TCG_RULES.md)
- [Game Engine Implementation](../src/game-engine.ts)
- [Match Service Code](../src/match-service.ts)
- [ECS Documentation](https://docs.aws.amazon.com/ecs/)
- [DynamoDB Documentation](https://docs.aws.amazon.com/dynamodb/)
