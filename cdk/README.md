# Riftbound Online - AWS CDK Infrastructure

Complete Infrastructure as Code for Riftbound Online backend using **AWS CDK with TypeScript**.

## Why AWS CDK?

- ✅ **Type-Safe**: Full TypeScript support with IDE autocomplete
- ✅ **Simple**: Less boilerplate than Terraform/CloudFormation
- ✅ **Modular**: Stack-based architecture for reusability
- ✅ **Powerful**: Access to complete AWS API
- ✅ **Fast**: Rapid iteration and deployment

## Project Structure

```
cdk/
├── src/
│   ├── index.ts              # Main entry point (defines stacks)
│   ├── auth-stack.ts         # Cognito + Lambda authentication
│   ├── database-stack.ts     # DynamoDB tables
│   ├── networking-stack.ts   # VPC, subnets, security groups
│   └── ecs-stack.ts          # ECS Fargate cluster and service
├── cdk.json                  # CDK configuration
├── cdk.sh                    # Quick reference commands
├── deploy.sh                 # Deployment script
├── cleanup.sh                # Cleanup/destroy script
├── package.json              # Dependencies
└── tsconfig.json             # TypeScript configuration
```

## Prerequisites

### 1. Install Node.js
```bash
# Using Homebrew (macOS)
brew install node@18

# Or use nvm
nvm install 18
nvm use 18
```

### 2. Install AWS CDK
```bash
npm install -g aws-cdk
```

### 3. Configure AWS Credentials
```bash
aws configure
# Enter your AWS Access Key ID
# Enter your AWS Secret Access Key
# Default region: us-east-1
# Default output format: json
```

### 4. Bootstrap CDK (One-time setup)
```bash
cdk bootstrap aws://ACCOUNT-ID/us-east-1
```

## Quick Start

### 1. Install Dependencies
```bash
cd cdk
npm install
```

### 2. Build the Project
```bash
npm run build
```

### 3. Preview the Stacks
```bash
npm run synth
# or
cdk synth
```

### 4. Deploy Infrastructure
```bash
./deploy.sh
# or
ENVIRONMENT=dev npm run deploy
```

### 5. View Outputs
```bash
cdk list
```

## Configuration

### Environment Variables

Set these before deployment:

```bash
# Environment name (dev, staging, prod)
export ENVIRONMENT=dev

# Docker image for ECS (must be accessible)
export CONTAINER_IMAGE=nginx:latest
# or use ECR: 123456789.dkr.ecr.us-east-1.amazonaws.com/myapp:latest

# ECS configuration
export DESIRED_COUNT=2
export TASK_CPU=1024      # 256, 512, 1024, 2048, 4096
export TASK_MEMORY=2048   # 512-30720 in 1GB increments
```

### Example Deployments

```bash
# Development environment with minimal resources
ENVIRONMENT=dev CONTAINER_IMAGE=nginx:latest ./deploy.sh

# Production with high availability
ENVIRONMENT=prod \
  CONTAINER_IMAGE=123456789.dkr.ecr.us-east-1.amazonaws.com/myapp:latest \
  DESIRED_COUNT=4 \
  TASK_CPU=2048 \
  TASK_MEMORY=4096 \
  ./deploy.sh

# Staging environment
ENVIRONMENT=staging \
  CONTAINER_IMAGE=myapp:latest \
  DESIRED_COUNT=2 \
  ./deploy.sh
```

## Stack Overview

### 1. **NetworkingStack**
Creates the network foundation:
- VPC (10.0.0.0/16) with 2 availability zones
- Public subnets (for ALB)
- Private subnets (for ECS)
- NAT Gateways (for outbound internet access)
- Security Groups (ALB and ECS)

**Exports:**
- `riftbound-{env}-vpc-id`
- `riftbound-{env}-private-subnets`
- `riftbound-{env}-alb-sg`
- `riftbound-{env}-ecs-sg`

### 2. **DatabaseStack**
Creates DynamoDB tables:

**Users Table** (`riftbound-{env}-users`)
- **PK**: UserId (String)
- **GSI**: Email
- **GSI**: Username
- **TTL**: 90 days

**Match History Table** (`riftbound-{env}-match-history`)
- **PK**: MatchId (String)
- **SK**: Timestamp (Number)
- **GSI**: UserId + CreatedAt
- **TTL**: 180 days

**Features:**
- Point-in-time recovery enabled
- Streams enabled (NEW_AND_OLD_IMAGES)
- On-demand billing (no capacity planning)

**Exports:**
- `riftbound-{env}-users-table`
- `riftbound-{env}-match-history-table`

### 3. **AuthStack**
Creates authentication infrastructure:
- **Cognito User Pool** with:
  - Email verification
  - Password policy (12+ chars, upper, lower, number, symbol)
  - Optional MFA
  - Account recovery via email
