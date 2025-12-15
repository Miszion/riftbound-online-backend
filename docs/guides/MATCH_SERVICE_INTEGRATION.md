# Match Service Integration Guide

This guide shows how the main game server integrates with the Match Service for handling individual TCG matches.

## Architecture Overview

```
┌─────────────────────────────────────────────┐
│        Main Game Server (src/server.ts)     │
│  - User management                          │
│  - Authentication                           │
│  - Matchmaking                              │
│  - Leaderboards                             │
└─────────────────┬───────────────────────────┘
                  │
                  │ HTTP REST API
                  │
┌─────────────────▼───────────────────────────┐
│      Match Service (src/match-service.ts)   │
│  - Game engine execution                    │
│  - Move validation                          │
│  - Rule enforcement                         │
│  - State management                         │
└─────────────────┬───────────────────────────┘
                  │
                  │ DynamoDB
                  │
┌─────────────────▼───────────────────────────┐
│       Persistent State Storage              │
│  - Match results                            │
│  - Game state snapshots                     │
│  - Move history                             │
└─────────────────────────────────────────────┘
```

## Workflow: Creating and Playing a Match

### 1. User Initiates Match (Main Server)

User clicks "Play" and is matched with another player.

**Main Server Code** (`src/server.ts`):

```typescript
app.post('/api/matches/start', async (req: Request, res: Response) => {
  try {
    const { player1Id, player2Id } = req.body;

    // Get player decks
    const deck1 = await getPlayerDeck(player1Id);
    const deck2 = await getPlayerDeck(player2Id);

    const matchId = uuidv4();

    // Call Match Service to initialize game
    const initResponse = await fetch(
      `http://${MATCH_SERVICE_HOST}/matches/init`,
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

    if (!initResponse.ok) {
      throw new Error('Failed to initialize match');
    }

    // Store match in users table
    await dynamodb
      .update({
        TableName: USERS_TABLE,
        Key: { UserId: player1Id },
        UpdateExpression: 'SET CurrentMatch = :m, MatchStartTime = :t',
        ExpressionAttributeValues: {
          ':m': matchId,
          ':t': Date.now()
        }
      })
      .promise();

    await dynamodb
      .update({
        TableName: USERS_TABLE,
        Key: { UserId: player2Id },
        UpdateExpression: 'SET CurrentMatch = :m, MatchStartTime = :t',
        ExpressionAttributeValues: {
          ':m': matchId,
          ':t': Date.now()
        }
      })
      .promise();

    res.status(201).json({
      matchId,
      players: [player1Id, player2Id],
      startTime: Date.now()
    });
  } catch (error) {
    logger.error('Error starting match:', error);
    res.status(500).json({ error: 'Failed to start match' });
  }
});
```

**What happens:**
1. ECS spins up a new Fargate task for the match
2. Match service creates `RiftboundGameEngine` instance
3. Game state is initialized in task memory
4. Initial state snapshot saved to DynamoDB
5. Task waits for player actions

### 2. Players Make Moves (Match Service)

Players interact with match service directly via WebSocket or polling.

**Client Code** (Web/Mobile App):

```typescript
// Get current game state
async function getGameState(matchId: string, playerId: string) {
  const response = await fetch(
    `http://${MATCH_SERVICE_HOST}/matches/${matchId}/player/${playerId}`
  );
  return response.json();
}

// Play a card
async function playCard(matchId: string, playerId: string, cardIndex: number) {
  const response = await fetch(
    `http://${MATCH_SERVICE_HOST}/matches/${matchId}/actions/play-card`,
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
    throw new Error(error.error); // e.g., "Insufficient mana"
  }

  return response.json();
}

// Attack with creature
async function attack(matchId: string, playerId: string, creatureId: string) {
  return fetch(
    `http://${MATCH_SERVICE_HOST}/matches/${matchId}/actions/attack`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId,
        creatureInstanceId: creatureId
      })
    }
  ).then((r) => r.json());
}

