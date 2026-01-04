import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
export interface ApiGatewayStackProps extends cdk.StackProps {
    readonly environment: string;
    readonly loadBalancerDnsName: string;
    readonly allowedOrigins: string[];
}
export declare class ApiGatewayStack extends cdk.Stack {
    readonly apiUrl: string;
    constructor(scope: Construct, id: string, props: ApiGatewayStackProps);
}
//# sourceMappingURL=api-gateway-stack.d.ts.map