- **Cognito Identity Pool** for AWS credentials
- **Lambda Functions**:
  - Sign-in (email + password)
  - Sign-up (registration)
  - Refresh tokens
- **API Gateway** REST API with endpoints:
  - POST /sign-in
  - POST /sign-up
  - POST /refresh-token

**Exports:**
- `riftbound-{env}-userpool-id`
- `riftbound-{env}-userpool-arn`
- `riftbound-{env}-client-id`
- `riftbound-{env}-identity-pool-id`
- `riftbound-{env}-auth-api-endpoint`

### 4. **EcsStack**
Creates the game server infrastructure:
- **ECS Cluster** with CloudWatch Container Insights
- **Fargate Task Definition** with:
  - Configurable CPU/memory
  - CloudWatch logging
  - DynamoDB access
- **Application Load Balancer** with:
  - Health checks
  - Auto-target scaling
- **Auto-scaling** based on:
  - CPU utilization (70%)
  - Memory utilization (80%)
  - Min: 2 tasks, Max: 4 tasks

**Exports:**
- `riftbound-{env}-alb-dns`
- `riftbound-{env}-cluster-name`
- `riftbound-{env}-service-name`

## Common Commands

```bash
# Build TypeScript
npm run build

# Watch for changes
npm run watch

# List all stacks
cdk list
npm run list

# Synthesize to CloudFormation
cdk synth
npm run synth

# Show what will change
cdk diff
npm run diff

# Deploy all stacks
cdk deploy --all
npm run deploy

# Deploy specific stack
cdk deploy RiftboundAuth-dev

# Destroy all stacks
cdk destroy --all
npm run destroy

# Destroy specific stack
cdk destroy RiftboundAuth-dev
```

## Using the Helper Scripts

```bash
# Quick deployment
cd cdk
chmod +x deploy.sh cleanup.sh cdk.sh
./cdk.sh deploy

# Or with custom environment
ENVIRONMENT=prod ./cdk.sh deploy

# Cleanup
./cdk.sh destroy

# Quick reference
./cdk.sh help
```

## API Endpoints

### Authentication API (from AuthStack)

**Base URL**: `{API_ENDPOINT}/` (get from stack outputs)

#### Sign Up
```bash
curl -X POST {API_ENDPOINT}/sign-up \
  -H "Content-Type: application/json" \
  -d '{
    "email": "player@example.com",
    "password": "SecurePass123!",
    "username": "playername"
  }'
```

#### Sign In
```bash
curl -X POST {API_ENDPOINT}/sign-in \
  -H "Content-Type: application/json" \
  -d '{
    "email": "player@example.com",
    "password": "SecurePass123!"
  }'
```

#### Refresh Token
```bash
curl -X POST {API_ENDPOINT}/refresh-token \
  -H "Content-Type: application/json" \
  -d '{
    "refreshToken": "refresh_token_value"
  }'
```

### Game API (from EcsStack)

**Base URL**: `{ALB_DNS_NAME}/` (get from stack outputs)

#### Get User Profile
```bash
curl -X GET {ALB_DNS_NAME}/api/users/{userId} \
  -H "Authorization: Bearer {accessToken}"
```

#### Create Match
```bash
curl -X POST {ALB_DNS_NAME}/api/matches \
  -H "Authorization: Bearer {accessToken}" \
  -H "Content-Type: application/json" \
  -d '{
    "players": ["user1", "user2"],
    "winner": "user1",
    "duration": 1200
  }'
```

## DynamoDB Schema

### Users Table
```typescript
{
  UserId: string,              // PK
  Email: string,               // GSI
  Username: string,            // GSI
  CreatedAt: number,           // timestamp
  LastLogin: number,           // timestamp
  UserLevel: number,
  TotalMatches: number,
  Wins: number,
  Losses: number,
  WinRate: number,
  ExpiresAt?: number           // TTL
}
```

### Match History Table
```typescript
{
  MatchId: string,             // PK
  Timestamp: number,           // SK
  UserId: string,              // GSI
  CreatedAt: number,           // GSI SK
  Players: string[],
  Winner: string,
  Duration: number,
  GameMode?: string,
  Map?: string,
  ExpiresAt?: number           // TTL
}
```

## Monitoring & Observability

### CloudWatch Logs
- **ECS**: `/ecs/riftbound-{env}`
- **Lambda**: `/aws/lambda/riftbound-{env}-*`

### CloudWatch Metrics
- ECS CPU/Memory utilization
- ECS task count
- Lambda invocations and errors
- ALB request count and latency
- DynamoDB consumed capacity

