import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
export interface EcsStackProps extends cdk.StackProps {
    readonly environment: string;
    readonly vpc: ec2.Vpc;
    readonly albSecurityGroup: ec2.SecurityGroup;
    readonly ecsSecurityGroup: ec2.SecurityGroup;
    readonly usersTable: dynamodb.Table;
    readonly matchHistoryTable: dynamodb.Table;
    readonly decklistsTable: dynamodb.Table;
    readonly matchmakingQueueTable: dynamodb.Table;
    readonly rankedMatchmakingQueue: sqs.IQueue;
    readonly quickPlayMatchmakingQueue: sqs.IQueue;
    readonly userPoolArn?: string;
    readonly containerImage?: string;
    readonly desiredCount?: number;
    readonly taskCpu?: string;
    readonly taskMemory?: string;
}
export declare class EcsStack extends cdk.Stack {
    readonly cluster: ecs.Cluster;
    readonly loadBalancer: elbv2.ApplicationLoadBalancer;
    readonly service: ecs.Ec2Service | ecs.FargateService;
    constructor(scope: Construct, id: string, props: EcsStackProps);
}
//# sourceMappingURL=ecs-stack.d.ts.map