// Next phase
async function nextPhase(matchId: string, playerId: string) {
  return fetch(
    `http://${MATCH_SERVICE_HOST}/matches/${matchId}/actions/next-phase`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId })
    }
  ).then((r) => r.json());
}
```

**Match Service Processing:**
- Validates move against current game state
- Updates game engine in memory
- Saves state snapshot to DynamoDB
- Returns new game state to players
- All at sub-second latency

### 3. Match Completes (Main Server)

Either player wins or one concedes.

**Client Code** (Concede):

```typescript
async function concedeMatch(matchId: string, playerId: string) {
  const response = await fetch(
    `http://${MATCH_SERVICE_HOST}/matches/${matchId}/concede`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId })
    }
  );

  const result = await response.json();
  
  // Notify main server
  await fetch(`http://localhost:3000/api/matches/${matchId}/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      winner: result.matchResult.winner,
      loser: result.matchResult.loser,
      reason: 'concede',
      duration: result.matchResult.duration,
      turns: result.matchResult.turns
    })
  });
}
```

**Match Service:**
1. Reports match result to DynamoDB
2. Removes game from memory
3. Gracefully shuts down ECS task
4. ALB deregisters task

**Main Server** (`src/server.ts`):

```typescript
app.post('/api/matches/:matchId/result', async (req: Request, res: Response) => {
  try {
    const { matchId } = req.params;
    const { winner, loser, reason, duration, turns } = req.body;

    // Update user records
    const winnerUpdate = await dynamodb
      .update({
        TableName: USERS_TABLE,
        Key: { UserId: winner },
        UpdateExpression:
          'REMOVE CurrentMatch SET Wins = if_not_exists(Wins, :zero) + :inc, TotalMatches = if_not_exists(TotalMatches, :zero) + :inc, LastMatch = :now',
        ExpressionAttributeValues: {
          ':zero': 0,
          ':inc': 1,
          ':now': Date.now()
        }
      })
      .promise();

    const loserUpdate = await dynamodb
      .update({
        TableName: USERS_TABLE,
        Key: { UserId: loser },
        UpdateExpression:
          'REMOVE CurrentMatch SET Losses = if_not_exists(Losses, :zero) + :inc, TotalMatches = if_not_exists(TotalMatches, :zero) + :inc, LastMatch = :now',
        ExpressionAttributeValues: {
          ':zero': 0,
          ':inc': 1,
          ':now': Date.now()
        }
      })
      .promise();

    // Store match result
    await dynamodb
      .put({
        TableName: MATCH_HISTORY_TABLE,
        Item: {
          MatchId: matchId,
          Winner: winner,
          Loser: loser,
          Reason: reason,
          Duration: duration,
          Turns: turns,
          CreatedAt: Date.now()
        }
      })
      .promise();

    // Update leaderboard (cached, refreshed hourly)
    await updateLeaderboard(winner);

    res.json({
      success: true,
      message: 'Match result recorded'
    });
  } catch (error) {
    logger.error('Error recording match result:', error);
    res.status(500).json({ error: 'Failed to record result' });
  }
});
```

## Configuration

### Environment Variables

**Main Server** (runs on port 3000):
```bash
MATCH_SERVICE_HOST=riftbound-match-service-dev.internal
USERS_TABLE=riftbound-online-users-dev
MATCH_HISTORY_TABLE=riftbound-online-match-history-dev
```

**Match Service** (runs on port 4000, one per match):
```bash
PORT=4000
MATCH_TABLE=riftbound-online-matches-dev
STATE_TABLE=riftbound-online-match-states-dev
AWS_REGION=us-east-1
```

### Docker Environment

**Main Server Container:**
```dockerfile
ENV SERVICE=main-server
ENV PORT=3000
```

**Match Service Container:**
```dockerfile
ENV SERVICE=match-service
ENV PORT=4000
```

The `Dockerfile` determines which service to run based on the `SERVICE` environment variable.

## Error Handling

### Invalid Move
```
Status: 400
Response: { "error": "Insufficient mana" }
```

### Not Your Turn
```
Status: 403
Response: { "error": "Not your turn" }
```

### Match Not Found
```
Status: 404
Response: { "error": "Match not found" }
```

### Internal Error
```
Status: 500
Response: { "error": "Internal server error" }
```

## Networking

### Internal Communication

**Setup:**
- Main server: Private subnet in VPC
- Match service ALB: Private subnet in VPC
- Direct HTTP communication via internal DNS

**Network flow:**
```
Main Server (10.0.1.x) 
    → Match Service ALB (10.0.1.y)
    → Match Service Task (10.0.2.z)
```

### Security

- **Firewall**: Security groups restrict traffic to internal VPC
- **VPC Endpoints**: No internet exposure (except for Lambda)
- **Encryption**: TLS/SSL for external-facing APIs
- **IAM**: Tasks only access their own DynamoDB tables

## Monitoring & Debugging

### Check Active Matches

```bash
# View running match tasks
aws ecs list-tasks \
  --cluster riftbound-match-service-dev \
  --desired-status RUNNING

# Describe task details
aws ecs describe-tasks \
  --cluster riftbound-match-service-dev \
  --tasks arn:aws:ecs:region:account:task/riftbound-match-service-dev/uuid
```

### View Match Logs

```bash
# Real-time logs
aws logs tail /ecs/riftbound-match-service-dev --follow

# Specific match
aws logs filter-log-events \
  --log-group-name /ecs/riftbound-match-service-dev \
  --filter-pattern "match-123"
```

### Query Match Results

```bash
# Get all matches for a player
aws dynamodb query \
  --table-name riftbound-online-match-history-dev \
  --index-name WinnerIndex \
  --key-condition-expression "Winner = :winner" \
  --expression-attribute-values '{":winner":{"S":"player-uuid"}}'

# Get last 10 matches
aws dynamodb scan \
  --table-name riftbound-online-match-history-dev \
  --limit 10 \
  --sort-descending
```

## Performance Considerations

### Latency
- **Move validation**: < 50ms (in-memory)
- **State snapshot**: < 100ms (DynamoDB write)
- **Total round-trip**: < 200ms per action

### Scaling
- **Task startup**: ~30 seconds
- **Max concurrent matches**: 100
- **Cost per match/hour**: ~$0.01
- **DynamoDB**: On-demand billing (no capacity limits)

### Optimization Tips

1. **Batch state updates**: Save every 5 moves instead of every move
2. **Async logging**: Use fire-and-forget for logs
3. **Memory reuse**: Reuse game objects instead of creating new ones
4. **Warm-up**: Pre-create task definition to reduce cold start

## Example: Full Match Lifecycle

```typescript
// 1. CREATE MATCH
const matchResponse = await fetch('http://localhost:3000/api/matches/start', {
  method: 'POST',
  body: JSON.stringify({
    player1Id: 'alice-uuid',
    player2Id: 'bob-uuid'
  })
});
const { matchId } = await matchResponse.json();
// matchId = "550e8400-e29b-41d4-a716-446655440000"

// 2. PLAY GAME
const playResponse = await fetch(
  `http://match-service.internal/matches/${matchId}/actions/play-card`,
  {
    method: 'POST',
    body: JSON.stringify({
      playerId: 'alice-uuid',
      cardIndex: 0
    })
  }
);
// ... many moves ...

