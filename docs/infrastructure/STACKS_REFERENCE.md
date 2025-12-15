# CDK Stacks Reference

Quick reference for the 4 main stacks in your infrastructure.

## AuthStack

**Purpose**: Cognito authentication + Lambda auth endpoints

**Key Resources**:
```typescript
userPool              // Cognito User Pool
userPoolClient        // Cognito App Client
identityPool          // Cognito Identity Pool (for AWS SDK)
signInFunction        // Lambda: POST /sign-in
signUpFunction        // Lambda: POST /sign-up
refreshTokenFunction  // Lambda: POST /refresh-token
api                   // API Gateway REST API
```

**Environment Variables**:
- `COGNITO_USER_POOL_ID` - Passed to Lambda
- `COGNITO_CLIENT_ID` - Passed to Lambda

**Outputs**:
- `UserPoolId` - Cognito user pool ID
- `ClientId` - Cognito app client ID
- `ApiEndpoint` - API Gateway URL

**Modify**:
```typescript
// In auth-stack.ts
this.userPool.addAttribute({
  name: 'custom_field',
  required: true
});
```

## DatabaseStack

**Purpose**: DynamoDB tables for users and matches

**Key Resources**:
```typescript
usersTable           // Users table
matchHistoryTable    // Match history table
```

**Users Table Schema**:
```
PK: UserId (String)
GSI: Email
GSI: Username
TTL: ExpiresAt (90 days)
Stream: NEW_AND_OLD_IMAGES
PITR: Enabled
```

**Match History Table Schema**:
```
PK: MatchId (String)
SK: Timestamp (Number)
GSI: UserId + CreatedAt
TTL: ExpiresAt (180 days)
Stream: NEW_AND_OLD_IMAGES
PITR: Enabled
```

**Outputs**:
- `UsersTableName` - Table name
- `MatchHistoryTableName` - Table name

**Modify**:
```typescript
// In database-stack.ts
this.usersTable.addGlobalSecondaryIndex({
  indexName: 'CreatedAtIndex',
  partitionKey: { name: 'CreatedAt', type: AttributeType.NUMBER },
  projectionType: ProjectionType.ALL
});
```

## NetworkingStack

**Purpose**: VPC, subnets, NAT, security groups

**Key Resources**:
```typescript
vpc                  // VPC (10.0.0.0/16)
albSecurityGroup     // For load balancer
ecsSecurityGroup     // For ECS tasks
```

**VPC Structure**:
- **Public Subnets**: 10.0.1.0/24, 10.0.2.0/24
  - Contains NAT Gateways
  - Contains ALB
- **Private Subnets**: 10.0.10.0/24, 10.0.11.0/24
  - Contains ECS tasks
  - No direct internet (via NAT)

**Outputs**:
- `VpcId` - VPC ID
- `PrivateSubnets` - Comma-separated subnet IDs
- `AlbSecurityGroupId` - ALB security group
- `EcsSecurityGroupId` - ECS security group

**Modify**:
```typescript
// In networking-stack.ts
this.vpc = new ec2.Vpc(this, 'Vpc', {
  cidr: '10.0.0.0/16',
  maxAzs: 3,  // Add third AZ
  natGateways: 3
});
```

## EcsStack

**Purpose**: ECS Fargate cluster, ALB, auto-scaling

**Key Resources**:
```typescript
cluster              // ECS cluster
service              // Fargate service
loadBalancer         // Application Load Balancer
taskDefinition       // ECS task definition
logGroup             // CloudWatch logs
taskRole             // IAM role (DynamoDB access)
executionRole        // IAM role (ECR, CloudWatch)
```

**Configuration**:
- CPU: Configurable (256-4096)
- Memory: Configurable (512-30720)
- Desired Count: Configurable
- Min: 2 tasks, Max: 4 tasks
- Auto-scale on CPU (70%) and Memory (80%)

**Outputs**:
- `LoadBalancerDns` - ALB DNS name
- `ClusterName` - ECS cluster name
- `ServiceName` - ECS service name

**Modify**:
```typescript
// In ecs-stack.ts
// Scale policy
const scaling = this.service.autoScaleTaskCount({
  minCapacity: 2,
  maxCapacity: 10  // Increase max
});

// Port mapping
container.addPortMappings({
  containerPort: 3000,
  hostPort: 3000
});
```

## Stack Dependencies

```
NetworkingStack
    │
    └─> EcsStack
         │
         └─> DatabaseStack
              │
              └─> AuthStack
```

Deploy order:
1. NetworkingStack (VPC, security groups)
2. DatabaseStack (DynamoDB tables)
3. AuthStack (Cognito, Lambda, API)
4. EcsStack (ECS, ALB, auto-scaling)

## Common Modifications

### Add Custom Domain to API Gateway

