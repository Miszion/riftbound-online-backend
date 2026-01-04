import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
export interface NetworkingStackProps extends cdk.StackProps {
    readonly environment: string;
}
export declare class NetworkingStack extends cdk.Stack {
    readonly vpc: ec2.Vpc;
    readonly albSecurityGroup: ec2.SecurityGroup;
    readonly ecsSecurityGroup: ec2.SecurityGroup;
    constructor(scope: Construct, id: string, props: NetworkingStackProps);
}
//# sourceMappingURL=networking-stack.d.ts.map