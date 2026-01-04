# 📚 Documentation Index

Complete guide to all documentation files.

## 🚀 Start Here

**First time?** Review in this order:

1. **[QUICKSTART.md](QUICKSTART.md)** (5 min) – Deploy immediately
2. **[docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md](docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md)** (15 min) – Architecture + operational overview
3. **[cdk/README.md](cdk/README.md)** (deep dive) – CDK configuration, context, troubleshooting

## 📖 Documentation Files

### Getting Started

| File | Time | Purpose |
|------|------|---------|
| **[QUICKSTART.md](QUICKSTART.md)** | 5 min | Bootstrap dev env + smoke test APIs |
| **[docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md](docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md)** | 15 min | Unified infrastructure guide |

### Reference

| File | Purpose |
|------|---------|
| **[cdk/README.md](cdk/README.md)** | Complete CDK documentation + troubleshooting |
| **[CDK_MIGRATION_SUMMARY.md](CDK_MIGRATION_SUMMARY.md)** | Terraform → CDK rationale |
| **[docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md](docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md)** | Stack reference, API surface, workflows |

### Application

| File | Purpose |
|------|---------|
| **[src/server.js](src/server.js)** | Express + GraphQL server |
| **[Dockerfile](Dockerfile)** | Container definition for ECS |
| **[package.json](package.json)** | App dependencies |

## 🎯 By Use Case

### "I just want to deploy"
→ Read: [QUICKSTART.md](QUICKSTART.md)
```bash
cd cdk && ./deploy.sh
```

### "I want to understand the architecture"
→ Read: [docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md](docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md)

