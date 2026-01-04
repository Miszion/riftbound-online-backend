import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
export interface MatchQueueStackProps extends cdk.StackProps {
    readonly environment: string;
}
export declare class MatchQueueStack extends cdk.Stack {
    readonly rankedQueue: sqs.Queue;
    readonly quickPlayQueue: sqs.Queue;
    constructor(scope: Construct, id: string, props: MatchQueueStackProps);
}
//# sourceMappingURL=queues-stack.d.ts.map