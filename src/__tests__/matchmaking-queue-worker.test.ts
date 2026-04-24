/**
 * Matchmaking Queue Worker - Comprehensive Unit Tests
 *
 * Tests cover: startMatchmakingQueueWorker, shouldStartWorker (via export),
 * pollQueue behavior: no URL, no messages, messages received, error handling.
 */

// ---------------------------------------------------------------------------
// Mocks (hoisted by Jest)
// ---------------------------------------------------------------------------

jest.mock('../logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('../graphql/resolvers', () => ({
  __esModule: true,
  runMatchmakingSweep: jest.fn().mockResolvedValue(undefined),
  MatchMode: {},
}));

jest.mock('aws-sdk', () => {
  const receivePromise = jest.fn().mockResolvedValue({ Messages: [] });
  const deletePromise = jest.fn().mockResolvedValue({});

  const sqsInstance = {
    receiveMessage: jest.fn().mockReturnValue({ promise: receivePromise }),
    deleteMessage: jest.fn().mockReturnValue({ promise: deletePromise }),
  };

  const MockSQS = jest.fn().mockImplementation(() => sqsInstance);

  return {
    __esModule: true,
    default: {
      SQS: MockSQS,
      // Expose for test configuration
      _sqsInstance: sqsInstance,
      _receivePromise: receivePromise,
      _deletePromise: deletePromise,
    },
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import AWS from 'aws-sdk';
import logger from '../logger';
import { runMatchmakingSweep } from '../graphql/resolvers';

// ---------------------------------------------------------------------------
// Mock accessors (typed for convenience)
// ---------------------------------------------------------------------------

const awsMock = AWS as any;
const mockSqsInstance = awsMock._sqsInstance as {
  receiveMessage: jest.Mock;
  deleteMessage: jest.Mock;
};
const mockReceivePromise = awsMock._receivePromise as jest.Mock;
const mockDeletePromise = awsMock._deletePromise as jest.Mock;
const mockLogger = logger as unknown as {
  info: jest.Mock;
  warn: jest.Mock;
  debug: jest.Mock;
  error: jest.Mock;
};
const mockRunMatchmakingSweep = runMatchmakingSweep as jest.Mock;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RANKED_URL = 'https://sqs.us-east-1.amazonaws.com/123456789/ranked-queue';
const FREE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789/free-queue';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Flush pending Promise microtasks. Works even with fake timers because
 * Promise microtasks are not affected by Jest's timer replacement.
 */
async function flushPromises(cycles = 10): Promise<void> {
  for (let i = 0; i < cycles; i++) {
    await Promise.resolve();
  }
}

/**
 * Load the worker module in isolation with specific env vars.
 * Sets env vars before module load and keeps them set until afterEach cleanup.
 * This is necessary because shouldStartWorker() reads process.env at call time.
 */
function loadWorker(
  env: Record<string, string | undefined> = {}
): { startMatchmakingQueueWorker: () => void } {
  // Apply env overrides — cleanup is handled by afterEach
  Object.entries(env).forEach(([k, v]) => {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  });

  let mod: any;
  jest.isolateModules(() => {
    mod = require('../matchmaking-queue-worker');
  });

  return mod;
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('matchmaking-queue-worker', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    // Re-establish default implementations after clearAllMocks
    mockReceivePromise.mockResolvedValue({ Messages: [] });
    mockDeletePromise.mockResolvedValue({});
    mockRunMatchmakingSweep.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    delete process.env.MATCHMAKING_QUEUE_WORKER;
    delete process.env.MATCHMAKING_RANKED_QUEUE_URL;
    delete process.env.MATCHMAKING_FREE_QUEUE_URL;
    delete process.env.AWS_REGION;
  });

  // -------------------------------------------------------------------------
  // startMatchmakingQueueWorker — disabled worker
  // -------------------------------------------------------------------------

  describe('startMatchmakingQueueWorker — worker disabled', () => {
    it('logs info and returns early when MATCHMAKING_QUEUE_WORKER=false', () => {
      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_QUEUE_WORKER: 'false',
      });

      startMatchmakingQueueWorker();

      expect(mockLogger.info).toHaveBeenCalledWith(
        '[MATCHMAKING/WORKER] Disabled via environment variable'
      );
      expect(mockSqsInstance.receiveMessage).not.toHaveBeenCalled();
    });

    it('does not start polling when disabled', () => {
      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_QUEUE_WORKER: 'false',
        MATCHMAKING_RANKED_QUEUE_URL: RANKED_URL,
        MATCHMAKING_FREE_QUEUE_URL: FREE_URL,
      });

      startMatchmakingQueueWorker();

      expect(mockSqsInstance.receiveMessage).not.toHaveBeenCalled();
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('does NOT disable when MATCHMAKING_QUEUE_WORKER is "true"', () => {
      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_QUEUE_WORKER: 'true',
        MATCHMAKING_RANKED_QUEUE_URL: RANKED_URL,
        MATCHMAKING_FREE_QUEUE_URL: FREE_URL,
      });

      startMatchmakingQueueWorker();

      expect(mockLogger.info).not.toHaveBeenCalledWith(
        '[MATCHMAKING/WORKER] Disabled via environment variable'
      );
    });

    it('does NOT disable when MATCHMAKING_QUEUE_WORKER is unset', () => {
      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_QUEUE_WORKER: undefined,
        MATCHMAKING_RANKED_QUEUE_URL: RANKED_URL,
        MATCHMAKING_FREE_QUEUE_URL: FREE_URL,
      });

      startMatchmakingQueueWorker();

      expect(mockLogger.info).not.toHaveBeenCalledWith(
        '[MATCHMAKING/WORKER] Disabled via environment variable'
      );
    });
  });

  // -------------------------------------------------------------------------
  // startMatchmakingQueueWorker — no URLs configured
  // -------------------------------------------------------------------------

  describe('startMatchmakingQueueWorker — no URLs configured', () => {
    it('logs warnings for both queues when no URLs are set', () => {
      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_RANKED_QUEUE_URL: undefined,
        MATCHMAKING_FREE_QUEUE_URL: undefined,
      });

      startMatchmakingQueueWorker();

      expect(mockLogger.warn).toHaveBeenCalledTimes(2);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[MATCHMAKING/WORKER] No queue URL configured for ranked mode'
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[MATCHMAKING/WORKER] No queue URL configured for free mode'
      );
    });

    it('does not call SQS when no URLs configured', () => {
      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_RANKED_QUEUE_URL: undefined,
        MATCHMAKING_FREE_QUEUE_URL: undefined,
      });

      startMatchmakingQueueWorker();

      expect(mockSqsInstance.receiveMessage).not.toHaveBeenCalled();
    });

    it('only warns about ranked queue when only ranked URL is missing', () => {
      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_RANKED_QUEUE_URL: undefined,
        MATCHMAKING_FREE_QUEUE_URL: FREE_URL,
      });

      startMatchmakingQueueWorker();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[MATCHMAKING/WORKER] No queue URL configured for ranked mode'
      );
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        '[MATCHMAKING/WORKER] No queue URL configured for free mode'
      );
    });

    it('only warns about free queue when only free URL is missing', () => {
      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_RANKED_QUEUE_URL: RANKED_URL,
        MATCHMAKING_FREE_QUEUE_URL: undefined,
      });

      startMatchmakingQueueWorker();

      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        '[MATCHMAKING/WORKER] No queue URL configured for ranked mode'
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[MATCHMAKING/WORKER] No queue URL configured for free mode'
      );
    });
  });

  // -------------------------------------------------------------------------
  // startMatchmakingQueueWorker — starts polling with URLs
  // -------------------------------------------------------------------------

  describe('startMatchmakingQueueWorker — with URLs configured', () => {
    it('starts polling both queues when both URLs are set', async () => {
      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_RANKED_QUEUE_URL: RANKED_URL,
        MATCHMAKING_FREE_QUEUE_URL: FREE_URL,
      });

      startMatchmakingQueueWorker();
      await flushPromises();

      expect(mockSqsInstance.receiveMessage).toHaveBeenCalledTimes(2);
    });

    it('calls receiveMessage with the ranked queue URL', async () => {
      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_RANKED_QUEUE_URL: RANKED_URL,
        MATCHMAKING_FREE_QUEUE_URL: undefined,
      });

      startMatchmakingQueueWorker();
      await flushPromises();

      expect(mockSqsInstance.receiveMessage).toHaveBeenCalledWith(
        expect.objectContaining({ QueueUrl: RANKED_URL })
      );
    });

    it('calls receiveMessage with the free queue URL', async () => {
      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_RANKED_QUEUE_URL: undefined,
        MATCHMAKING_FREE_QUEUE_URL: FREE_URL,
      });

      startMatchmakingQueueWorker();
      await flushPromises();

      expect(mockSqsInstance.receiveMessage).toHaveBeenCalledWith(
        expect.objectContaining({ QueueUrl: FREE_URL })
      );
    });
  });

  // -------------------------------------------------------------------------
  // pollQueue — SQS receiveMessage parameters
  // -------------------------------------------------------------------------

  describe('pollQueue — receiveMessage parameters', () => {
    it('sends correct SQS parameters', async () => {
      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_RANKED_QUEUE_URL: RANKED_URL,
        MATCHMAKING_FREE_QUEUE_URL: undefined,
      });

      startMatchmakingQueueWorker();
      await flushPromises();

      expect(mockSqsInstance.receiveMessage).toHaveBeenCalledWith({
        QueueUrl: RANKED_URL,
        MaxNumberOfMessages: 5,
        MessageAttributeNames: ['All'],
        WaitTimeSeconds: 20,
      });
    });
  });

  // -------------------------------------------------------------------------
  // pollQueue — URL with only whitespace
  // -------------------------------------------------------------------------

  describe('pollQueue — whitespace-only URL', () => {
    it('logs warn and skips polling when URL is whitespace only', () => {
      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_RANKED_QUEUE_URL: '   ',
        MATCHMAKING_FREE_QUEUE_URL: undefined,
      });

      startMatchmakingQueueWorker();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[MATCHMAKING/WORKER] Skipping ranked queue poller; no URL configured'
      );
      expect(mockSqsInstance.receiveMessage).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // pollQueue — no messages
  // -------------------------------------------------------------------------

  describe('pollQueue — no messages received', () => {
    it('does not call runMatchmakingSweep when queue is empty', async () => {
      mockReceivePromise.mockResolvedValue({ Messages: [] });

      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_RANKED_QUEUE_URL: RANKED_URL,
        MATCHMAKING_FREE_QUEUE_URL: undefined,
      });

      startMatchmakingQueueWorker();
      await flushPromises();

      expect(mockRunMatchmakingSweep).not.toHaveBeenCalled();
    });

    it('does not call deleteMessage when queue is empty', async () => {
      mockReceivePromise.mockResolvedValue({ Messages: [] });

      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_RANKED_QUEUE_URL: RANKED_URL,
        MATCHMAKING_FREE_QUEUE_URL: undefined,
      });

      startMatchmakingQueueWorker();
      await flushPromises();

      expect(mockSqsInstance.deleteMessage).not.toHaveBeenCalled();
    });

    it('schedules next poll via setTimeout (5000ms) when queue is empty', async () => {
      mockReceivePromise.mockResolvedValue({ Messages: [] });

      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_RANKED_QUEUE_URL: RANKED_URL,
        MATCHMAKING_FREE_QUEUE_URL: undefined,
      });

      startMatchmakingQueueWorker();
      await flushPromises();

      // Advance timers — poll should run again after 5 seconds
      jest.advanceTimersByTime(5000);
      await flushPromises();

      expect(mockSqsInstance.receiveMessage).toHaveBeenCalledTimes(2);
    });

    it('falls through to setTimeout when Messages key is absent', async () => {
      mockReceivePromise.mockResolvedValue({}); // no Messages property

      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_RANKED_QUEUE_URL: RANKED_URL,
        MATCHMAKING_FREE_QUEUE_URL: undefined,
      });

      startMatchmakingQueueWorker();
      await flushPromises();

      expect(mockRunMatchmakingSweep).not.toHaveBeenCalled();

      // Advance 5 seconds — should poll again
      jest.advanceTimersByTime(5000);
      await flushPromises();
      expect(mockSqsInstance.receiveMessage).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // pollQueue — messages received
  // -------------------------------------------------------------------------

  describe('pollQueue — messages received', () => {
    const TEST_MESSAGES = [
      { ReceiptHandle: 'receipt-handle-1', Body: '{"event":"enqueue"}' },
      { ReceiptHandle: 'receipt-handle-2', Body: '{"event":"enqueue"}' },
    ];

    beforeEach(() => {
      // Return messages on first call, empty on subsequent calls to avoid infinite loop
      mockReceivePromise
        .mockResolvedValueOnce({ Messages: TEST_MESSAGES })
        .mockResolvedValue({ Messages: [] });
    });

    it('calls runMatchmakingSweep with "ranked" mode', async () => {
      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_RANKED_QUEUE_URL: RANKED_URL,
        MATCHMAKING_FREE_QUEUE_URL: undefined,
      });

      startMatchmakingQueueWorker();
      await flushPromises();

      expect(mockRunMatchmakingSweep).toHaveBeenCalledWith('ranked');
    });

    it('calls runMatchmakingSweep with "free" mode', async () => {
      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_RANKED_QUEUE_URL: undefined,
        MATCHMAKING_FREE_QUEUE_URL: FREE_URL,
      });

      startMatchmakingQueueWorker();
      await flushPromises();

      expect(mockRunMatchmakingSweep).toHaveBeenCalledWith('free');
    });

    it('logs debug with message count and mode', async () => {
      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_RANKED_QUEUE_URL: RANKED_URL,
        MATCHMAKING_FREE_QUEUE_URL: undefined,
      });

      startMatchmakingQueueWorker();
      await flushPromises();

      expect(mockLogger.debug).toHaveBeenCalledWith(
        '[MATCHMAKING/WORKER] Processing 2 event(s) from ranked queue'
      );
    });

    it('deletes all messages after sweep completes', async () => {
      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_RANKED_QUEUE_URL: RANKED_URL,
        MATCHMAKING_FREE_QUEUE_URL: undefined,
      });

      startMatchmakingQueueWorker();
      await flushPromises();

      expect(mockSqsInstance.deleteMessage).toHaveBeenCalledTimes(2);
    });

    it('deletes each message with correct QueueUrl and ReceiptHandle', async () => {
      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_RANKED_QUEUE_URL: RANKED_URL,
        MATCHMAKING_FREE_QUEUE_URL: undefined,
      });

      startMatchmakingQueueWorker();
      await flushPromises();

      expect(mockSqsInstance.deleteMessage).toHaveBeenCalledWith({
        QueueUrl: RANKED_URL,
        ReceiptHandle: 'receipt-handle-1',
      });
      expect(mockSqsInstance.deleteMessage).toHaveBeenCalledWith({
        QueueUrl: RANKED_URL,
        ReceiptHandle: 'receipt-handle-2',
      });
    });

    it('continues polling immediately after processing (uses setImmediate path)', async () => {
      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_RANKED_QUEUE_URL: RANKED_URL,
        MATCHMAKING_FREE_QUEUE_URL: undefined,
      });

      startMatchmakingQueueWorker();
      await flushPromises();

      // Advance by 0ms — setImmediate fires, second poll should run
      jest.advanceTimersByTime(0);
      await flushPromises();

      // receiveMessage called at least twice (first poll + immediate re-poll)
      expect(mockSqsInstance.receiveMessage).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // pollQueue — messages without ReceiptHandle
  // -------------------------------------------------------------------------

  describe('pollQueue — messages missing ReceiptHandle', () => {
    it('skips deleteMessage for messages without ReceiptHandle', async () => {
      mockReceivePromise
        .mockResolvedValueOnce({
          Messages: [
            { Body: '{}' }, // no ReceiptHandle
            { ReceiptHandle: 'receipt-ok', Body: '{}' },
          ],
        })
        .mockResolvedValue({ Messages: [] });

      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_RANKED_QUEUE_URL: RANKED_URL,
        MATCHMAKING_FREE_QUEUE_URL: undefined,
      });

      startMatchmakingQueueWorker();
      await flushPromises();

      expect(mockSqsInstance.deleteMessage).toHaveBeenCalledTimes(1);
      expect(mockSqsInstance.deleteMessage).toHaveBeenCalledWith({
        QueueUrl: RANKED_URL,
        ReceiptHandle: 'receipt-ok',
      });
    });

    it('still calls runMatchmakingSweep even when messages lack ReceiptHandle', async () => {
      mockReceivePromise
        .mockResolvedValueOnce({ Messages: [{ Body: '{}' }] })
        .mockResolvedValue({ Messages: [] });

      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_RANKED_QUEUE_URL: RANKED_URL,
        MATCHMAKING_FREE_QUEUE_URL: undefined,
      });

      startMatchmakingQueueWorker();
      await flushPromises();

      expect(mockRunMatchmakingSweep).toHaveBeenCalledWith('ranked');
    });

    it('skips all deletes when every message lacks ReceiptHandle', async () => {
      mockReceivePromise
        .mockResolvedValueOnce({
          Messages: [{ Body: '{}' }, { Body: '{}' }, { Body: '{}' }],
        })
        .mockResolvedValue({ Messages: [] });

      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_RANKED_QUEUE_URL: RANKED_URL,
        MATCHMAKING_FREE_QUEUE_URL: undefined,
      });

      startMatchmakingQueueWorker();
      await flushPromises();

      expect(mockSqsInstance.deleteMessage).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // pollQueue — error handling: runMatchmakingSweep failure
  // -------------------------------------------------------------------------

  describe('pollQueue — runMatchmakingSweep error', () => {
    it('logs error when sweep throws', async () => {
      const sweepError = new Error('Sweep failed catastrophically');
      mockRunMatchmakingSweep.mockRejectedValueOnce(sweepError);
      mockReceivePromise
        .mockResolvedValueOnce({ Messages: [{ ReceiptHandle: 'r1', Body: '{}' }] })
        .mockResolvedValue({ Messages: [] });

      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_RANKED_QUEUE_URL: RANKED_URL,
        MATCHMAKING_FREE_QUEUE_URL: undefined,
      });

      startMatchmakingQueueWorker();
      await flushPromises();

      expect(mockLogger.error).toHaveBeenCalledWith(
        '[MATCHMAKING/WORKER] Failed matchmaking sweep for ranked',
        sweepError
      );
    });

    it('still deletes messages even when sweep throws', async () => {
      mockRunMatchmakingSweep.mockRejectedValueOnce(new Error('Sweep failure'));
      mockReceivePromise
        .mockResolvedValueOnce({ Messages: [{ ReceiptHandle: 'r1', Body: '{}' }] })
        .mockResolvedValue({ Messages: [] });

      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_RANKED_QUEUE_URL: RANKED_URL,
        MATCHMAKING_FREE_QUEUE_URL: undefined,
      });

      startMatchmakingQueueWorker();
      await flushPromises();

      expect(mockSqsInstance.deleteMessage).toHaveBeenCalledWith({
        QueueUrl: RANKED_URL,
        ReceiptHandle: 'r1',
      });
    });

    it('continues polling after sweep error (uses setImmediate path)', async () => {
      mockRunMatchmakingSweep.mockRejectedValueOnce(new Error('Sweep failure'));
      mockReceivePromise
        .mockResolvedValueOnce({ Messages: [{ ReceiptHandle: 'r1', Body: '{}' }] })
        .mockResolvedValue({ Messages: [] });

      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_RANKED_QUEUE_URL: RANKED_URL,
        MATCHMAKING_FREE_QUEUE_URL: undefined,
      });

      startMatchmakingQueueWorker();
      await flushPromises();
      jest.advanceTimersByTime(0);
      await flushPromises();

      expect(mockSqsInstance.receiveMessage).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // pollQueue — error handling: deleteMessage failure
  // -------------------------------------------------------------------------

  describe('pollQueue — deleteMessage error', () => {
    it('logs warning when deleteMessage rejects', async () => {
      const deleteError = new Error('Delete failed');
      mockDeletePromise.mockRejectedValueOnce(deleteError);
      mockReceivePromise
        .mockResolvedValueOnce({ Messages: [{ ReceiptHandle: 'r1', Body: '{}' }] })
        .mockResolvedValue({ Messages: [] });

      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_RANKED_QUEUE_URL: RANKED_URL,
        MATCHMAKING_FREE_QUEUE_URL: undefined,
      });

      startMatchmakingQueueWorker();
      await flushPromises();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[MATCHMAKING/WORKER] Failed to delete SQS message',
        expect.objectContaining({ mode: 'ranked', error: deleteError })
      );
    });

    it('continues processing other messages when one delete fails', async () => {
      mockDeletePromise
        .mockRejectedValueOnce(new Error('First delete failed'))
        .mockResolvedValue({});

      mockReceivePromise
        .mockResolvedValueOnce({
          Messages: [
            { ReceiptHandle: 'r1', Body: '{}' },
            { ReceiptHandle: 'r2', Body: '{}' },
          ],
        })
        .mockResolvedValue({ Messages: [] });

      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_RANKED_QUEUE_URL: RANKED_URL,
        MATCHMAKING_FREE_QUEUE_URL: undefined,
      });

      startMatchmakingQueueWorker();
      await flushPromises();

      // Both delete calls should have been attempted
      expect(mockSqsInstance.deleteMessage).toHaveBeenCalledTimes(2);
    });

    it('still continues polling after a delete failure', async () => {
      mockDeletePromise.mockRejectedValueOnce(new Error('Delete failed'));
      mockReceivePromise
        .mockResolvedValueOnce({ Messages: [{ ReceiptHandle: 'r1', Body: '{}' }] })
        .mockResolvedValue({ Messages: [] });

      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_RANKED_QUEUE_URL: RANKED_URL,
        MATCHMAKING_FREE_QUEUE_URL: undefined,
      });

      startMatchmakingQueueWorker();
      await flushPromises();
      jest.advanceTimersByTime(0);
      await flushPromises();

      expect(mockSqsInstance.receiveMessage).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // pollQueue — error handling: receiveMessage failure
  // -------------------------------------------------------------------------

  describe('pollQueue — receiveMessage error', () => {
    it('logs error when receiveMessage rejects', async () => {
      const receiveError = new Error('SQS service unavailable');
      mockReceivePromise
        .mockRejectedValueOnce(receiveError)
        .mockResolvedValue({ Messages: [] });

      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_RANKED_QUEUE_URL: RANKED_URL,
        MATCHMAKING_FREE_QUEUE_URL: undefined,
      });

      startMatchmakingQueueWorker();
      await flushPromises();

      expect(mockLogger.error).toHaveBeenCalledWith(
        '[MATCHMAKING/WORKER] Error polling ranked queue',
        receiveError
      );
    });

    it('schedules retry via setTimeout when receiveMessage fails', async () => {
      mockReceivePromise
        .mockRejectedValueOnce(new Error('SQS failure'))
        .mockResolvedValue({ Messages: [] });

      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_RANKED_QUEUE_URL: RANKED_URL,
        MATCHMAKING_FREE_QUEUE_URL: undefined,
      });

      startMatchmakingQueueWorker();
      await flushPromises();

      // After error, should retry after 5 seconds
      jest.advanceTimersByTime(5000);
      await flushPromises();

      expect(mockSqsInstance.receiveMessage).toHaveBeenCalledTimes(2);
    });

    it('does not call runMatchmakingSweep when receiveMessage fails', async () => {
      mockReceivePromise.mockRejectedValueOnce(new Error('SQS failure'));

      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_RANKED_QUEUE_URL: RANKED_URL,
        MATCHMAKING_FREE_QUEUE_URL: undefined,
      });

      startMatchmakingQueueWorker();
      await flushPromises();

      expect(mockRunMatchmakingSweep).not.toHaveBeenCalled();
    });

    it('does not call deleteMessage when receiveMessage fails', async () => {
      mockReceivePromise.mockRejectedValueOnce(new Error('SQS failure'));

      const { startMatchmakingQueueWorker } = loadWorker({
        MATCHMAKING_RANKED_QUEUE_URL: RANKED_URL,
        MATCHMAKING_FREE_QUEUE_URL: undefined,
      });

      startMatchmakingQueueWorker();
      await flushPromises();

      expect(mockSqsInstance.deleteMessage).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // SQS configuration
  // -------------------------------------------------------------------------

  describe('SQS configuration', () => {
    it('creates SQS with the configured AWS region', () => {
      process.env.AWS_REGION = 'eu-west-1';

      jest.isolateModules(() => {
        require('../matchmaking-queue-worker');
      });

      expect(AWS.SQS).toHaveBeenCalledWith(
        expect.objectContaining({ region: 'eu-west-1' })
      );

      delete process.env.AWS_REGION;
    });

    it('defaults SQS region to us-east-1 when AWS_REGION is unset', () => {
      delete process.env.AWS_REGION;

      jest.isolateModules(() => {
        require('../matchmaking-queue-worker');
      });

      expect(AWS.SQS).toHaveBeenCalledWith(
        expect.objectContaining({ region: 'us-east-1' })
      );
    });
  });
});