### "I need to modify the infrastructure"
→ Read: [cdk/README.md](cdk/README.md) (context) + [docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md](docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md#stack-reference)

### "I want to customize the game server"
→ Edit: [src/server.js](src/server.js)

### "I need to understand what changed from Terraform"
→ Read: [CDK_MIGRATION_SUMMARY.md](CDK_MIGRATION_SUMMARY.md)

### "I'm getting errors"
→ Check: [cdk/README.md#troubleshooting](cdk/README.md#troubleshooting)

## 📁 File Structure

```
riftbound-online-backend/
├── 📄 QUICKSTART.md                    ← Start here!
├── 📄 docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md ← Unified infra guide
├── 📄 CDK_MIGRATION_SUMMARY.md         ← What changed
├── 📄 README.md                        ← Main readme
├── 📄 Documentation_Index.md           ← This file
│
├── cdk/                                ← Infrastructure Code
│   ├── 📄 README.md                    ← CDK documentation
│   ├── src/
│   │   ├── index.ts                    ← Main entry point
│   │   ├── auth-stack.ts               ← Authentication
│   │   ├── database-stack.ts           ← DynamoDB
│   │   ├── networking-stack.ts         ← VPC & networking
│   │   └── ecs-stack.ts                ← Game server
│   ├── deploy.sh                       ← Deploy script
│   ├── cleanup.sh                      ← Cleanup script
│   └── cdk.sh                          ← Quick commands
│
├── src/                                ← Game Server
│   ├── server.js                       ← Express app
│   └── logger.js                       ← Logging
│
└── Dockerfile                          ← Container image
```

## 🔍 Quick Search

### By Topic

**Authentication**
- [docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md → API Surface](docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md#api-surface-same-ecs-service)
- [cdk/README.md → Auth Section](cdk/README.md#authentication)
- [QUICKSTART.md → Test Sign-Up](QUICKSTART.md#step-6-test-sign-up)

**Deployment**
- [QUICKSTART.md](QUICKSTART.md)
- [docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md → Deployment & Operations](docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md#deployment--operations-workflows)
- [cdk/README.md → Common Commands](cdk/README.md#common-commands)

**Database**
- [docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md → Stack Reference](docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md#stack-reference)
- [cdk/README.md → DynamoDB Schema](cdk/README.md#dynamodb-schema)

**Monitoring**
- [docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md → Monitoring & Troubleshooting](docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md#monitoring--troubleshooting)
- [cdk/README.md → CloudWatch](cdk/README.md#cloudwatch-logs)
- [QUICKSTART.md → View Logs](QUICKSTART.md#view-logs)

**Scaling**
- [docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md → Deployment & Operations](docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md#deployment--operations-workflows)
- [cdk/README.md → Scaling](cdk/README.md#scaling)

**Costs**
- [docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md → Cost & Checklist](docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md#cost--checklist)
- [cdk/README.md → Cost Estimation](cdk/README.md#cost-estimation)

**Troubleshooting**
- [docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md → Monitoring & Troubleshooting](docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md#monitoring--troubleshooting)
- [cdk/README.md → Troubleshooting](cdk/README.md#troubleshooting)
- [QUICKSTART.md → Troubleshooting](QUICKSTART.md#troubleshooting)

### By Audience

**DevOps/Infrastructure**
1. [docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md](docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md)
2. [cdk/README.md](cdk/README.md)
3. CDK source files under `cdk/src/`

**Backend Developer**
1. [docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md → API Surface](docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md#api-surface-same-ecs-service)
2. [src/server.js](src/server.js)
3. [cdk/README.md](cdk/README.md)

**Ops/SRE**
1. [docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md → Monitoring & Troubleshooting](docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md#monitoring--troubleshooting)
2. [cdk/README.md → Monitoring](cdk/README.md#monitoring--observability)
3. [QUICKSTART.md → View Logs](QUICKSTART.md#view-logs)

**Frontend Developer**
1. [docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md → API Surface](docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md#api-surface-same-ecs-service)
2. [QUICKSTART.md → Test APIs](QUICKSTART.md#step-6-test-sign-up)

## 🎓 Learning Path

### Beginner
1. QUICKSTART.md
2. docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md
3. Deploy with `cd cdk && ./deploy.sh`

### Intermediate
1. docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md → Stack Reference
2. cdk/README.md
3. Modify CDK stacks under `cdk/src/`

### Advanced
1. Dive into `cdk/src/*.ts`
2. Extend infrastructure (new stacks, alarms, etc.)
3. Document updates back in docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md

## 🔗 External Resources

- [AWS CDK Docs](https://docs.aws.amazon.com/cdk/)
- [Cognito Docs](https://docs.aws.amazon.com/cognito/)
- [ECS Docs](https://docs.aws.amazon.com/ecs/)
- [DynamoDB Docs](https://docs.aws.amazon.com/dynamodb/)
- [AWS CLI Reference](https://docs.aws.amazon.com/cli/)

## ✅ Recommended Reading Order

**For First-Time Users:**
```
1. QUICKSTART.md (5 min)
   ↓
2. docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md (15 min)
   ↓
3. cdk/README.md (deep dive)
   ↓
4. Deploy → cd cdk && ./deploy.sh
```

**For Infrastructure Changes:**
```
1. docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md → Stack Reference
   ↓
2. Edit cdk/src/*.ts files
   ↓
3. npm run build
   ↓
4. npm run diff
   ↓
5. npm run deploy
```

**For Game Development:**
```
1. docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md → API Surface
   ↓
2. QUICKSTART.md → Test APIs
   ↓
3. Edit src/server.js (game logic)
   ↓
4. Build/push Docker image
   ↓
5. Redeploy via deploy.sh
```

## 🎯 Navigation Tips

### From Any File
- `QUICKSTART.md` – How to deploy & test
- `docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md` – Architecture + operations
- `cdk/README.md` – Deep-dive reference
- `CDK_MIGRATION_SUMMARY.md` – Background info

### Using Grep
```bash
# Find service references
grep -r "DynamoDB" .

# List all markdown headings
grep -n "^#" docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md
```

### Using Find
```bash
find cdk/src -name "*.ts"
find docs -name "*.md"
```

## 📊 Documentation Statistics

- **Total Markdown Guides**: 15+
- **Architecture diagrams**: 5+
- **Command snippets**: 30+

## 🔄 How to Use This Index

1. Locate the scenario under "By Use Case" or "Quick Search".
2. Jump into the linked document/section.
3. Follow the recommended commands.
4. Keep docs updated if you change behavior.

## 💬 Questions?

- **Deployment issues?** → QUICKSTART.md or cdk/README.md → Troubleshooting
- **Need stack context?** → docs/infrastructure/INFRASTRUCTURE_OVERVIEW.md
- **Want raw CDK details?** → cdk/README.md + `cdk/src/*`

Happy deploying! 🚀
