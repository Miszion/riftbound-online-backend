# Quick Start Guide - Riftbound Online Backend

Get your backend running in 5 minutes.

## Prerequisites

- **AWS Account** (with billing enabled)
- **Node.js 18+** ([download](https://nodejs.org/))
- **AWS CLI** (`brew install awscli` on macOS)
- **Docker** (optional, for building containers)

## Step 1: Configure AWS

```bash
# Configure credentials
aws configure

# You'll be prompted for:
# - AWS Access Key ID: [your_key]
# - AWS Secret Access Key: [your_secret]
# - Default region: us-east-1
# - Default output format: json
```

## Step 2: Bootstrap CDK

One-time setup for AWS CDK:

```bash
# Replace ACCOUNT-ID with your AWS account ID
aws sts get-caller-identity  # To find your account ID

cdk bootstrap aws://ACCOUNT-ID/us-east-1
```

## Step 3: Clone and Setup

```bash
# Clone repository
git clone https://github.com/Miszion/riftbound-online-backend.git
cd riftbound-online-backend

# Navigate to CDK directory
cd cdk

# Install Node dependencies
npm install

# Verify everything works
npm run build
```

## Step 4: Deploy Infrastructure

```bash
# Deploy to AWS (this takes 10-15 minutes)
./deploy.sh

# Or without the script:
ENVIRONMENT=dev npm run deploy
```

Watch the output for stack creation:
```
✅ RiftboundNetworking-dev (Ready)
✅ RiftboundDatabase-dev (Ready)
✅ RiftboundAuth-dev (Ready)
✅ RiftboundEcs-dev (Ready)
```

## Step 5: Get Your Endpoints

After deployment, you'll see outputs. Save these:

```bash
# View all outputs
cdk list

# Or in CloudFormation console:
# AWS CloudFormation > Stacks > RiftboundAuth-dev > Outputs
```

You'll get:
- **Auth API Endpoint**: `https://xxxxx.execute-api.us-east-1.amazonaws.com/dev/`
- **Game API Endpoint**: `http://alb-xxxxx.elb.us-east-1.amazonaws.com/`

## Step 6: Test Sign-Up

```bash
# Sign up a user
curl -X POST {AUTH_API_ENDPOINT}/sign-up \
  -H "Content-Type: application/json" \
  -d '{
    "email": "testuser@example.com",
    "password": "TestPass123!",
    "username": "testuser"
  }'

# Response:
# {
#   "message": "User signed up successfully",
#   "userId": "550e8400-e29b-41d4-a716-446655440000"
# }
```

## Step 7: Test Sign-In

```bash
# Sign in
curl -X POST {AUTH_API_ENDPOINT}/sign-in \
  -H "Content-Type: application/json" \
  -d '{
    "email": "testuser@example.com",
    "password": "TestPass123!"
  }'

# Response:
# {
#   "idToken": "eyJhbGc...",
#   "accessToken": "eyJhbGc...",
#   "refreshToken": "abc123...",
#   "expiresIn": 3600
# }
```

Copy the `accessToken` for next step.

## Step 8: Test Game API

```bash
# Get leaderboard (public endpoint)
curl {GAME_API_ENDPOINT}/api/leaderboard?limit=10

# Create a match (requires token)
curl -X POST {GAME_API_ENDPOINT}/api/matches \
  -H "Authorization: Bearer {accessToken}" \
  -H "Content-Type: application/json" \
  -d '{
    "players": ["testuser", "otheruser"],
    "winner": "testuser",
    "duration": 600
  }'
```

## Common Next Steps

### Update Container Image

When you have your own game server Docker image:

```bash
# Build and push to ECR
docker build -t myapp:latest ..
aws ecr create-repository --repository-name riftbound-online

# Tag and push
docker tag myapp:latest ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/riftbound-online:latest
docker push ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/riftbound-online:latest

# Redeploy with new image
ENVIRONMENT=dev \
  CONTAINER_IMAGE=ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/riftbound-online:latest \
  ./deploy.sh
```

### Enable HTTPS (Production)

```bash
# Create or import ACM certificate
# Then update EcsStack to add HTTPS listener

# For now, test with HTTP
```

### View Logs

```bash
# Real-time ECS logs
aws logs tail /ecs/riftbound-dev --follow

# Query logs
aws logs filter-log-events \
  --log-group-name /ecs/riftbound-dev \
  --start-time $(date -d '10 minutes ago' +%s)000
```

### Scale Up

```bash
# Deploy with more resources
ENVIRONMENT=dev \
  DESIRED_COUNT=4 \
  TASK_CPU=2048 \
  TASK_MEMORY=4096 \
  ./deploy.sh
```

### Cleanup

```bash
# Destroy all resources (careful!)
./cleanup.sh
```

## Troubleshooting

### "Need to perform a one-time bootstrap"
```bash
cdk bootstrap aws://ACCOUNT-ID/us-east-1
```

### "Stack creation failed"
```bash
# Check CloudFormation console for details
# or view stack events:
aws cloudformation describe-stack-events \
  --stack-name RiftboundAuth-dev
```

### "ECS tasks not running"
```bash
# Check service status
aws ecs describe-services \
  --cluster riftbound-dev-cluster \
  --services riftbound-dev-service

# View task logs
aws logs tail /ecs/riftbound-dev --follow
```

## Estimated Costs

Running this for a month costs approximately:
- **$90-120 USD** for dev environment
- **$200-500 USD** for production environment

See [cdk/README.md](../cdk/README.md) for detailed cost breakdown.

## Next Steps

1. ✅ Infrastructure deployed
2. ⏭️ Update `../src/server.js` with your game logic
3. ⏭️ Build Docker image with your app
4. ⏭️ Push to ECR and update deployment
5. ⏭️ Monitor in CloudWatch
6. ⏭️ Scale as needed

## Help

For more details:
- See [cdk/README.md](../cdk/README.md) for detailed documentation
- See [../CDK_README.md](../CDK_README.md) for overview
- Check AWS CloudFormation console for stack details
- View CloudWatch Logs for application logs

---

**You're all set!** Your Riftbound Online backend is running. 🚀
