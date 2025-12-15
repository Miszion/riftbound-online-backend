# GraphQL Migration Guide - Riftbound Online

## Overview

This document outlines the conversion of the REST API endpoints to GraphQL with real-time subscription support for the Riftbound Online game. The migration enables efficient real-time updates to the UI and provides a more flexible query interface.

## Architecture

### Backend Structure

```
backend/src/
├── graphql/
│   ├── schema.ts        # GraphQL type definitions
│   ├── resolvers.ts     # Query, Mutation, and Subscription resolvers
│   └── pubsub.ts        # PubSub event management
├── server.ts            # User service with Apollo Server (REST endpoints preserved)
└── match-service.ts     # Match service with Apollo Server + WebSocket subscriptions
```

### Frontend Structure

```
frontend/lib/
├── apolloClient.ts      # Apollo Client configuration with WebSocket support
└── graphql/
    ├── queries.ts       # GraphQL queries
    └── subscriptions.ts # GraphQL subscriptions

frontend/hooks/
└── useGraphQL.ts        # Custom React hooks for GraphQL operations

frontend/components/
└── GameBoard.tsx        # Example real-time game board component
```

## Setup Instructions

### Backend Setup

1. **Install Dependencies**
   ```bash
   cd riftbound-online-backend
   npm install
   ```

2. **Build TypeScript**
   ```bash
   npm run build
   ```

3. **Environment Variables**
   Add to `.env`:
   ```
   AWS_REGION=us-east-1
   USERS_TABLE=riftbound-online-users-dev
   MATCH_TABLE=riftbound-online-matches-dev
   MATCH_HISTORY_TABLE=riftbound-online-match-history-dev
   STATE_TABLE=riftbound-online-match-states-dev
   PORT=3000
   ```

4. **Run Services**
   ```bash
   # User Service
   npm run dev  # Runs on port 3000

   # Match Service (in separate terminal)
   MATCH_SERVICE=true npm run dev  # Runs on port 4000
   ```

Both services now expose GraphQL endpoints at `/graphql`

### Frontend Setup

1. **Install Dependencies**
   ```bash
   cd riftbound-online
   npm install
   ```

2. **Environment Variables**
   Create `.env.local`:
   ```
   NEXT_PUBLIC_API_HOST=localhost
   NEXT_PUBLIC_API_PORT=3000
   NEXT_PUBLIC_WS_HOST=localhost
   NEXT_PUBLIC_WS_PORT=3000
   ```

3. **Update Root Layout**
   Wrap your Next.js app with Apollo Provider in `app/layout.tsx`:

   ```typescript
   'use client';

   import { ApolloProvider } from '@apollo/client';
   import apolloClient from '@/lib/apolloClient';
   import { ReactNode } from 'react';

   export default function RootLayout({ children }: { children: ReactNode }) {
     return (
       <html>
         <body>
           <ApolloProvider client={apolloClient}>
             {children}
           </ApolloProvider>
         </body>
       </html>
     );
   }
   ```

4. **Run Development Server**
   ```bash
   npm run dev  # Runs on port 3000
   ```

## API Endpoints Mapping

### User Service (`:3000/graphql`)

#### REST → GraphQL Migration

| REST | GraphQL | Type |
|------|---------|------|
| GET `/api/users/:userId` | `user(userId)` | Query |
| PUT `/api/users/:userId` | `updateUser(userId, ...)` | Mutation |
| GET `/api/leaderboard` | `leaderboard(limit)` | Query |
| POST `/api/matches` | `initMatch(matchId, ...)` | Mutation |
| GET `/api/users/:userId/matches` | `matchHistory(userId, limit)` | Query |

### Match Service (`:4000/graphql`)

#### REST → GraphQL Migration

| REST | GraphQL | Type |
|------|---------|------|
| POST `/matches/init` | `initMatch(matchId, ...)` | Mutation |
| GET `/matches/:matchId` | `match(matchId)` | Query |
| GET `/matches/:matchId/player/:playerId` | `playerMatch(matchId, playerId)` | Query |
| POST `/matches/:matchId/actions/play-card` | `playCard(matchId, ...)` | Mutation |
| POST `/matches/:matchId/actions/attack` | `attack(matchId, ...)` | Mutation |
| POST `/matches/:matchId/actions/next-phase` | `nextPhase(matchId, playerId)` | Mutation |
| POST `/matches/:matchId/result` | `reportMatchResult(matchId, ...)` | Mutation |
| POST `/matches/:matchId/concede` | `concedeMatch(matchId, playerId)` | Mutation |
| GET `/matches/:matchId/history` | `matchHistory(userId, limit)` | Query |

