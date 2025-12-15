import * as cdk from 'aws-cdk-lib';
import { AuthStack } from './auth-stack';
import { DatabaseStack } from './database-stack';
import { NetworkingStack } from './networking-stack';
import { EcsStack } from './ecs-stack';
import { MatchServiceStack } from './match-service-stack';

const app = new cdk.App();

const environment = process.env.ENVIRONMENT || 'dev';
const containerImage = process.env.CONTAINER_IMAGE;
const matchServiceImage =
  process.env.MATCH_SERVICE_IMAGE || containerImage || 'nginx:latest';
const desiredCount = parseInt(process.env.DESIRED_COUNT || '2');
const taskCpu = process.env.TASK_CPU || '1024';
const taskMemory = process.env.TASK_MEMORY || '2048';

// Create stacks
const networkingStack = new NetworkingStack(app, `RiftboundNetworking-${environment}`, {
  environment,
  description: `Networking infrastructure for Riftbound Online ${environment}`,
});

const databaseStack = new DatabaseStack(app, `RiftboundDatabase-${environment}`, {
  environment,
  description: `Database infrastructure for Riftbound Online ${environment}`,
});

new AuthStack(app, `RiftboundAuth-${environment}`, {
  environment,
  description: `Authentication infrastructure for Riftbound Online ${environment}`,
});
const ecsStack = new EcsStack(app, `RiftboundEcs-${environment}`, {
  environment,
  vpc: networkingStack.vpc,
  albSecurityGroup: networkingStack.albSecurityGroup,
  ecsSecurityGroup: networkingStack.ecsSecurityGroup,
  usersTable: databaseStack.usersTable,
  matchHistoryTable: databaseStack.matchHistoryTable,
  decklistsTable: databaseStack.decklistsTable,
  matchmakingQueueTable: databaseStack.matchmakingQueueTable,
  containerImage,
  desiredCount,
  taskCpu,
  taskMemory,
  description: `ECS infrastructure for Riftbound Online ${environment}`,
});

// Match Service Stack - One task per match
const matchServiceStack = new MatchServiceStack(
  app,
  `RiftboundMatchService-${environment}`,
  {
    vpc: networkingStack.vpc,
    matchTableArn: databaseStack.matchHistoryTable.tableArn,
    stateTableArn: databaseStack.matchHistoryTable.tableArn,
    containerImage: matchServiceImage,
    description: `Match Service infrastructure for Riftbound Online ${environment}`
  }
);

// Add dependencies
ecsStack.addDependency(networkingStack);
ecsStack.addDependency(databaseStack);
matchServiceStack.addDependency(networkingStack);
matchServiceStack.addDependency(databaseStack);

app.synth();
