import AWS from 'aws-sdk';
import logger from './logger';
import { runMatchmakingSweep, MatchMode } from './graphql/resolvers';

const sqs = new AWS.SQS({
  region: process.env.AWS_REGION || 'us-east-1'
});

const QUEUE_POLL_DELAY_MS = 5000;
const LONG_POLL_SECONDS = 20;

type QueueConfig = {
  mode: MatchMode;
  url: string;
};

const allQueueConfigs: QueueConfig[] = [
  { mode: 'ranked', url: process.env.MATCHMAKING_RANKED_QUEUE_URL || '' },
  { mode: 'free', url: process.env.MATCHMAKING_FREE_QUEUE_URL || '' }
];

const shouldStartWorker = () => {
  if (process.env.MATCHMAKING_QUEUE_WORKER === 'false') {
    return false;
  }
  return true;
};

const pollQueue = ({ mode, url }: QueueConfig) => {
  const safeUrl = url.trim();
  if (!safeUrl) {
    logger.warn(`[MATCHMAKING/WORKER] Skipping ${mode} queue poller; no URL configured`);
    return;
  }

  const poll = async () => {
    try {
      const response = await sqs
        .receiveMessage({
          QueueUrl: safeUrl,
          MaxNumberOfMessages: 5,
          MessageAttributeNames: ['All'],
          WaitTimeSeconds: LONG_POLL_SECONDS
        })
        .promise();

      const messages = response.Messages ?? [];
      if (messages.length > 0) {
        logger.debug(
          `[MATCHMAKING/WORKER] Processing ${messages.length} event(s) from ${mode} queue`
        );
        try {
          await runMatchmakingSweep(mode);
        } catch (error) {
          logger.error(`[MATCHMAKING/WORKER] Failed matchmaking sweep for ${mode}`, error);
        }

        await Promise.all(
          messages.map((message) => {
            if (!message.ReceiptHandle) {
              return Promise.resolve();
            }
            return sqs
              .deleteMessage({
                QueueUrl: safeUrl,
                ReceiptHandle: message.ReceiptHandle
              })
              .promise()
              .catch((error) => {
                logger.warn('[MATCHMAKING/WORKER] Failed to delete SQS message', {
                  mode,
                  error
                });
              });
          })
        );
        setImmediate(poll);
        return;
      }
    } catch (error) {
      logger.error(`[MATCHMAKING/WORKER] Error polling ${mode} queue`, error);
    }

    setTimeout(poll, QUEUE_POLL_DELAY_MS);
  };

  poll();
};

export const startMatchmakingQueueWorker = () => {
  if (!shouldStartWorker()) {
    logger.info('[MATCHMAKING/WORKER] Disabled via environment variable');
    return;
  }

  allQueueConfigs.forEach((config) => {
    if (config.url) {
      pollQueue(config);
    } else {
      logger.warn(`[MATCHMAKING/WORKER] No queue URL configured for ${config.mode} mode`);
    }
  });
};
