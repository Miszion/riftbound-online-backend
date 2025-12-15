# Riftbound Online Backend

Complete infrastructure and application code for **Riftbound Online** game backend using **AWS CDK**.

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- AWS Account with CLI credentials configured
- Docker (for container deployment)

### 1-Minute Setup

```bash
# Navigate to CDK directory
cd cdk

# Install dependencies
npm install

# Deploy infrastructure
ENVIRONMENT=dev ./deploy.sh
```

That's it! Your backend is running.

## 📦 What's Included

### **AWS CDK Infrastructure** (`/cdk`)
Complete infrastructure as code with:
- ✅ Cognito authentication (sign-up, sign-in, token refresh)
- ✅ Built-in Express auth endpoints
- ✅ ECS Fargate for game server
- ✅ DynamoDB for users and match history
- ✅ VPC with NAT gateways and load balancing
- ✅ Auto-scaling for high availability

### **Game Server** (`/src`)
Express.js server with:
- User profile management
- Match history tracking
- Leaderboard system
- DynamoDB integration

### **Docker** (`Dockerfile`)
Container image for ECS deployment with health checks.

## 📋 Architecture

```
┌─────────────────────────────────────────────┐
│           AWS Cloud                         │
├─────────────────────────────────────────────┤
│                                             │
│  Cognito User Pool                          │
│         │                                   │
│         └──────────── Express Auth Routes   │
│                                             │
│  Application Load Balancer                  │
│         │                                   │
│    ┌────┴────┐                             │
│    │         │                             │
│   ECS       ECS      (Auto-scaling)        │
│  Task 1     Task 2                         │
│    │         │                             │
│    └────┬────┘                             │
│         │                                  │
│    DynamoDB                                │
│    ├── Users Table                         │
│    └── Match History Table                 │
│                                            │
└────────────────────────────────────────────┘
```

## 📖 Documentation

### CDK Infrastructure
See [cdk/README.md](cdk/README.md) for:
- Architecture details
- Stack definitions
- Deployment instructions
- Configuration options
- Troubleshooting guide

### Application Code
See [src/](src/) for game server implementation.

### Deployment Scripts
- `cdk/deploy.sh` - Deploy infrastructure
- `cdk/cleanup.sh` - Destroy infrastructure
- `cdk/cdk.sh` - Quick reference commands

## 🔧 Common Tasks

### Deploy Infrastructure

```bash
cd cdk

# Development environment
./deploy.sh

# Production with custom image
ENVIRONMENT=prod \
  CONTAINER_IMAGE=123456789.dkr.ecr.us-east-1.amazonaws.com/myapp:latest \
  DESIRED_COUNT=4 \
  ./deploy.sh
```

### View Deployment Status

```bash
cd cdk

# List stacks
npm run list

# Show outputs
cdk list

# Show what changed
npm run diff
```

### Test Authentication API

```bash
# Get API endpoint from stack outputs
API_ENDPOINT=$(aws cloudformation describe-stacks \
  --query 'Stacks[?StackName==`RiftboundAuth-dev`].Outputs[?OutputKey==`ApiEndpoint`].OutputValue' \
  --output text)

# Sign up
curl -X POST $API_ENDPOINT/sign-up \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "TestPass123!",
    "username": "testuser"
  }'

# Sign in
curl -X POST $API_ENDPOINT/sign-in \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "TestPass123!"
  }'
```

### View Logs

```bash
# ECS logs
aws logs tail /ecs/riftbound-dev --follow
```

### Cleanup

```bash
cd cdk
./cleanup.sh
```

## 🗂️ Project Structure

```
riftbound-online-backend/
├── cdk/                          # AWS CDK Infrastructure
│   ├── src/
│   │   ├── index.ts             # Main app (defines stacks)
│   │   ├── auth-stack.ts        # Cognito + Identity Pools
│   │   ├── database-stack.ts    # DynamoDB tables
│   │   ├── networking-stack.ts  # VPC and networking
│   │   └── ecs-stack.ts         # ECS Fargate
│   ├── deploy.sh                # Deploy script
│   ├── cleanup.sh               # Cleanup script
│   ├── cdk.sh                   # Quick reference
│   ├── cdk.json                 # CDK config
│   ├── package.json
│   ├── tsconfig.json
│   └── README.md                # Detailed docs
│
├── src/                          # Game Server
│   ├── server.js                # Express server
│   └── logger.js                # Winston logging
│
├── Dockerfile                   # Container image
├── package.json                # Dependencies
├── .env.example                # Environment template
└── README.md                   # This file
```

## 🔐 Security

### Authentication Flow
1. User signs up via `/sign-up` endpoint
2. Cognito verifies email (auto-confirmed in dev)
3. User signs in via `/sign-in` endpoint
4. Returns JWT tokens (ID, Access, Refresh)
5. Client uses Access token for API requests

### Database Security
- Point-in-time recovery enabled
- Encryption at rest enabled
- VPC-isolated (no public endpoints)
- IAM-controlled access

