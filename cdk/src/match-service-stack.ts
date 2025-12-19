import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface MatchServiceStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  matchTableArn: string;
  stateTableArn: string;
  containerImage: string;
}

/**
 * ECS Stack for Riftbound Match Service
 * 
 * Spins up a task per match that:
 * - Maintains game state in memory
 * - Enforces Riftbound TCG rules
 * - Handles all game logic
 * - Saves state snapshots to DynamoDB
 * - Terminates gracefully when match ends
 */
export class MatchServiceStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly taskDefinition: ecs.TaskDefinition;
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  public readonly matchTable: dynamodb.Table;
  public readonly stateTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: MatchServiceStackProps) {
    super(scope, id, props);

    const environment = this.node.tryGetContext('environment') || 'dev';

    // ========================================================================
    // CREATE DYNAMODB TABLES FOR MATCH SERVICE
    // ========================================================================

    // Table to store completed match results
    this.matchTable = new dynamodb.Table(this, 'MatchHistoryTable', {
      tableName: `riftbound-online-matches-${environment}`,
      partitionKey: { name: 'MatchId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });

    // GSI: Query matches by winner
    this.matchTable.addGlobalSecondaryIndex({
      indexName: 'WinnerIndex',
      partitionKey: { name: 'Winner', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'CreatedAt', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL
    });

    // Table to store in-progress game state snapshots
    this.stateTable = new dynamodb.Table(this, 'MatchStateTable', {
      tableName: `riftbound-online-match-states-${environment}`,
      partitionKey: { name: 'MatchId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ExpiresAt', // Auto-delete old states after match ends
      removalPolicy: cdk.RemovalPolicy.RETAIN
    });

    // ========================================================================
    // ECS CLUSTER
    // ========================================================================

    this.cluster = new ecs.Cluster(this, 'MatchServiceCluster', {
      clusterName: `riftbound-match-service-${environment}`,
      vpc: props.vpc,
      containerInsights: true
    });

    // ========================================================================
    // TASK DEFINITION
    // ========================================================================

    this.taskDefinition = new ecs.TaskDefinition(this, 'MatchServiceTaskDef', {
      compatibility: ecs.Compatibility.FARGATE,
      cpu: '512', // 0.5 CPU - small task
      memoryMiB: '1024', // 1GB memory per match
      family: `riftbound-match-service-${environment}`
    });

    // ========================================================================
    // CONTAINER & LOGGING
    // ========================================================================

    const logGroup = new logs.LogGroup(this, 'MatchServiceLogGroup', {
      logGroupName: `/ecs/riftbound-match-service-${environment}`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      retention: logs.RetentionDays.TWO_WEEKS
    });

    const container = this.taskDefinition.addContainer('match-service', {
      image: ecs.ContainerImage.fromRegistry(props.containerImage),
      memoryLimitMiB: 1024,
      cpu: 512,
      command: ['node', 'dist/match-service.js'],
      logging: ecs.LogDriver.awsLogs({
        logGroup,
        streamPrefix: 'match-service'
      }),
      environment: {
        PORT: '4000',
        LOG_LEVEL: 'info',
        ENVIRONMENT: environment,
        MATCH_TABLE: `riftbound-online-matches-${environment}`,
        STATE_TABLE: `riftbound-online-match-states-${environment}`,
        AWS_REGION: this.region
      },
      portMappings: [
        {
          containerPort: 4000,
          protocol: ecs.Protocol.TCP
        }
      ]
    });

    // ========================================================================
    // IAM PERMISSIONS
    // ========================================================================

    const taskRole = this.taskDefinition.taskRole;
    if (taskRole) {
      // DynamoDB permissions for saving match results and state snapshots
      taskRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:Query'],
          resources: [
            this.matchTable.tableArn,
            `${this.matchTable.tableArn}/index/*`,
            this.stateTable.tableArn,
            `${this.stateTable.tableArn}/index/*`
          ]
        })
      );

      // CloudWatch Logs
      taskRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: [
            'logs:CreateLogStream',
            'logs:PutLogEvents',
            'logs:CreateLogGroup'
          ],
          resources: [logGroup.logGroupArn]
        })
      );
    }

    const executionRole = this.taskDefinition.executionRole;
    if (executionRole) {
      executionRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          actions: [
            'ecr:GetAuthorizationToken',
            'ecr:BatchCheckLayerAvailability',
            'ecr:GetDownloadUrlForLayer',
            'ecr:BatchGetImage'
          ],
          resources: ['*']
        })
      );
    }

    // ========================================================================
    // LOAD BALANCER
    // ========================================================================

    this.loadBalancer = new elbv2.ApplicationLoadBalancer(
      this,
      'MatchServiceALB',
      {
        vpc: props.vpc,
        internetFacing: false, // Internal only - main server calls this
        loadBalancerName: `riftbound-match-service-${environment}`
      }
    );

    const targetGroup = new elbv2.ApplicationTargetGroup(
      this,
      'MatchServiceTargetGroup',
      {
        vpc: props.vpc,
        targetType: elbv2.TargetType.IP,
        port: 4000,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targetGroupName: `riftbound-match-service-${environment}`,
        healthCheck: {
          path: '/health',
          interval: cdk.Duration.seconds(300),
          timeout: cdk.Duration.seconds(10),
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 5
        },
        deregistrationDelay: cdk.Duration.seconds(30) // Quick cleanup when match ends
      }
    );

    this.loadBalancer.addListener('MatchServiceListener', {
      port: 80,
      defaultTargetGroups: [targetGroup]
    });

    // ========================================================================
    // ECS SERVICE - ONE TASK PER MATCH
    // ========================================================================

    const service = new ecs.FargateService(this, 'MatchService', {
      cluster: this.cluster,
      taskDefinition: this.taskDefinition,
      desiredCount: 1, // Keep at least one listener ready for init requests
      serviceName: `riftbound-match-service-${environment}`,
      vpcSubnets: {
        subnets: props.vpc.privateSubnets
      },
      assignPublicIp: false
    });

    // Register with ALB
    service.attachToApplicationTargetGroup(targetGroup);

    // ========================================================================
    // AUTO SCALING POLICY
    // ========================================================================

    const scaling = service.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 100 // Max 100 concurrent matches
    });

    // Scale based on CPU utilization (matches use CPU during calculation)
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70
    });

    // ========================================================================
    // OUTPUTS
    // ========================================================================

    new cdk.CfnOutput(this, 'MatchServiceLoadBalancerDNS', {
      description: 'Match Service Load Balancer DNS',
      value: this.loadBalancer.loadBalancerDnsName,
      exportName: `riftbound-match-service-alb-${environment}`
    });

    new cdk.CfnOutput(this, 'MatchServiceClusterName', {
      description: 'ECS Cluster Name',
      value: this.cluster.clusterName,
      exportName: `riftbound-match-service-cluster-${environment}`
    });

    new cdk.CfnOutput(this, 'MatchTableName', {
      description: 'Match History Table Name',
      value: this.matchTable.tableName,
      exportName: `riftbound-match-table-${environment}`
    });

    new cdk.CfnOutput(this, 'StateTableName', {
      description: 'Match State Table Name',
      value: this.stateTable.tableName,
      exportName: `riftbound-state-table-${environment}`
    });
  }
}
