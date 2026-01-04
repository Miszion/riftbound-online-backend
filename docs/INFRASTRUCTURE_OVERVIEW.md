# Riftbound Online Infrastructure Guide

This document is the single source of truth for the Riftbound Online backend infrastructure. It combines the previous **Infrastructure Overview**, **CDK README**, and **Stacks Reference** so you can ramp up, deploy, and modify the platform from one place.

## At a Glance

| Area | Location | Highlights |
|------|----------|------------|
| **CDK App** | `cdk/src/*.ts` | Networking, database, auth, and ECS stacks wired together via `index.ts` |
| **Deployment Scripts** | `cdk/scripts/deploy.sh`, `cdk/scripts/cleanup.sh`, `cdk/cdk.sh` | Deploy, destroy, or run ad-hoc CDK commands |
| **Application Code** | `src/server.js` + supporting files | Express API (REST + GraphQL) that runs on ECS and talks to DynamoDB |
| **Docs that remain** | `CDK_MIGRATION_SUMMARY.md`, `QUICKSTART.md`, `cdk/README.md` | Migration notes, 5-min sandbox setup, CDK deep dive |
| **Stacks** | `NetworkingStack`, `DatabaseStack`, `AuthStack`, `EcsStack` | Covered in detail below |

## Quick Start

### Prerequisites
- Node.js 18+
- AWS CLI configured (`aws configure`)
- AWS account/credentials with rights to deploy CloudFormation + ECS + Cognito
- Docker (only needed when you build a new container image)

### Deploy in Three Steps
```bash
# 1. Bootstrap CDK for your account/region once
cd cdk
npm install
cdk bootstrap aws://ACCOUNT-ID/us-east-1

# 2. Deploy (development example)
ENVIRONMENT=dev ./scripts/deploy.sh

# 3. Smoke test authentication
API=$(aws cloudformation describe-stacks \
  --query 'Stacks[?StackName==`RiftboundAuth-dev`].Outputs[?OutputKey==`ApiEndpoint`].OutputValue' \
  --output text)

curl -X POST "$API/sign-up" \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"Test123!","username":"testuser"}'
```

## Project Layout

```
riftbound-online-backend/
├── cdk/                      # AWS CDK app (TypeScript)
│   ├── src/                  # Stack definitions (auth, db, networking, ecs)
│   ├── scripts/              # Helper scripts
│   │   ├── deploy.sh         # Deploy helper (reads ENV vars)
│   │   └── cleanup.sh        # Destroy helper
│   ├── cdk.sh                # Handy CDK commands
│   ├── package.json, tsconfig.json, cdk.json
│   └── README.md             # Additional CDK deep dive
├── src/
│   ├── server.js             # Express + GraphQL server
│   └── logger.js             # Logging utilities
├── Dockerfile                # Image for ECS tasks
├── QUICKSTART.md             # Fast local/dev bootstrap
├── CDK_MIGRATION_SUMMARY.md  # Terraform → CDK notes
└── docs/infrastructure/      # This document
```

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                    AWS Account                      │
├─────────────────────────────────────────────────────┤
│  VPC (10.0.0.0/16, 2 AZ)                            │
│  ├─ Public Subnets: NAT + Application Load Balancer │
│  └─ Private Subnets: ECS Fargate tasks              │
│                                                     │
│  Cognito (User + Identity pools)                    │
│  ├─ Express auth lambdas + API Gateway for sign-in  │
│                                                     │
│  DynamoDB                                           │
│  ├─ Users table (GSIs: Email, Username)             │
│  └─ Match history table (GSI: UserId+CreatedAt)     │
│                                                     │
│  ECS Cluster + Fargate Service                      │
│  ├─ Runs the Node.js server container               │
│  ├─ ALB → Target group → Tasks                      │
│  └─ Auto-scaling based on CPU (70%) & memory (80%)  │
└─────────────────────────────────────────────────────┘
```

## Deployment & Operations Workflows

### Development
```bash
# Deploy
ENVIRONMENT=dev ./cdk/scripts/deploy.sh