## Query Examples

### Get User Profile
```graphql
query GetUser($userId: ID!) {
  user(userId: $userId) {
    userId
    username
    email
    userLevel
    wins
    totalMatches
    lastLogin
    createdAt
  }
}
```

### Get Leaderboard
```graphql
query GetLeaderboard($limit: Int) {
  leaderboard(limit: $limit) {
    userId
    username
    wins
    totalMatches
    winRate
  }
}
```

### Get Match State
```graphql
query GetPlayerMatch($matchId: ID!, $playerId: ID!) {
  playerMatch(matchId: $matchId, playerId: $playerId) {
    matchId
    currentPlayer {
      playerId
      health
      maxHealth
      mana
      maxMana
      hand { cardId name cost }
      board { cardId name power toughness }
    }
    opponent {
      playerId
      health
      handSize
      board { cardId name }
    }
    gameState {
      currentPhase
      turnNumber
      canAct
    }
  }
}
```

## Mutation Examples

### Play Card
```graphql
mutation PlayCard(
  $matchId: ID!
  $playerId: ID!
  $cardIndex: Int!
  $targets: [String!]
) {
  playCard(
    matchId: $matchId
    playerId: $playerId
    cardIndex: $cardIndex
    targets: $targets
  ) {
    success
    gameState { ... }
    currentPhase
  }
}
```

### Attack
```graphql
mutation Attack(
  $matchId: ID!
  $playerId: ID!
  $creatureInstanceId: String!
  $defenderId: String
) {
  attack(
    matchId: $matchId
    playerId: $playerId
    creatureInstanceId: $creatureInstanceId
    defenderId: $defenderId
  ) {
    success
    gameState { ... }
  }
}
```

## Subscription Examples

### Real-Time Game State Updates
```graphql
subscription GameStateChanged($matchId: ID!) {
  gameStateChanged(matchId: $matchId) {
    matchId
    players {
      playerId
      health
      mana
      hand { cardId name cost }
      board { cardId name }
    }
    currentPhase
    turnNumber
    status
    timestamp
  }
}
```

### Player-Specific Game Updates
```graphql
subscription PlayerGameStateChanged($matchId: ID!, $playerId: ID!) {
  playerGameStateChanged(matchId: $matchId, playerId: $playerId) {
    matchId
    currentPlayer {
      playerId
      health
      mana
      hand { ... }
      board { ... }
    }
    opponent {
      playerId
      health
      handSize
      board { ... }
    }
    gameState {
      currentPhase
      canAct
    }
  }
}
```

### Real-Time Card Play Events
```graphql
subscription CardPlayed($matchId: ID!) {
  cardPlayed(matchId: $matchId) {
    matchId
    playerId
    card {
      cardId
      name
      cost
      power
      toughness
    }
    timestamp
  }
}
```

### Phase Changes
```graphql
subscription PhaseChanged($matchId: ID!) {
  phaseChanged(matchId: $matchId) {
    matchId
    newPhase
    turnNumber
    timestamp
  }
}
```

### Match Completion
```graphql
subscription MatchCompleted($matchId: ID!) {
  matchCompleted(matchId: $matchId) {
    matchId
    winner
    loser
    reason
    duration
    turns
  }
}
```

## React Hook Usage

### Using Query Hooks
```typescript
import { usePlayerMatch, usePlayCard } from '@/hooks/useGraphQL';

export function GameComponent({ matchId, playerId }: Props) {
  // Fetch match data
  const { data, loading, error } = usePlayerMatch(matchId, playerId);
  
  // Setup play card mutation
  const [playCard] = usePlayCard();

  const handlePlay = async (cardIndex: number) => {
    const result = await playCard({
      variables: { matchId, playerId, cardIndex }
    });
  };

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return <div>{/* Render game */}</div>;
}
```

