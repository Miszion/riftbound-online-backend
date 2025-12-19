import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface MatchQueueStackProps extends cdk.StackProps {
  readonly environment: string;
}

export class MatchQueueStack extends cdk.Stack {
  public readonly rankedQueue: sqs.Queue;
  public readonly quickPlayQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: MatchQueueStackProps) {
    super(scope, id, props);

    this.rankedQueue = new sqs.Queue(this, 'RankedMatchmakingQueue', {
      queueName: `riftbound-${props.environment}-matchmaking-ranked`,
      visibilityTimeout: cdk.Duration.seconds(30),
      retentionPeriod: cdk.Duration.days(4)
    });

    this.quickPlayQueue = new sqs.Queue(this, 'QuickPlayMatchmakingQueue', {
      queueName: `riftbound-${props.environment}-matchmaking-quickplay`,
      visibilityTimeout: cdk.Duration.seconds(30),
      retentionPeriod: cdk.Duration.days(4)
    });

    new cdk.CfnOutput(this, 'RankedMatchmakingQueueUrl', {
      value: this.rankedQueue.queueUrl,
      exportName: `riftbound-${props.environment}-matchmaking-ranked-queue-url`,
    });

    new cdk.CfnOutput(this, 'QuickPlayMatchmakingQueueUrl', {
      value: this.quickPlayQueue.queueUrl,
      exportName: `riftbound-${props.environment}-matchmaking-quickplay-queue-url`,
    });
  }
}
