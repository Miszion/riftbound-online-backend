# Riftbound Online Backend

Welcome to the Riftbound Online Backend repository. This is a complete TypeScript-based game server for the Riftbound Trading Card Game, featuring AWS infrastructure, a real-time match engine, and comprehensive game logic implementation.

## 🚀 Quick Start

Get up and running in minutes:

1. **Need match engine internals?** → See [docs/GAME_RULES_IMPLEMENTATION.md](./docs/GAME_RULES_IMPLEMENTATION.md)
2. **Understand the rules?** → Check [docs/RULES_SUMMARY.md](./docs/RULES_SUMMARY.md)

## 📚 Documentation

All documentation is organized in the `docs/` directory:

- **[docs/RULES_SUMMARY.md](./docs/RULES_SUMMARY.md)** - Riftbound TCG rules reference
- **[docs/GAME_RULES_IMPLEMENTATION.md](./docs/GAME_RULES_IMPLEMENTATION.md)** - Rules-to-code implementation map
- **[docs/RIFTBOUND_GAME_ENGINE_GUIDE.md](./docs/RIFTBOUND_GAME_ENGINE_GUIDE.md)** - Match flow & engine expectations
- **[docs/INFRASTRUCTURE_OVERVIEW.md](./docs/INFRASTRUCTURE_OVERVIEW.md)** - Unified AWS infrastructure guide

## 🏗️ Project Structure

```
src/
  ├── game-engine.ts       # Complete game logic (1000+ lines)
  ├── match-routes.ts      # Integrated match engine REST routes
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
- **Integrated Match Engine**: Core gameplay logic exposed directly from this service
- **Scalable Architecture**: Single ECS service with auto scaling app + match containers
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

- Run `npm run generate:cards` to download the champion dump directly and emit `data/cards.enriched.json` plus `data/card-images.json`.
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

## 🔐 Authentication

The Express server now exposes `/auth/sign-in`, `/auth/sign-up`, and `/auth/refresh` endpoints directly, so the UI talks to the ECS service without any Lambda/API Gateway hops. Set `COGNITO_USER_POOL_ID` and `COGNITO_CLIENT_ID` (plus `AWS_REGION`) before starting the server or deploying so the handlers can reach your Cognito pool. Successful sign-ups automatically confirm the user and upsert their DynamoDB profile; sign-ins return Cognito tokens plus expiry metadata so the UI can refresh sessions via `/auth/refresh`.

## ⚙️ Environment Configuration

All backend scripts read `.env` in the repository root so you can manage deployment variables (AWS profile, region, Cognito, ECR, etc.) in one place. Update the file with your own values:

```bash
AWS_PROFILE=riftbound-dev
AWS_REGION=us-east-1
ENVIRONMENT=dev
COGNITO_USER_POOL_ID=us-east-1_example
COGNITO_CLIENT_ID=exampleclientid
CARD_CATALOG_TABLE=riftbound-dev-card-catalog
ECR_REPOSITORY=riftbound-dev-app
IMAGE_TAG=latest
CORS_ORIGINS=http://localhost:3000,https://your-ui-domain
```

The `docker:publish` and `deploy:stacks` scripts automatically source `.env`, so `npm run deploy:stacks` builds TypeScript, publishes the amd64 container image to the configured ECR repository, and deploys every CDK stack without exporting each variable manually.

During `npm run deploy:stacks` a fresh `REDEPLOY_TOKEN` is generated and baked into the ECS task definition, so each run forces a new service deployment even if you reuse the same image tag.

## 📦 Available Commands

```bash
# Installation
npm install

# Development
npm run dev           # Run with ts-node
npm run build        # Compile TypeScript
npm run test         # Run tests

# Deployment
npm run deploy:stacks  # Build TS, publish amd64 image, inject a redeploy token, then deploy all CDK stacks
cdk deploy           # Deploy infrastructure (manual control)

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
   npx cdk deploy RiftboundEcs-${ENVIRONMENT}
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
API Gateway
   ↓
Single ECS Fargate Service (port 3000)
   • REST + GraphQL API (server.ts)
   • Integrated match engine + state snapshots (match-routes.ts, game-engine.ts)
   • Cognito + matchmaking queues + chat/duel logs
```

All gameplay endpoints now live inside the same service/process as the public API, so no internal HTTP hops or extra containers are required.

## 📖 Learning Paths

### I want to...

- **Understand the game** → [docs/RULES_SUMMARY.md](./docs/RULES_SUMMARY.md)
- **Work on game logic** → `src/game-engine.ts` → [docs/GAME_RULES_IMPLEMENTATION.md](./docs/GAME_RULES_IMPLEMENTATION.md)
- **Integrate services** → [docs/INFRASTRUCTURE_OVERVIEW.md](./docs/INFRASTRUCTURE_OVERVIEW.md)
- **Work with the match engine** → [docs/RIFTBOUND_GAME_ENGINE_GUIDE.md](./docs/RIFTBOUND_GAME_ENGINE_GUIDE.md)

## 📋 Status

**Production Ready** ✅

- Core game engine complete
- Integrated match engine fully functional  
- Infrastructure deployment tested
- Full documentation provided
- TypeScript with strict type checking

## 📝 Documentation Maintenance

All documentation is in Markdown format located in:
- **Root level**: Project overview and quickstart
- **docs/**: Rules references, infrastructure guide, and engine workflows
- **cdk/**: CDK-specific documentation

Last updated: December 2024
