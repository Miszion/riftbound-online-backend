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

lambda/
  ├── auth/                # Authentication Lambda
  ├── matchmaking/         # Matchmaking Lambda
  └── README.md            # Lambda functions documentation

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

## 📦 Available Commands

```bash
# Installation
npm install

# Development
npm run dev           # Run with ts-node
npm run build        # Compile TypeScript
npm run test         # Run tests

# Deployment
cdk deploy           # Deploy infrastructure
npm run deploy:match-service  # Deploy match service

# Docker
docker build -t riftbound .
docker run -p 3000:3000 riftbound
```

## 🎯 Game Rules

This implementation is based on **Riftbound Core Rules v1.2**. Key concepts:

- **Deck Construction**: 40+ card Main Deck + 12 Rune Deck
- **Phases**: Begin → Main1 → Combat → Main2 → End
- **Resources**: Energy (generic) + Domain-specific Power
- **Zones**: Base, Battlefields, Trash, Hand, Deck, etc.
- **Card Types**: Units, Gear, Spells, Runes, Legends
- **Win Condition**: Reduce opponent health to 0

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
