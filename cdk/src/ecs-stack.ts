import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface EcsStackProps extends cdk.StackProps {
  readonly environment: string;
  readonly vpc: ec2.Vpc;
  readonly albSecurityGroup: ec2.SecurityGroup;
  readonly ecsSecurityGroup: ec2.SecurityGroup;
  readonly usersTable: dynamodb.Table;
  readonly matchHistoryTable: dynamodb.Table;
  readonly containerImage: string;
  readonly desiredCount?: number;
  readonly taskCpu?: string;
  readonly taskMemory?: string;
}

export class EcsStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  public readonly service: ecs.Ec2Service | ecs.FargateService;

  constructor(scope: Construct, id: string, props: EcsStackProps) {
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

    // Create ECS Task Role
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // Add DynamoDB permissions
    props.usersTable.grantReadWriteData(taskRole);
    props.matchHistoryTable.grantReadWriteData(taskRole);

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

    // Add container to task definition
    const container = taskDefinition.addContainer('AppContainer', {
      image: ecs.ContainerImage.fromRegistry(props.containerImage),
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: 'ecs',
        logGroup: logGroup,
      }),
      environment: {
        ENVIRONMENT: props.environment,
        USERS_TABLE: props.usersTable.tableName,
        MATCH_HISTORY_TABLE: props.matchHistoryTable.tableName,
        AWS_REGION: this.region,
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
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(3),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
      },
    });

    // Add listener
    this.loadBalancer.addListener('Listener', {
      port: 80,
      defaultTargetGroups: [targetGroup],
      protocol: elbv2.ApplicationProtocol.HTTP,
    });

    // Create Fargate Service
    this.service = new ecs.FargateService(this, 'Service', {
      serviceName: `riftbound-${props.environment}-service`,
      cluster: this.cluster,
      taskDefinition: taskDefinition,
      desiredCount: desiredCount,
      assignPublicIp: false,
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
  }
}