### Infrastructure Security
- All traffic through security groups
- ECS tasks in private subnets
- ALB in public subnets
- NAT gateways for outbound access

## 📊 Monitoring

### CloudWatch Logs
```bash
# View all logs
aws logs describe-log-groups

# Follow ECS logs
aws logs tail /ecs/riftbound-dev --follow
```

### CloudWatch Metrics
- ECS CPU/Memory utilization
- ALB request count and latency
- DynamoDB consumed capacity

## 💰 Cost Estimation

Monthly costs (approximate, US East 1):

| Service | Cost | Notes |
|---------|------|-------|
| Cognito | $0.50 | Per 10k authentications |
| ECS Fargate | $60-100 | Depends on CPU/memory |
| DynamoDB | $5-50 | On-demand billing |
| ALB | $16 | Plus $0.006 per LCU |
| **Total** | ~$80-170 | Dev environment |

See [cdk/README.md](cdk/README.md) for production cost estimates.

## 🚀 Deployment Workflow

### Development

```bash
# Deploy dev environment
ENVIRONMENT=dev ./cdk/deploy.sh

# Test locally
npm install && npm run dev

# Push code changes
git push

# Redeploy when needed
ENVIRONMENT=dev ./cdk/deploy.sh
```

### Production

```bash
# Build container image
docker build -t myapp:prod .

# Push to ECR
aws ecr create-repository --repository-name riftbound-online
docker tag myapp:prod 123456789.dkr.ecr.us-east-1.amazonaws.com/riftbound-online:prod
docker push 123456789.dkr.ecr.us-east-1.amazonaws.com/riftbound-online:prod

# Deploy infrastructure
ENVIRONMENT=prod \
  CONTAINER_IMAGE=123456789.dkr.ecr.us-east-1.amazonaws.com/riftbound-online:prod \
  DESIRED_COUNT=4 \
  TASK_CPU=2048 \
  TASK_MEMORY=4096 \
  ./cdk/deploy.sh
```

## 📚 API Documentation

### Authentication Endpoints

**Sign Up**
```
POST /sign-up
Content-Type: application/json

{
  "email": "player@example.com",
  "password": "SecurePass123!",
  "username": "playername"
}

Response: {
  "message": "User signed up successfully",
  "userId": "uuid"
}
```

**Sign In**
```
POST /sign-in
Content-Type: application/json

{
  "email": "player@example.com",
  "password": "SecurePass123!"
}

Response: {
  "idToken": "eyJ...",
  "accessToken": "eyJ...",
  "refreshToken": "...",
  "expiresIn": 3600
}
```

**Refresh Token**
```
POST /refresh-token
Content-Type: application/json

{
  "refreshToken": "refresh_token_value"
}

Response: {
  "idToken": "eyJ...",
  "accessToken": "eyJ...",
  "expiresIn": 3600
}
```

### Game API Endpoints

**Get User Profile**
```
GET /api/users/{userId}
Authorization: Bearer {accessToken}
```

**Update User Profile**
```
PUT /api/users/{userId}
Authorization: Bearer {accessToken}

{
  "username": "newname",
  "userLevel": 15,
  "wins": 25
}
```

**Get Match History**
```
GET /api/users/{userId}/matches?limit=10
Authorization: Bearer {accessToken}
```

**Create Match**
```
POST /api/matches
Authorization: Bearer {accessToken}

{
  "players": ["user1", "user2"],
  "winner": "user1",
  "duration": 1200
}
```

**Get Leaderboard**
```
GET /api/leaderboard?limit=100
```

## 🐛 Troubleshooting

### Bootstrap Error
```bash
cdk bootstrap aws://ACCOUNT-ID/us-east-1
```

### Check Stack Status
```bash
aws cloudformation describe-stacks \
  --query 'Stacks[].{Name:StackName,Status:StackStatus}'
```

### View Stack Events
```bash
aws cloudformation describe-stack-events \
  --stack-name RiftboundAuth-dev \
  --query 'StackEvents[].{Time:Timestamp,Status:ResourceStatus,Type:ResourceType,Reason:ResourceStatusReason}' \
  --output table
```

### Check ECS Service Status
```bash
aws ecs describe-services \
  --cluster riftbound-dev-cluster \
  --services riftbound-dev-service
```

## 📖 Additional Resources

- [AWS CDK Docs](https://docs.aws.amazon.com/cdk/)
- [Cognito Docs](https://docs.aws.amazon.com/cognito/)
- [ECS Docs](https://docs.aws.amazon.com/ecs/)
- [DynamoDB Docs](https://docs.aws.amazon.com/dynamodb/)
- [CDK Typescript Examples](https://github.com/aws-samples/aws-cdk-examples)

## 🤝 Contributing

1. Create feature branch
2. Make changes in code
3. Update CDK if needed
4. Test locally
5. Deploy to dev environment
6. Submit PR

## 📝 License

ISC

---

**Need help?** See [cdk/README.md](cdk/README.md) for detailed documentation.
