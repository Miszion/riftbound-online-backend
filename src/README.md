# Riftbound Online - Game Server Source (TypeScript)

The game server is now written entirely in **TypeScript** for type safety, better IDE support, and improved maintainability.

## Project Structure

```
src/
├── server.ts          ← Main Express server with all game endpoints
├── logger.ts          ← Winston logger configuration
└── .gitignore         ← Ignore rules for src/ directory
```

## Building

### Build TypeScript

```bash
npm run build
```

This compiles all TypeScript files in `src/` to JavaScript in the `dist/` directory.

### Watch Mode (Development)

```bash
npm run watch
```

Automatically recompiles TypeScript files when they change.

## Running

### Development Mode

```bash
npm run dev
```

Starts the server with nodemon using ts-node for live reload. The server watches for TypeScript file changes and automatically restarts.

### Production Mode

```bash
npm run build
npm start
```

Compiles TypeScript to JavaScript, then runs the compiled server from the `dist/` directory.

## API Endpoints

### Health Check
- **GET** `/health` - Returns server health status

### User Profile
- **GET** `/api/users/:userId` - Get user profile
  - Response: `UserProfile`
  
- **PUT** `/api/users/:userId` - Update user profile
  - Body: `UserUpdateRequest`
  - Response: Updated `UserProfile`

### Matches
- **POST** `/api/matches` - Create a match record
  - Body: `MatchCreateRequest`
  - Response: Created `MatchRecord`
  
- **GET** `/api/users/:userId/matches` - Get user's match history
  - Query: `limit` (default: 10)
  - Response: Array of `MatchRecord[]`

### Leaderboard
- **GET** `/api/leaderboard` - Get player leaderboard sorted by wins
  - Query: `limit` (default: 100)
  - Response: Array of `LeaderboardUser[]`

## Type Definitions

### UserProfile

```typescript
interface UserProfile {
  UserId: string;
  Username?: string;
  Email?: string;
  UserLevel?: number;
  Wins?: number;
  TotalMatches?: number;
  LastLogin?: number;
  CreatedAt?: number;
}
```

### UserUpdateRequest

```typescript
interface UserUpdateRequest {
  username?: string;
  userLevel?: number;
  wins?: number;
  totalMatches?: number;
}
```

### MatchRecord

```typescript
interface MatchRecord {
  MatchId: string;
  Timestamp: number;
  CreatedAt: number;
  UserId?: string;
  Players: string[];
  Winner: string;
  Duration: number;
}
```

### MatchCreateRequest

```typescript
interface MatchCreateRequest {
  players: string[];
  winner: string;
  duration: number;
}
```

### LeaderboardUser

```typescript
interface LeaderboardUser extends UserProfile {
  Wins: number;
}
```

## Environment Variables

Create a `.env` file in the root directory:

```env
# Server
PORT=3000
LOG_LEVEL=info
ENVIRONMENT=development

# AWS
AWS_REGION=us-east-1

# DynamoDB Tables
USERS_TABLE=riftbound-online-users-dev
MATCH_HISTORY_TABLE=riftbound-online-match-history-dev
```

## Configuration

### TypeScript Configuration (`tsconfig.json`)

- **Target**: ES2020
- **Module**: CommonJS
- **Strict Mode**: Enabled (strict type checking)
- **Source Maps**: Enabled (for debugging)
- **Declaration Files**: Generated (`.d.ts` files)

Key compiler options:
- `strict: true` - Enable all strict type checking options
- `noImplicitAny: true` - Error on implicit `any` types
- `strictNullChecks: true` - Strict null/undefined checking
- `noUnusedLocals: true` - Error on unused local variables
- `noUnusedParameters: true` - Error on unused function parameters

### Logging

The server uses Winston for structured logging:

```typescript
import logger from './logger';

logger.info('Server starting...');
logger.error('Something went wrong:', error);
logger.warn('This is a warning');
logger.debug('Debug information');
```

Log level is controlled by the `LOG_LEVEL` environment variable (default: `info`).

## AWS Integration

### DynamoDB

The server integrates with DynamoDB for persistent storage:

