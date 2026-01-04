"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const cdk = __importStar(require("aws-cdk-lib"));
const auth_stack_1 = require("./auth-stack");
const database_stack_1 = require("./database-stack");
const networking_stack_1 = require("./networking-stack");
const ecs_stack_1 = require("./ecs-stack");
const api_gateway_stack_1 = require("./api-gateway-stack");
const queues_stack_1 = require("./queues-stack");
const app = new cdk.App();
const environment = process.env.ENVIRONMENT || 'dev';
const containerImage = process.env.CONTAINER_IMAGE;
const desiredCount = parseInt(process.env.DESIRED_COUNT || '2');
const taskCpu = process.env.TASK_CPU || '1024';
const taskMemory = process.env.TASK_MEMORY || '2048';
const corsOrigins = (process.env.CORS_ORIGINS || '*')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
// Create stacks
const networkingStack = new networking_stack_1.NetworkingStack(app, `RiftboundNetworking-${environment}`, {
    environment,
    description: `Networking infrastructure for Riftbound Online ${environment}`,
});
const databaseStack = new database_stack_1.DatabaseStack(app, `RiftboundDatabase-${environment}`, {
    environment,
    description: `Database infrastructure for Riftbound Online ${environment}`,
});
const authStack = new auth_stack_1.AuthStack(app, `RiftboundAuth-${environment}`, {
    environment,
    description: `Authentication infrastructure for Riftbound Online ${environment}`,
});
const queueStack = new queues_stack_1.MatchQueueStack(app, `RiftboundQueues-${environment}`, {
    environment,
    description: `Matchmaking queues for Riftbound Online ${environment}`,
});
const ecsStack = new ecs_stack_1.EcsStack(app, `RiftboundEcs-${environment}`, {
    environment,
    vpc: networkingStack.vpc,
    albSecurityGroup: networkingStack.albSecurityGroup,
    ecsSecurityGroup: networkingStack.ecsSecurityGroup,
    usersTable: databaseStack.usersTable,
    matchHistoryTable: databaseStack.matchHistoryTable,
    decklistsTable: databaseStack.decklistsTable,
    matchmakingQueueTable: databaseStack.matchmakingQueueTable,
    rankedMatchmakingQueue: queueStack.rankedQueue,
    quickPlayMatchmakingQueue: queueStack.quickPlayQueue,
    userPoolArn: authStack.userPool.userPoolArn,
    containerImage,
    desiredCount,
    taskCpu,
    taskMemory,
    description: `ECS infrastructure for Riftbound Online ${environment}`,
});
const apiGatewayStack = new api_gateway_stack_1.ApiGatewayStack(app, `RiftboundApi-${environment}`, {
    environment,
    loadBalancerDnsName: ecsStack.loadBalancer.loadBalancerDnsName,
    allowedOrigins: corsOrigins,
    description: `Public API Gateway for Riftbound Online ${environment}`,
});
// Add dependencies
ecsStack.addDependency(networkingStack);
ecsStack.addDependency(databaseStack);
ecsStack.addDependency(queueStack);
queueStack.addDependency(networkingStack);
apiGatewayStack.addDependency(ecsStack);
app.synth();
//# sourceMappingURL=index.js.map