```typescript
// In auth-stack.ts
new apigateway.DomainName(this, 'DomainName', {
  domainName: 'api.riftbound.example.com',
  certificate: acm.Certificate.fromCertificateArn(...),
  basePath: 'auth',
  endpoint: api
});
```

### Enable HTTPS on ALB

```typescript
// In ecs-stack.ts
this.loadBalancer.addListener('HttpsListener', {
  port: 443,
  protocol: elbv2.ApplicationProtocol.HTTPS,
  certificates: [acm.Certificate.fromCertificateArn(...)],
  defaultTargetGroups: [targetGroup]
});
```

### Add Lambda Layer

```typescript
// In auth-stack.ts
const layer = new lambda.LayerVersion(this, 'SharedLayer', {
  code: lambda.Code.fromAsset('../lambda/layers/shared'),
  compatibleRuntimes: [lambda.Runtime.NODEJS_18_X]
});

signInFunction.addLayers(layer);
```

### Enable CORS on API Gateway

```typescript
// In auth-stack.ts
const api = new apigateway.RestApi(this, 'AuthApi', {
  defaultCorsPreflightOptions: {
    allowOrigins: apigateway.Cors.ALL_ORIGINS,
    allowMethods: apigateway.Cors.ALL_METHODS,
    allowHeaders: apigateway.Cors.DEFAULT_HEADERS
  }
});
```

### Add CloudWatch Alarm

```typescript
// In ecs-stack.ts
new cloudwatch.Alarm(this, 'HighCpuAlarm', {
  metric: this.service.metricCpuUtilization(),
  threshold: 80,
  evaluationPeriods: 2,
  alarmName: 'ECS-HighCPU-Alarm'
});
```

### Grant DynamoDB Access to Lambda

```typescript
// In auth-stack.ts
props.usersTable.grantReadData(signInFunction);
props.usersTable.grantWriteData(signUpFunction);
```

## Environment Variables in Stacks

### AuthStack
```typescript
const userPoolId = this.userPool.userPoolId;
const clientId = this.userPoolClient.userPoolClientId;
```

### DatabaseStack
```typescript
const usersTableName = this.usersTable.tableName;
const usersTableArn = this.usersTable.tableArn;
```

### EcsStack
```typescript
const clusterName = this.cluster.clusterName;
const serviceName = this.service.serviceName;
const albDns = this.loadBalancer.loadBalancerDnsName;
```

## Exporting Values Between Stacks

**Exporting** (in a stack):
```typescript
new cdk.CfnOutput(this, 'UserPoolId', {
  value: this.userPool.userPoolId,
  exportName: 'riftbound-userpool-id'
});
```

**Importing** (in another stack):
```typescript
const userPoolId = cdk.Fn.importValue('riftbound-userpool-id');
```

## Useful CDK Constructs

```typescript
// AWS::Lambda
new lambda.Function(...)
new lambda.Code.fromAsset(path)
new lambda.Runtime.NODEJS_18_X

// AWS::DynamoDB
new dynamodb.Table(...)
new dynamodb.BillingMode.PAY_PER_REQUEST
new dynamodb.StreamSpecification.NEW_AND_OLD_IMAGES

// AWS::Cognito
new cognito.UserPool(...)
new cognito.Mfa.OPTIONAL

// AWS::ECS
new ecs.Cluster(...)
new ecs.FargateService(...)
new ecs.FargateTaskDefinition(...)

// AWS::ElasticLoadBalancingV2
new elbv2.ApplicationLoadBalancer(...)
new elbv2.ApplicationTargetGroup(...)

// AWS::ApiGateway
new apigateway.RestApi(...)
new apigateway.LambdaIntegration(...)

// AWS::EC2
new ec2.Vpc(...)
new ec2.SecurityGroup(...)

// AWS::IAM
new iam.Role(...)
new iam.PolicyStatement(...)

// AWS::Logs
new logs.LogGroup(...)

// AWS::CloudWatch
new cloudwatch.Alarm(...)
```

## CLI Commands by Stack

```bash
# List specific stack
cdk list RiftboundAuth-dev

# Synth specific stack
cdk synth RiftboundAuth-dev

# Diff specific stack
cdk diff RiftboundAuth-dev

# Deploy specific stack
cdk deploy RiftboundAuth-dev

# Destroy specific stack
cdk destroy RiftboundAuth-dev
```

## Testing Changes

```bash
# 1. Make changes to TypeScript
# 2. Build
npm run build

# 3. Review changes
npm run diff

# 4. Deploy
npm run deploy

# 5. Verify
cdk list
```

## Cleanup

```bash
# Destroy all stacks
cdk destroy --all

# Or destroy one at a time
cdk destroy RiftboundAuth-dev
cdk destroy RiftboundEcs-dev
cdk destroy RiftboundDatabase-dev
cdk destroy RiftboundNetworking-dev
```

---

For more details, see `cdk/README.md` or CDK documentation.
