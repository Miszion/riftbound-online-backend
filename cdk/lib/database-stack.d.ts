import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
export interface DatabaseStackProps extends cdk.StackProps {
    readonly environment: string;
}
export declare class DatabaseStack extends cdk.Stack {
    readonly usersTable: dynamodb.Table;
    readonly matchHistoryTable: dynamodb.Table;
    readonly cardCatalogTable: dynamodb.Table;
    readonly decklistsTable: dynamodb.Table;
    readonly matchmakingQueueTable: dynamodb.Table;
    constructor(scope: Construct, id: string, props: DatabaseStackProps);
}
//# sourceMappingURL=database-stack.d.ts.map