# Tweak stack configuration locally
cd cdk && npm run diff

# Tail ECS logs
aws logs tail /ecs/riftbound-dev --follow
```

### Production
```bash
# Build + push container
IMAGE=123456789.dkr.ecr.us-east-1.amazonaws.com/riftbound-online:prod
docker build -t riftbound-online:prod .
docker tag riftbound-online:prod $IMAGE
docker push $IMAGE

# Deploy with tuned capacity
ENVIRONMENT=prod \
CONTAINER_IMAGE=$IMAGE \
DESIRED_COUNT=4 \
TASK_CPU=2048 \
TASK_MEMORY=4096 \
./cdk/scripts/deploy.sh
```

### Operational Shortcuts
```bash
cd cdk
npm run list      # Show stacks
npm run synth     # Produce CloudFormation templates
npm run diff      # Review changes
./scripts/cleanup.sh      # Destroy all stacks (use with care)
```

## Stack Reference

### NetworkingStack
- **Resources**: VPC (`10.0.0.0/16`), two public + two private subnets, NAT gateways, security groups for ALB/ECS.
- **Outputs**: `VpcId`, `PrivateSubnets`, `AlbSecurityGroupId`, `EcsSecurityGroupId`.
- **Common tweaks**:
  ```typescript
  // networking-stack.ts
  new ec2.Vpc(this, 'Vpc', {
    cidr: '10.0.0.0/16',
    maxAzs: 3,
    natGateways: 3,
  });
  ```

### DatabaseStack
- **Resources**: `usersTable`, `matchHistoryTable` (both on-demand, PITR enabled, TTL cleanup, streams `NEW_AND_OLD_IMAGES`).
- **Schemas**:
  - Users: `PK=UserId`, GSIs for `Email` and `Username`, TTL on `ExpiresAt`.
  - Match history: `PK=MatchId`, `SK=Timestamp`, GSI on `UserId+CreatedAt`, TTL on `ExpiresAt`.
- **Outputs**: `UsersTableName`, `MatchHistoryTableName`.
- **Example modification**:
  ```typescript
  this.usersTable.addGlobalSecondaryIndex({
    indexName: 'CreatedAtIndex',
    partitionKey: { name: 'CreatedAt', type: AttributeType.NUMBER },
    projectionType: ProjectionType.ALL,
  });
  ```

### AuthStack
- **Purpose**: Cognito auth plus Lambda-powered REST endpoints (sign-up, sign-in, refresh token) fronted by API Gateway.
- **Resources**: `userPool`, `userPoolClient`, `identityPool`, `signIn/signUp/refresh` lambdas, `api` (RestApi).
- **Environment variables** passed to Lambdas include `COGNITO_USER_POOL_ID` and `COGNITO_CLIENT_ID`.
- **Outputs**: `UserPoolId`, `ClientId`, `ApiEndpoint`.
- **Extend example**:
  ```typescript
  this.userPool.addClient('WebClient', {
    authFlows: { userPassword: true },
    preventUserExistenceErrors: true,
  });
  ```

### EcsStack
- **Purpose**: Run the application container and expose it publicly.
- **Resources**: ECS cluster, Fargate service, task definition, ALB + listeners/target group, CloudWatch log group, IAM task/execution roles.
- **Configuration knobs**: `TASK_CPU`, `TASK_MEMORY`, `DESIRED_COUNT`, scaling range (defaults 2-4 tasks). Auto scaling triggers CPU ≥ 70% or memory ≥ 80%.
- **Outputs**: `LoadBalancerDns`, `ClusterName`, `ServiceName`.
- **Snippet**:
  ```typescript
  const scaling = this.service.autoScaleTaskCount({ minCapacity: 2, maxCapacity: 10 });
  scaling.scaleOnCpuUtilization('CpuScale', { targetUtilizationPercent: 70 });
  ```

### Stack Dependencies
```
NetworkingStack
  └─> DatabaseStack
        └─> AuthStack
              └─> EcsStack
