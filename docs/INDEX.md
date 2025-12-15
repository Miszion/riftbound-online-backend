# Riftbound Online Backend - Documentation

Welcome to the Riftbound Online Backend documentation. This is your central hub for understanding the game server architecture, match service, and game rules.

## 📚 Documentation Structure

### Quick Start
- **[Quickstart Guide](./QUICKSTART.md)** - Get up and running in 5 minutes
- **[Match Service Quick Start](./MATCH_SERVICE_QUICKSTART.md)** - Deploy match service quickly

### Core Documentation

#### 🎮 Game Rules & Logic
- **[Rules Summary](./docs/RULES_SUMMARY.md)** - Riftbound TCG rules reference for developers
- **[Game Rules Implementation Guide](./docs/GAME_RULES_IMPLEMENTATION.md)** - Connect rules to code implementation
- **[Complete Rules PDF](./docs/RIFTBOUND_RULES.md)** - Full Riftbound Core Rules (v1.2)

#### 🏗️ Infrastructure & Architecture  
- **[Infrastructure Overview](./INFRASTRUCTURE_OVERVIEW.md)** - High-level AWS architecture
- **[CDK Migration Summary](./CDK_MIGRATION_SUMMARY.md)** - Terraform to AWS CDK conversion
- **[CDK Stacks Reference](./cdk/STACKS_REFERENCE.md)** - Detailed CDK stack breakdown
- **[CDK README](./CDK_README.md)** - CDK setup and deployment

#### ⚙️ Match Service
- **[Match Service README](./MATCH_SERVICE_README.md)** - Match service overview & navigation
- **[Match Service Guide](./MATCH_SERVICE.md)** - Comprehensive match service documentation
- **[Match Service Implementation](./MATCH_SERVICE_IMPLEMENTATION.md)** - Implementation details & API
- **[Match Service Integration](./MATCH_SERVICE_INTEGRATION.md)** - Integration with main server
- **[Match Service Completion Report](./MATCH_SERVICE_COMPLETE.md)** - Delivery report

#### 📦 Source Code Organization
- **[Source Code README](./src/README.md)** - Source structure & components
- **[Lambda Functions README](./lambda/README.md)** - Lambda function documentation

#### 📋 Project Documentation
- **[README](./README.md)** - Main project overview
- **[Delivery Summary](./DELIVERY_SUMMARY.md)** - Project delivery summary
- **[Completion Report](./COMPLETION_REPORT.md)** - Documentation reorganization completion report
- **[Documentation Index](./Documentation_Index.md)** - Legacy index

---

## 🗺️ Navigation by Use Case

### I want to...

#### Deploy the Backend
1. Read [Quickstart](./QUICKSTART.md)
2. Review [Infrastructure Overview](./INFRASTRUCTURE_OVERVIEW.md)
3. Follow [CDK README](./CDK_README.md)

#### Work on Game Logic
1. Review [Rules Summary](./docs/RULES_SUMMARY.md)
2. Check [Match Service Implementation](./MATCH_SERVICE_IMPLEMENTATION.md)
3. Reference `src/game-engine.ts` for implementation

#### Deploy Match Service
1. Start with [Match Service Quick Start](./MATCH_SERVICE_QUICKSTART.md)
2. Read full [Match Service Guide](./MATCH_SERVICE.md)
3. Review [Integration Guide](./MATCH_SERVICE_INTEGRATION.md)

#### Integrate Services
1. Read [Infrastructure Overview](./INFRASTRUCTURE_OVERVIEW.md)
2. Review [Match Service Integration](./MATCH_SERVICE_INTEGRATION.md)
3. Check [Lambda Functions README](./lambda/README.md)

#### Understand Game Rules
1. Start with [Rules Summary](./docs/RULES_SUMMARY.md)
2. Deep dive with [Complete Rules](./docs/RIFTBOUND_RULES.md)
3. Reference implementation in `src/game-engine.ts`

---

## 🚀 Quick Links

**Development Commands**
```bash
# Build the project
npm run build

# Run tests
npm run test

# Deploy infrastructure
cdk deploy

# Deploy match service
npm run deploy:match-service
```

**Key Files**
- Game Logic: `src/game-engine.ts`
- Match Service: `src/match-service.ts`
- Infrastructure: `cdk/src/`
- Lambda Functions: `lambda/`

---

## 📖 Document Overview

| Document | Purpose | Audience |
|----------|---------|----------|
| QUICKSTART | Get running in 5 minutes | Everyone |
| RULES_SUMMARY | Riftbound TCG rules for devs | Game Logic Developers |
| INFRASTRUCTURE_OVERVIEW | AWS architecture | DevOps / Backend Engineers |
| MATCH_SERVICE.md | Complete match service guide | Integration Engineers |
| MATCH_SERVICE_IMPLEMENTATION | API & code details | Backend Developers |
| MATCH_SERVICE_INTEGRATION | Service integration guide | Integration Engineers |
| CDK_README | CDK setup & deployment | DevOps / Architects |

---

## 🔍 Technology Stack

- **Language**: TypeScript
- **Runtime**: Node.js 18.x
- **Framework**: Express.js  
- **Infrastructure**: AWS CDK
- **Services**: Lambda, ECS Fargate, DynamoDB, API Gateway, Cognito
- **Database**: DynamoDB for persistent game state
- **Containerization**: Docker
- **Orchestration**: ECS Fargate (one task per match)

---

## 📝 Document Maintenance

All documentation is in Markdown format and located in:
- Root directory: Project-level docs
- `docs/`: Game rules and specifications
- `cdk/`: Infrastructure documentation
- `src/`, `lambda/`: Component-specific READMEs

When updating documentation, maintain consistent formatting and update this index accordingly.

---

**Last Updated**: December 2024  
**Riftbound Version**: Core Rules v1.2  
**Status**: Production Ready
