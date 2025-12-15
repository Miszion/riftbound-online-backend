import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface DatabaseStackProps extends cdk.StackProps {
  readonly environment: string;
}

export class DatabaseStack extends cdk.Stack {
  public readonly usersTable: dynamodb.Table;
  public readonly matchHistoryTable: dynamodb.Table;
  public readonly cardCatalogTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    // Users table
    this.usersTable = new dynamodb.Table(this, 'UsersTable', {
      tableName: `riftbound-${props.environment}-users`,
      partitionKey: {
        name: 'UserId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Change for production
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });

    // Global Secondary Indexes for Users table
    this.usersTable.addGlobalSecondaryIndex({
      indexName: 'EmailIndex',
      partitionKey: {
        name: 'Email',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.usersTable.addGlobalSecondaryIndex({
      indexName: 'UsernameIndex',
      partitionKey: {
        name: 'Username',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Match History table
    this.matchHistoryTable = new dynamodb.Table(this, 'MatchHistoryTable', {
      tableName: `riftbound-${props.environment}-match-history`,
      partitionKey: {
        name: 'MatchId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'Timestamp',
        type: dynamodb.AttributeType.NUMBER,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Change for production
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });

    // Global Secondary Index for user match history
    this.matchHistoryTable.addGlobalSecondaryIndex({
      indexName: 'UserIdIndex',
      partitionKey: {
        name: 'UserId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'CreatedAt',
        type: dynamodb.AttributeType.NUMBER,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Card catalog table
    this.cardCatalogTable = new dynamodb.Table(this, 'CardCatalogTable', {
      tableName: `riftbound-${props.environment}-card-catalog`,
      partitionKey: {
        name: 'CardSlug',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'CardId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      timeToLiveAttribute: 'ArchivedAt',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.cardCatalogTable.addGlobalSecondaryIndex({
      indexName: 'CardTypeIndex',
      partitionKey: {
        name: 'CardType',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'CardRarity',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.cardCatalogTable.addGlobalSecondaryIndex({
      indexName: 'CardDomainIndex',
      partitionKey: {
        name: 'PrimaryDomain',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'CardSlug',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    
    // Outputs
    new cdk.CfnOutput(this, 'UsersTableName', {
      value: this.usersTable.tableName,
      exportName: `riftbound-${props.environment}-users-table`,
    });

    new cdk.CfnOutput(this, 'MatchHistoryTableName', {
      value: this.matchHistoryTable.tableName,
      exportName: `riftbound-${props.environment}-match-history-table`,
    });

    new cdk.CfnOutput(this, 'CardCatalogTableName', {
      value: this.cardCatalogTable.tableName,
      exportName: `riftbound-${props.environment}-card-catalog-table`,
    });
  }
}
