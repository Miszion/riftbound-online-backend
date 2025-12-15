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
  public readonly decklistsTable: dynamodb.Table;
  public readonly matchmakingQueueTable: dynamodb.Table;

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

    // Decklists table
    this.decklistsTable = new dynamodb.Table(this, 'DecklistsTable', {
      tableName: `riftbound-${props.environment}-decklists`,
      partitionKey: {
        name: 'UserId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'DeckId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.decklistsTable.addGlobalSecondaryIndex({
      indexName: 'DeckIdIndex',
      partitionKey: {
        name: 'DeckId',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Matchmaking queue table
    this.matchmakingQueueTable = new dynamodb.Table(this, 'MatchmakingQueueTable', {
      tableName: `riftbound-${props.environment}-matchmaking-queue`,
      partitionKey: {
        name: 'Mode',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'UserId',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      timeToLiveAttribute: 'ExpiresAt',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
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

    new cdk.CfnOutput(this, 'DecklistsTableName', {
      value: this.decklistsTable.tableName,
      exportName: `riftbound-${props.environment}-decklists-table`,
    });

    new cdk.CfnOutput(this, 'MatchmakingQueueTableName', {
      value: this.matchmakingQueueTable.tableName,
      exportName: `riftbound-${props.environment}-matchmaking-queue-table`,
    });
  }
}