```
Deploying via `./scripts/deploy.sh` handles this order automatically.

## API Surface (same ECS service)

All REST/GraphQL routes reside on the ECS service behind the Application Load Balancer and share the same authentication utilities.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/sign-up`, `/sign-in`, `/refresh-token` | Cognito-backed auth flows |
| GET | `/matches/:matchId` | Spectator snapshot |
| GET | `/matches/:matchId/player/:playerId` | Player view with hidden opponent info |
| POST | `/matches/init` | Initialize a match with deck payloads |
| POST | `/matches/:matchId/actions/*` | Gameplay actions (initiative, battlefield choice, mulligan, play-card, attack, move, next-phase, chat, duel-log, etc.) |
| POST | `/matches/:matchId/result` | Finalize winner/loser metadata |
| POST | `/matches/:matchId/concede` | Concede the match |
| POST | `/graphql` | GraphQL endpoint for match queries (`match`, `playerMatch`, `decklists`, etc.) |

All protected routes expect `Authorization: Bearer <accessToken>` headers sourced from the Cognito sign-in flow.

## Monitoring & Troubleshooting

- **Logs**: `aws logs tail /ecs/riftbound-<env> --follow` (real-time ECS). API Gateway/Lambda logs live under `/aws/lambda/*` groups.
- **Metrics**: CloudWatch dashboards for ECS CPU/memory, ALB request count/latency, DynamoDB consumed capacity.
- **Debug steps**:
  1. `cdk diff` to confirm synthesized changes before deploying.
  2. Check CloudFormation stack events when deployments fail.
  3. Use `aws ecs describe-services --cluster <name> --services <svc>` for health.
  4. Destroy/redeploy with `./scripts/cleanup.sh` only when you intentionally want a fresh environment.

## Security Summary

- Cognito enforces email verification and password policies (12+ chars, upper/lower/number/symbol).
- ECS tasks sit in private subnets; ALB in public subnets terminates traffic.
- DynamoDB tables are encrypted at rest, PITR enabled, IAM-scoped to task roles/Lambdas.
- Security groups restrict ingress to required ports; outbound traffic uses NAT gateways.

## Cost & Checklist

**Estimated monthly spend (us-east-1)**
- Dev: ~$90–$120 (ECS Fargate majority, ALB ~$16, DynamoDB + Cognito minimal)
- Prod: ~$200–$500 depending on task count, data transfer, and DynamoDB usage

**Before each deploy**
- [ ] AWS creds + account verified
- [ ] `cdk bootstrap` completed for the target account/region
- [ ] Environment variables set (`ENVIRONMENT`, optional overrides for image/capacity)
- [ ] Docker image pushed if deploying a new tag

## Useful Commands

```bash
# Update container image & redeploy
docker build -t myapp:latest .
docker push <account>.dkr.ecr.us-east-1.amazonaws.com/riftbound-online:latest
CONTAINER_IMAGE=<account>.dkr.ecr.us-east-1.amazonaws.com/riftbound-online:latest ./cdk/scripts/deploy.sh

# View stack outputs
cd cdk && cdk list

# Destroy everything (avoid accidental charges)
cd cdk && ./scripts/cleanup.sh
```

## Additional Resources

- `QUICKSTART.md` – five-minute hands-on bootstrap
- `cdk/README.md` – deeper explanation of constructs, context parameters, troubleshooting
- `CDK_MIGRATION_SUMMARY.md` – rationale for the CDK move
- Official AWS docs: [CDK](https://docs.aws.amazon.com/cdk/), [Cognito](https://docs.aws.amazon.com/cognito/), [ECS](https://docs.aws.amazon.com/ecs/), [DynamoDB](https://docs.aws.amazon.com/dynamodb/)

---

You now have a single, consolidated guide for infrastructure architecture, deployment workflows, stack internals, and operational playbooks. Deploy with `cd cdk && ./scripts/deploy.sh`, keep an eye on CloudWatch, and iterate with confidence. 🚀