### View Logs
```bash
# ECS logs
aws logs tail /ecs/riftbound-dev --follow

# Lambda logs
aws logs tail /aws/lambda/riftbound-dev-sign-in --follow
```

## Cost Estimation

### Monthly costs (approximate, US East 1):

| Service | Cost | Notes |
|---------|------|-------|
| **Cognito** | $0.50 | Per 10,000 authentications |
| **Lambda** | $0.20 | Per 1M requests + compute time |
| **ECS Fargate** | $60-100 | Depends on CPU/memory and uptime |
| **DynamoDB** | $5-50 | On-demand billing |
| **ALB** | $16 | Plus $0.006 per LCU |
| **Data Transfer** | $0.02/GB | Outbound traffic |
| **CloudWatch** | $5-20 | Logs and metrics |
| **Total** | ~$90-200 | For dev environment |

## Scaling

### Vertical Scaling
Increase ECS task resources:
```bash
ENVIRONMENT=dev \
  TASK_CPU=2048 \
  TASK_MEMORY=4096 \
  ./deploy.sh
```

### Horizontal Scaling
Increase desired task count:
```bash
ENVIRONMENT=dev \
  DESIRED_COUNT=4 \
  ./deploy.sh
```

Auto-scaling is pre-configured:
- Min: 2 tasks
- Max: 4 tasks
- CPU target: 70%
- Memory target: 80%

## Production Considerations

### Security
- [ ] Enable HTTPS with ACM certificate on ALB
- [ ] Enable WAF on API Gateway
- [ ] Enable MFA in Cognito
- [ ] Use VPC Endpoints for DynamoDB
- [ ] Enable encryption at rest and in transit
- [ ] Use AWS Secrets Manager for sensitive data
- [ ] Enable CloudTrail for audit logging

### High Availability
- [ ] Deploy to multiple regions
- [ ] Enable cross-region replication for DynamoDB
- [ ] Use Route 53 for failover
- [ ] Enable read replicas for DynamoDB

### Cost Optimization
- [ ] Use Reserved Instances for predictable workloads
- [ ] Use Spot Instances for non-critical tasks
- [ ] Set up AWS Budgets for cost alerts
- [ ] Enable DynamoDB autoscaling
- [ ] Use CloudFront for static content

### Compliance
- [ ] Enable encryption at rest
- [ ] Enable VPC Flow Logs
- [ ] Enable GuardDuty for threat detection
- [ ] Set up CloudWatch Alarms
- [ ] Enable Config for compliance monitoring

## Troubleshooting

### Bootstrap Error
```
Error: Need to perform a one-time bootstrap of your environment
```

**Solution:**
```bash
cdk bootstrap aws://ACCOUNT-ID/us-east-1
```

### Lambda Code Not Found
```
Error: code object cannot be null
```

**Solution:** Ensure Lambda code directories exist:
```bash
mkdir -p ../lambda/sign_in
mkdir -p ../lambda/sign_up
mkdir -p ../lambda/refresh_token
touch ../lambda/sign_in/index.js
touch ../lambda/sign_up/index.js
touch ../lambda/refresh_token/index.js
```

### Insufficient ECS Capacity
Reduce desired count or increase max capacity in EcsStack.

### DynamoDB Throttling
Switch to provisioned mode or increase on-demand limits in AWS Console.

## Next Steps

1. **Deploy the infrastructure**
   ```bash
   ./deploy.sh
   ```

2. **Build and push container image**
   ```bash
   docker build -t myapp:latest ..
   aws ecr create-repository --repository-name riftbound-online
   docker tag myapp:latest ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/riftbound-online:latest
   docker push ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/riftbound-online:latest
   ```

3. **Update container image in deployment**
   ```bash
   CONTAINER_IMAGE=ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/riftbound-online:latest ./deploy.sh
   ```

4. **Test authentication API**
   ```bash
   curl -X POST {API_ENDPOINT}/sign-up \
     -H "Content-Type: application/json" \
     -d '{...}'
   ```

5. **Monitor in CloudWatch**
   - Check logs: `/ecs/riftbound-dev`
   - View metrics: CloudWatch > Dashboards

## Resources

- [AWS CDK Documentation](https://docs.aws.amazon.com/cdk/)
- [AWS CDK API Reference](https://docs.aws.amazon.com/cdk/api/latest/)
- [CDK Examples](https://github.com/aws-samples/aws-cdk-examples)
- [Cognito Documentation](https://docs.aws.amazon.com/cognito/)
- [ECS Documentation](https://docs.aws.amazon.com/ecs/)
- [DynamoDB Documentation](https://docs.aws.amazon.com/dynamodb/)

## Support

For issues:
1. Check CloudWatch logs
2. Review CDK outputs
3. Check AWS Console
4. Consult AWS documentation

## License

ISC