### Using Subscription Hooks
```typescript
import { usePlayerGameStateSubscription } from '@/hooks/useGraphQL';

export function GameBoard({ matchId, playerId }: Props) {
  // Real-time game state updates
  const { data, loading, error } = usePlayerGameStateSubscription(
    matchId,
    playerId
  );

  const gameState = data?.playerGameStateChanged;

  return (
    <div>
      {gameState && (
        <>
          <div>Health: {gameState.currentPlayer.health}</div>
          <div>Phase: {gameState.gameState.currentPhase}</div>
        </>
      )}
    </div>
  );
}
```

## Key Features

### 1. Real-Time Updates
- **Subscriptions** automatically push updates to connected clients
- Multiple clients watching the same match stay in sync
- Leaderboard updates broadcast to all interested subscribers

### 2. Flexible Queries
- Request only the data you need
- Combine user, match, and history data in a single request
- No over-fetching or under-fetching

### 3. WebSocket Support
- Persistent WebSocket connections for subscriptions
- Automatic reconnection handling by Apollo Client
- Graceful fallback to HTTP polling if needed

### 4. Type Safety
- Full TypeScript support
- Auto-generated types from schema
- Type-safe resolvers and hooks

## Backward Compatibility

REST endpoints are still available for compatibility:

- User Service: `:3000/api/*` (original endpoints preserved)
- Match Service: `:4000/*` (original health check available)

Gradually migrate components to use GraphQL while maintaining REST endpoints.

## Performance Considerations

### Caching
- Apollo Client caches query results automatically
- Subscriptions update cache in real-time
- Configure cache policies per query as needed

### Batch Operations
- Use GraphQL queries to fetch multiple resources in one request
- Reduces network round-trips compared to REST

### Subscriptions Cost
- Each subscription opens a WebSocket connection
- Unsubscribe when components unmount
- Monitor connection limits on backend

## Testing GraphQL

### Using Apollo Sandbox
1. Start your backend server
2. Visit `http://localhost:3000/graphql` in browser
3. Apollo Server automatically provides sandbox interface
4. Write and test queries, mutations, and subscriptions

### Testing with Code
```typescript
import { gql } from '@apollo/client';
import apolloClient from '@/lib/apolloClient';

const result = await apolloClient.query({
  query: gql`
    query GetUser($userId: ID!) {
      user(userId: $userId) {
        username
        wins
      }
    }
  `,
  variables: { userId: 'user123' }
});
```

## Troubleshooting

### WebSocket Connection Issues
- Check CORS settings in backend
- Verify WebSocket port is accessible
- Check browser console for connection errors

### Subscription Not Triggering
- Verify mutation calls `publishEvent` functions
- Check PubSub is properly initialized
- Ensure subscription filter matches event channel

### Type Errors
- Regenerate types if schema changes
- Check variable types match query/mutation definitions
- Verify Apollo Client configuration

## Migration Checklist

- [ ] Install backend dependencies (Apollo, GraphQL, WS)
- [ ] Create GraphQL schema
- [ ] Create resolvers with PubSub events
- [ ] Integrate Apollo Server in both services
- [ ] Install frontend dependencies (Apollo Client, GraphQL)
- [ ] Configure Apollo Client with WebSocket support
- [ ] Create GraphQL queries and subscriptions
- [ ] Create custom React hooks
- [ ] Update components to use hooks
- [ ] Test all functionality
- [ ] Deploy and monitor
- [ ] Deprecate REST endpoints (gradual migration)

## Next Steps

1. **Implement Additional Subscriptions**
   - Leaderboard rank changes
   - Tournament updates
   - Chat messages

2. **Add Authentication**
   - JWT tokens in WebSocket handshake
   - Per-user subscriptions
   - Authorization checks in resolvers

3. **Monitoring**
   - Track subscription count
   - Monitor WebSocket connection health
   - Log slow queries

4. **Optimization**
   - Implement query complexity analysis
   - Add rate limiting
   - Cache frequently accessed data

## Resources

- [Apollo Server Documentation](https://www.apollographql.com/docs/apollo-server/)
- [Apollo Client Documentation](https://www.apollographql.com/docs/react/)
- [GraphQL.js](https://graphql.org/)
- [graphql-ws](https://github.com/enisdenjo/graphql-ws)
