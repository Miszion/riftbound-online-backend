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
exports.MatchQueueStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const sqs = __importStar(require("aws-cdk-lib/aws-sqs"));
class MatchQueueStack extends cdk.Stack {
    constructor(scope, id, props) {
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
exports.MatchQueueStack = MatchQueueStack;
//# sourceMappingURL=queues-stack.js.map