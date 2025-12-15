# Match Service Quick Start

## 5-Minute Setup

### 1. Build Everything
```bash
cd /Users/missionmarcus/workplace/riftbound-online-backend
bash build.sh
```

This compiles:
- ✅ Main server and match service
- ✅ Lambda functions
- ✅ CDK infrastructure
- ✅ Docker image

### 2. Deploy Infrastructure
```bash
cd cdk
npm install
cdk bootstrap
cdk deploy RiftboundMatchService-dev
```

Wait for completion (~5 minutes). You'll get outputs like:
- Match Service Load Balancer DNS
- ECS Cluster Name
- DynamoDB Table Names

### 3. Test Locally (Optional)
```bash
# Terminal 1: Start main server
npm run dev
# Server runs on http://localhost:3000

# Terminal 2: Start match service
cd src
npm run dev -- match-service.ts
# Service runs on http://localhost:4000
```

### 4. Create a Test Match
```bash
curl -X POST http://localhost:4000/matches/init \
  -H "Content-Type: application/json" \
  -d '{
    "matchId": "test-match-1",
    "player1": "alice",
    "player2": "bob",
    "decks": {
      "alice": [...60 cards...],
      "bob": [...60 cards...]
    }
  }'
```

## API Examples

### Initialize Match
```bash
curl -X POST http://match-service/matches/init \
  -H "Content-Type: application/json" \
  -d '{
    "matchId": "match-uuid",
    "player1": "player1-id",
    "player2": "player2-id",
    "decks": {
      "player1-id": [card objects],
      "player2-id": [card objects]
    }
  }'
```

### Get Game State
```bash
curl http://match-service/matches/match-uuid
```

### Get Player View
```bash
curl http://match-service/matches/match-uuid/player/player1-id
```

### Play Card
```bash
curl -X POST http://match-service/matches/match-uuid/actions/play-card \
  -H "Content-Type: application/json" \
  -d '{
    "playerId": "player1-id",
    "cardIndex": 0
  }'
```

### Attack
```bash
curl -X POST http://match-service/matches/match-uuid/actions/attack \
  -H "Content-Type: application/json" \
  -d '{
    "playerId": "player1-id",
    "creatureInstanceId": "creature-id"
  }'
```

### Next Phase
```bash
curl -X POST http://match-service/matches/match-uuid/actions/next-phase \
  -H "Content-Type: application/json" \
  -d '{
    "playerId": "player1-id"
  }'
```

### Report Result
```bash
curl -X POST http://match-service/matches/match-uuid/result \
  -H "Content-Type: application/json" \
  -d '{
    "winner": "player1-id",
    "reason": "health_depletion"
  }'
```

### Concede Match
```bash
curl -X POST http://match-service/matches/match-uuid/concede \
  -H "Content-Type: application/json" \
  -d '{
    "playerId": "player1-id"
  }'
```

### Get Match History
```bash
curl http://match-service/matches/match-uuid/history
```

## Architecture at a Glance

```
Your App
   ↓
Main Server (Port 3000)
- User management
- Authentication
- Matchmaking
   ↓
Match Service (Port 4000)
- Game engine
- State management
- Move validation
   ↓
DynamoDB
- Match results
- State snapshots
```

## Key Files

| File | Purpose | Lines |
|------|---------|-------|
| `src/game-engine.ts` | Complete TCG rules engine | 1000+ |
| `src/match-service.ts` | REST API for matches | 400+ |
| `cdk/src/match-service-stack.ts` | AWS infrastructure | 250+ |
| `MATCH_SERVICE.md` | Full documentation | 500+ |
| `MATCH_SERVICE_INTEGRATION.md` | Integration guide | 400+ |

## Game Rules at a Glance

- **Players**: 2
- **Starting Health**: 20
- **Starting Mana**: 0 (increases by 1 per turn)
- **Max Mana**: 10
- **Hand Size**: Max 10 cards
- **Deck Size**: 60 cards minimum
- **Turn Phases**: Begin → Main 1 → Combat → Main 2 → End → Cleanup

## Troubleshooting

### Service not responding?
```bash
# Check health
curl http://match-service/health

# View logs
aws logs tail /ecs/riftbound-match-service-dev --follow
```

### Move rejected?
Check the error message - it explains the rule violation:
- "Insufficient mana"
- "Not your turn"
- "Creature is tapped"
- etc.

### Match not found?
Verify match has been initialized:
```bash
curl http://match-service/matches/match-id
```

## Scaling

- **Min matches**: 0 (auto-scales down)
- **Max matches**: 100 (adjustable)
- **Cost**: ~$0.01/match/hour
- **Startup time**: ~30 seconds
- **Shutdown time**: ~1 second (graceful)

## What's Next?

1. **Test**: Play a full game locally
2. **Integrate**: Connect main server to match service
3. **Deploy**: Push to AWS with CDK
4. **Scale**: Run 100+ concurrent matches
5. **Enhance**: Add WebSocket for real-time updates

## Resources

- 📖 [Full Documentation](./MATCH_SERVICE.md)
- 🔗 [Integration Guide](./MATCH_SERVICE_INTEGRATION.md)
- 💾 [Implementation Details](./MATCH_SERVICE_IMPLEMENTATION.md)
- 🎮 [Game Engine Code](./src/game-engine.ts)
- 🚀 [Match Service Code](./src/match-service.ts)

## Questions?

All game logic is in `src/game-engine.ts` - easy to understand and modify.

All API endpoints are in `src/match-service.ts` - comprehensive and well-documented.

Check the documentation files for detailed explanations of everything.
