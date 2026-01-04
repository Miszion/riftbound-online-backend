"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EcsStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const ecs = __importStar(require("aws-cdk-lib/aws-ecs"));
const elbv2 = __importStar(require("aws-cdk-lib/aws-elasticloadbalancingv2"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const dynamodb = __importStar(require("aws-cdk-lib/aws-dynamodb"));
const ecr = __importStar(require("aws-cdk-lib/aws-ecr"));
class EcsStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        const desiredCount = props.desiredCount || 2;
        const taskCpu = props.taskCpu || '1024';
        const taskMemory = props.taskMemory || '2048';
        // Create ECS Cluster
        this.cluster = new ecs.Cluster(this, 'Cluster', {
            clusterName: `riftbound-${props.environment}-cluster`,
            vpc: props.vpc,
            containerInsights: true,
        });
        // Create CloudWatch Log Group
        const logGroup = new logs.LogGroup(this, 'LogGroup', {
            logGroupName: `/ecs/riftbound-${props.environment}`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        let appRepository;
        if (!props.containerImage) {
            appRepository = ecr.Repository.fromRepositoryName(this, 'AppRepository', `riftbound-${props.environment}-app`);
        }
        // Create ECS Task Role
        const taskRole = new iam.Role(this, 'TaskRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        });
        // Add DynamoDB permissions
        props.usersTable.grantReadWriteData(taskRole);
        props.matchHistoryTable.grantReadWriteData(taskRole);
        props.decklistsTable.grantReadWriteData(taskRole);
        props.matchmakingQueueTable.grantReadWriteData(taskRole);
        props.rankedMatchmakingQueue.grantConsumeMessages(taskRole);
        props.quickPlayMatchmakingQueue.grantConsumeMessages(taskRole);
        props.rankedMatchmakingQueue.grantSendMessages(taskRole);
        props.quickPlayMatchmakingQueue.grantSendMessages(taskRole);
        const matchStateTableName = `riftbound-online-match-states-${props.environment}`;
        const matchStateTable = dynamodb.Table.fromTableName(this, 'MatchStateTableRef', matchStateTableName);
        matchStateTable.grantReadWriteData(taskRole);
        if (props.userPoolArn) {
            taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    'cognito-idp:AdminInitiateAuth',
                    'cognito-idp:AdminConfirmSignUp',
                    'cognito-idp:SignUp',
                    'cognito-idp:InitiateAuth'
                ],
                resources: [props.userPoolArn]
            }));
        }
        // Create Task Execution Role
        const executionRole = new iam.Role(this, 'ExecutionRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
            ],
        });
        // Add CloudWatch Logs permissions
        logGroup.grantWrite(executionRole);
        // Create Fargate Task Definition
        const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
            family: `riftbound-${props.environment}-task`,
            cpu: parseInt(taskCpu),
            memoryLimitMiB: parseInt(taskMemory),
            taskRole,
            executionRole,
        });
        const containerImage = props.containerImage
            ? ecs.ContainerImage.fromRegistry(props.containerImage)
            : appRepository
                ? ecs.ContainerImage.fromEcrRepository(appRepository)
                : (() => {
                    throw new Error('ECR repository not available and containerImage not provided');
                })();
        // Allow ECS tasks to pull from repository
        if (appRepository) {
            appRepository.grantPull(executionRole);
        }
        // Add container to task definition
        const container = taskDefinition.addContainer('AppContainer', {
            image: containerImage,
            logging: ecs.LogDriver.awsLogs({
                streamPrefix: 'ecs',
                logGroup: logGroup,
            }),
            environment: {
                ENVIRONMENT: props.environment,
                USERS_TABLE: props.usersTable.tableName,
                MATCH_HISTORY_TABLE: props.matchHistoryTable.tableName,
                STATE_TABLE: matchStateTableName,
                MATCH_TABLE: props.matchHistoryTable.tableName,
                DECKLISTS_TABLE: props.decklistsTable.tableName,
                MATCHMAKING_QUEUE_TABLE: props.matchmakingQueueTable.tableName,
                AWS_REGION: this.region,
                REDEPLOY_TOKEN: process.env.REDEPLOY_TOKEN ?? '',
                MATCHMAKING_RANKED_QUEUE_URL: props.rankedMatchmakingQueue.queueUrl,
                MATCHMAKING_RANKED_QUEUE_ARN: props.rankedMatchmakingQueue.queueArn,
                MATCHMAKING_FREE_QUEUE_URL: props.quickPlayMatchmakingQueue.queueUrl,
                MATCHMAKING_FREE_QUEUE_ARN: props.quickPlayMatchmakingQueue.queueArn,
            },
            portMappings: [
                {
                    containerPort: 3000,
                    protocol: ecs.Protocol.TCP,
                },
            ],
        });
        // Create Application Load Balancer
        this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
            vpc: props.vpc,
            internetFacing: true,
            loadBalancerName: `riftbound-${props.environment}-alb`,
            securityGroup: props.albSecurityGroup,
        });
        // Create target group
        const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
            vpc: props.vpc,
            port: 3000,
            targetType: elbv2.TargetType.IP,
            protocol: elbv2.ApplicationProtocol.HTTP,
            healthCheck: {
                path: '/health',
                healthyHttpCodes: '200',
                interval: cdk.Duration.seconds(300),
                timeout: cdk.Duration.seconds(5),
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 5,
            },
        });
        // Add listener
        this.loadBalancer.addListener('Listener', {
            port: 80,
            defaultTargetGroups: [targetGroup],
            protocol: elbv2.ApplicationProtocol.HTTP,
        });
        // Create Fargate Service
        const enableExecuteCommand = props.environment === 'dev';
        this.service = new ecs.FargateService(this, 'Service', {
            serviceName: `riftbound-${props.environment}-service`,
            cluster: this.cluster,
            taskDefinition: taskDefinition,
            desiredCount: desiredCount,
            assignPublicIp: false,
            enableExecuteCommand,
            vpcSubnets: {
                subnets: props.vpc.privateSubnets,
            },
            securityGroups: [props.ecsSecurityGroup],
        });
        // Add target group to service
        this.service.attachToApplicationTargetGroup(targetGroup);
        // Setup auto-scaling
        const scaling = this.service.autoScaleTaskCount({
            minCapacity: 2,
            maxCapacity: 4,
        });
        // Scale on CPU utilization
        scaling.scaleOnCpuUtilization('CpuScaling', {
            targetUtilizationPercent: 70,
        });
        // Scale on memory utilization
        scaling.scaleOnMemoryUtilization('MemoryScaling', {
            targetUtilizationPercent: 80,
        });
        // Outputs
        new cdk.CfnOutput(this, 'LoadBalancerDns', {
            value: this.loadBalancer.loadBalancerDnsName,
            exportName: `riftbound-${props.environment}-alb-dns`,
        });
        new cdk.CfnOutput(this, 'ClusterName', {
            value: this.cluster.clusterName,
            exportName: `riftbound-${props.environment}-cluster-name`,
        });
        new cdk.CfnOutput(this, 'ServiceName', {
            value: this.service.serviceName,
            exportName: `riftbound-${props.environment}-service-name`,
        });
        if (appRepository) {
            new cdk.CfnOutput(this, 'AppRepositoryUri', {
                value: appRepository.repositoryUri,
                exportName: `riftbound-${props.environment}-ecr-repo-uri`,
            });
        }
    }
}
exports.EcsStack = EcsStack;
//# sourceMappingURL=ecs-stack.js.map