// 3. END MATCH
const resultResponse = await fetch(
  `http://match-service.internal/matches/${matchId}/result`,
  {
    method: 'POST',
    body: JSON.stringify({
      winner: 'alice-uuid',
      reason: 'health_depletion'
    })
  }
);

// 4. RECORD RESULT
await fetch(`http://localhost:3000/api/matches/${matchId}/result`, {
  method: 'POST',
  body: JSON.stringify(resultResponse)
});

// Match task has gracefully shut down
// New matches can now use those container slots
```

## Troubleshooting

### Match Service Not Responding

```bash
# Check ALB health
aws elbv2 describe-target-health \
  --target-group-arn arn:aws:elasticloadbalancing:...

# Check task status
aws ecs describe-tasks --cluster riftbound-match-service-dev --tasks <task-arn>

# View logs for errors
aws logs tail /ecs/riftbound-match-service-dev --follow
```

### Moves Not Being Processed

1. Verify player turn: `GET /matches/:matchId`
2. Check game phase: `GET /matches/:matchId/player/:playerId`
3. Review error message: Most errors explain the rule violation

### Memory/CPU Issues

- Each match = 512 MB CPU, 1024 MB RAM
- Adjust in `match-service-stack.ts` if needed
- Monitor CloudWatch metrics

## Future Enhancements

1. **WebSocket**: Real-time game updates without polling
2. **Spectators**: Read-only connections to watch matches
3. **Replay System**: Replay moves from DynamoDB history
4. **Advanced Logging**: Track every decision for ML analysis
5. **Player Stats**: Detailed stats per card/strategy

## Resources

- [Match Service Documentation](../MATCH_SERVICE.md)
- [Game Engine Code](../src/game-engine.ts)
- [Match Service Code](../src/match-service.ts)
- [Main Server Code](../src/server.ts)
