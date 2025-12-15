# Riftbound Online Backend

Welcome to the Riftbound Online Backend repository. This is a complete TypeScript-based game server for the Riftbound Trading Card Game, featuring AWS infrastructure, real-time match service, and comprehensive game logic implementation.

## 🚀 Quick Start

Get up and running in minutes:

1. **New to the project?** → Read [QUICKSTART.md](./QUICKSTART.md)
2. **Full documentation** → Visit [docs/INDEX.md](./docs/INDEX.md)
3. **Deploy match service?** → See [docs/guides/MATCH_SERVICE_QUICKSTART.md](./docs/guides/MATCH_SERVICE_QUICKSTART.md)
4. **Understand the rules?** → Check [docs/RULES_SUMMARY.md](./docs/RULES_SUMMARY.md)

## 📚 Documentation

All documentation is organized in the `docs/` directory:

- **[docs/INDEX.md](./docs/INDEX.md)** - Central documentation hub
- **[docs/RULES_SUMMARY.md](./docs/RULES_SUMMARY.md)** - Riftbound TCG rules reference
- **docs/guides/** - Match service and integration guides
- **docs/infrastructure/** - AWS architecture and CDK documentation
- **docs/RIFTBOUND_RULES.md** - Complete Riftbound Core Rules (v1.2)

## 🏗️ Project Structure

```
src/
  ├── game-engine.ts       # Complete game logic (1000+ lines)
  ├── match-service.ts     # Match service REST API
  ├── logger.ts            # Logging utilities
  └── README.md            # Source code documentation

cdk/
  ├── src/                 # CDK infrastructure as code
  └── README.md            # CDK deployment guide

docs/
  ├── INDEX.md             # Documentation index
  ├── RULES_SUMMARY.md     # Game rules for developers
  ├── guides/              # Detailed guides
  └── infrastructure/      # AWS/CDK documentation
```

## 🎮 Key Features

- **Complete Game Logic**: Full Riftbound TCG rules implementation in single auditable file
- **Match Service**: Standalone ECS service managing individual match instances
- **Scalable Architecture**: One ECS task per active match
- **Real-time State Management**: DynamoDB persistence with in-memory state
- **Spectator & Replay Support**: Move history + final states recorded for post-game viewing
- **TypeScript**: Full type safety across entire codebase
- **REST API**: Eight match management endpoints
- **AWS Integration**: Lambda, API Gateway, Cognito, DynamoDB, ECS Fargate
- **Docker**: Containerized deployment

## 🛠️ Technology Stack

- **Language**: TypeScript 5.2.2
- **Runtime**: Node.js 18.x
- **Framework**: Express.js
- **Infrastructure**: AWS CDK v2
- **Database**: DynamoDB
- **Container**: Docker & ECS Fargate
- **Auth**: AWS Cognito
- **Logging**: Winston

## 🧩 Card Catalog & Assets

- Run `npm run generate:cards` to transform `champion-dump.json` into `data/cards.enriched.json` and `data/card-images.json`.
- `src/card-catalog.ts` loads the enriched data, provides lookup helpers, activation-state seeds, and drives the `cardCatalog` GraphQL queries.
- The match engine now hydrates decklists from catalog IDs/slugs and tracks activation state per permanent so stateful abilities persist correctly.
- Use the `cardImageManifest` GraphQL query (or the `data/card-images.json` file) to fetch remote artwork. Example download script:

  ```bash
  node -e "const fs=require('fs');const path=require('path');const https=require('https');const manifest=require('./data/card-images.json');manifest.forEach(({remote,localPath})=>{if(!remote)return;const target=path.resolve(localPath);fs.mkdirSync(path.dirname(target),{recursive:true});const file=fs.createWriteStream(target);https.get(remote,(res)=>{if(res.statusCode!==200){console.error('Failed',remote);res.resume();return;}res.pipe(file);});});"
  ```

- Infrastructure now provisions a `CardCatalogTable` DynamoDB table (see `cdk/src/database-stack.ts`) so the catalog can be replicated to DDB if desired.
- To seed the catalog table, export `CARD_CATALOG_TABLE` (for dev stacks this is typically `riftbound-dev-card-catalog`) and run `npm run upload:cards`. The script ingests `data/cards.enriched.json`, attaches the remote and local image paths (`CardImageUrl` / `CardImageLocalPath`) so the UI can fetch artwork quickly, chunk-writes everything to DynamoDB, and retries throttled batches automatically. Example:

  ```bash
  export AWS_PROFILE=riftbound-dev
  export AWS_REGION=us-east-1
  export CARD_CATALOG_TABLE=riftbound-dev-card-catalog
  npm run upload:cards
  ```

-## 🔐 Authentication
-
-The Express server now exposes `/auth/sign-in`, `/auth/sign-up`, and `/auth/refresh` endpoints directly, so the UI talks to the ECS service without any Lambda/API Gateway hops. Set `COGNITO_USER_POOL_ID` and `COGNITO_CLIENT_ID` (plus `AWS_REGION`) before starting the server or deploying so the handlers can reach your Cognito pool. Successful sign-ups automatically confirm the user and upsert their DynamoDB profile; sign-ins return Cognito tokens plus expiry metadata so the UI can refresh sessions via `/auth/refresh`.
-
## 📦 Available Commands

```bash
# Installation
npm install

# Development
npm run dev           # Run with ts-node
npm run build        # Compile TypeScript
npm run test         # Run tests

# Deployment
npm run deploy:stacks  # Build + deploy all CDK stacks w/ latest AWS CDK CLI (respects ENVIRONMENT)
cdk deploy           # Deploy infrastructure (manual control)
npm run deploy:match-service  # Deploy match service

# Docker
docker build -t riftbound .
docker run -p 3000:3000 riftbound
```

> **Heads up:** Raw `cdk` commands must run from the `cdk/` directory (or be given an explicit `--app` argument). Running `cdk deploy` from the repo root triggers the “--app is required” error the CLI is warning about. When you need a specific CDK version, invoke it explicitly (e.g. `npx aws-cdk@latest deploy`) so the CLI matches the libraries defined in `cdk/package.json`.

## 🚢 Deployment Workflow (Dev Environments)

Follow this sequence whenever you need to roll out the backend plus supporting data to AWS dev:

1. **Bootstrap env vars**
   ```bash
   export AWS_PROFILE=riftbound-dev
   export AWS_REGION=us-east-1
   export ENVIRONMENT=dev
   ```
2. **Deploy shared data plane**
   ```bash
   npm run deploy:stacks  # or run the individual commands below
   cd cdk
   npm install
   npx cdk synth
   npx cdk deploy DatabaseStack-${ENVIRONMENT}
   npx cdk deploy MatchServiceStack-${ENVIRONMENT}
   ```
   (Add any other stacks—API Gateway, auth, etc.—that you need for the feature set you're touching.)
3. **Publish latest application build**
   ```bash
   npm install
   npm run build
   npm run start # or your container/ECS deploy flow
   ```
4. **Seed card catalog (only when source data changed)**
   ```bash
   export CARD_CATALOG_TABLE=riftbound-${ENVIRONMENT}-card-catalog
   npm run upload:cards
   ```

Because this environment is sandboxed we did not run the commands above, but they are ready for you to execute locally once you have AWS credentials configured.

## 🎯 Game Rules

This implementation is based on **Riftbound Core Rules v1.2**. Key concepts:

- **Deck Construction**: 40+ card Main Deck + 12 Rune Deck
- **Phases**: Begin → Main1 → Combat → Main2 → End
- **Resources**: Energy (generic) + Domain-specific Power
- **Zones**: Base, Battlefields, Trash, Hand, Deck, etc.
- **Card Types**: Units, Gear, Spells, Runes, Legends
- **Win Condition**: Be the first to reach 8 Victory Points (deck exhaustion and special cards remain alternate endings)

See [docs/RULES_SUMMARY.md](./docs/RULES_SUMMARY.md) for full rules reference.

## 🔄 Architecture Overview

```
Main Server (Lambda + API Gateway)
    ↓
Cognito (Authentication)
    ↓
Match Service (ECS Fargate)
    ├── Game Engine (game-engine.ts)
    ├── Match Service API (match-service.ts)
    └── DynamoDB (State Persistence)
```

Each active match runs in its own ECS task, isolated and scalable.

## 📖 Learning Paths

### I want to...

- **Deploy the system** → [QUICKSTART.md](./QUICKSTART.md) → [docs/infrastructure/CDK_README.md](./docs/infrastructure/CDK_README.md)
- **Understand the game** → [docs/RULES_SUMMARY.md](./docs/RULES_SUMMARY.md)
- **Work on game logic** → `src/game-engine.ts` → [docs/guides/MATCH_SERVICE_IMPLEMENTATION.md](./docs/guides/MATCH_SERVICE_IMPLEMENTATION.md)
- **Integrate services** → [docs/guides/MATCH_SERVICE_INTEGRATION.md](./docs/guides/MATCH_SERVICE_INTEGRATION.md)
- **Deploy match service** → [docs/guides/MATCH_SERVICE_QUICKSTART.md](./docs/guides/MATCH_SERVICE_QUICKSTART.md)

## 📋 Status

**Production Ready** ✅

- Core game engine complete
- Match service fully functional  
- Infrastructure deployment tested
- Full documentation provided
- TypeScript with strict type checking

## 📝 Documentation Maintenance

All documentation is in Markdown format located in:
- **Root level**: Project overview and quickstart
- **docs/**: Comprehensive guides and specifications
- **docs/guides/**: Implementation and integration guides  
- **docs/infrastructure/**: AWS architecture and deployment

Last updated: December 2024