```typescript
const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || 'us-east-1'
});
```

Tables used:
- `riftbound-online-users-dev` - User profiles with Email and Username GSIs
- `riftbound-online-match-history-dev` - Match history with UserId GSI

### Security

- **Helmet.js** - HTTP headers security
- **CORS** - Cross-origin resource sharing
- **AWS IAM** - Database access controlled via IAM roles (set by CDK)

## File Structure

### logger.ts

Configures Winston logger with:
- Timestamp formatting
- Error stack traces
- JSON output format
- Console transport with colorized output

### server.ts

Express server with:
- Middleware (helmet, CORS, JSON parsing, request logging)
- User endpoints (GET, PUT)
- Match endpoints (POST, GET)
- Leaderboard endpoint (GET)
- Error handling middleware
- 404 handler
- Server startup on configurable PORT

## Development Workflow

```bash
# 1. Install dependencies
npm install

# 2. Create .env file
cp .env.example .env

# 3. Run in development mode with auto-reload
npm run dev

# 4. Server runs on http://localhost:3000
# 5. Make changes to src/*.ts files
# 6. Server automatically restarts with ts-node
```

## Production Deployment

```bash
# 1. Build TypeScript
npm run build

# 2. Verify dist/ directory is created
ls -la dist/

# 3. Test compiled server
npm start

# 4. Docker containers will use compiled version:
# - COPY dist/ /app/dist/
# - CMD ["node", "dist/server.js"]
```

## Error Handling

All endpoints return consistent error responses:

```typescript
interface ErrorResponse {
  statusCode: number;
  error: string;
}
```

Status codes:
- **200** - OK
- **201** - Created
- **400** - Bad request
- **404** - Not found
- **500** - Internal server error

Errors are logged to CloudWatch when deployed on ECS.

## Testing

```bash
# Run tests
npm test

# Run tests in watch mode
npm test:watch

# Run with coverage
npm test -- --coverage
```

## Code Quality

```bash
# Lint TypeScript files
npm run lint

# Format code with Prettier
npm run format

# Watch for changes
npm run watch
```

## Migration from JavaScript

All files have been converted from JavaScript to TypeScript:

| Before | After |
|--------|-------|
| `src/server.js` | `src/server.ts` |
| `src/logger.js` | `src/logger.ts` |

**What changed:**
- Added TypeScript types throughout
- Added interface definitions for request/response bodies
- Updated imports to use ES6 module syntax
- Enabled strict type checking
- Added proper error typing for middleware

## Dependencies

### Production
- `express` - Web framework
- `aws-sdk` - AWS services (DynamoDB, Cognito)
- `cors` - Cross-origin resource sharing
- `helmet` - HTTP headers security
- `winston` - Logging
- `uuid` - ID generation
- `dotenv` - Environment variables

### Development
- `typescript` - TypeScript compiler
- `ts-node` - TypeScript execution for Node.js
- `@types/*` - Type definitions
- `nodemon` - File change monitoring
- `jest` - Testing framework
- `eslint` - Code linting
- `prettier` - Code formatting

## Resources

- [Express.js Documentation](https://expressjs.com/)
- [TypeScript Documentation](https://www.typescriptlang.org/docs/)
- [AWS SDK for JavaScript](https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/)
- [Winston Logger](https://github.com/winstonjs/winston)
- [nodemon](https://nodemon.io/)
- [ts-node](https://typestrong.org/ts-node/)

## Next Steps

1. **Implement game logic** - Add matchmaking, player state, gameplay mechanics
2. **Add WebSocket support** - For real-time gameplay communication
3. **Add authentication middleware** - Validate JWT tokens from Cognito
4. **Add unit tests** - Test all endpoints with Jest
5. **Add monitoring** - CloudWatch dashboards and alarms
6. **Add CI/CD pipeline** - Automated testing and deployment

## Questions?

See the main documentation:
- `QUICKSTART.md` - Getting started guide
- `CDK_README.md` - Infrastructure documentation
- `INFRASTRUCTURE_OVERVIEW.md` - Architecture overview
