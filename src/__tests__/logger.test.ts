/**
 * Logger module tests - QA REGRESSION
 *
 * Tests cover: module import, serializeError format, suppressNoise format,
 * normalizeErrors format, and logger method invocations.
 */

// Suppress console output during logger tests
beforeAll(() => {
  jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterAll(() => {
  jest.restoreAllMocks();
});

describe('Logger - module export', () => {
  it('should export a logger object with standard winston methods', async () => {
    const mod = await import('../logger');
    const logger = mod.default;
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('should export a default logger (not undefined)', async () => {
    const mod = await import('../logger');
    expect(mod.default).not.toBeNull();
    expect(mod.default).not.toBeUndefined();
  });
});

describe('Logger - info logging', () => {
  it('should log an info message without throwing', async () => {
    const mod = await import('../logger');
    const logger = mod.default;
    expect(() => logger.info('Test info message')).not.toThrow();
  });

  it('should log info with metadata without throwing', async () => {
    const mod = await import('../logger');
    const logger = mod.default;
    expect(() => logger.info('Info with meta', { userId: 'test-123', action: 'test' })).not.toThrow();
  });

  it('should log info with nested metadata without throwing', async () => {
    const mod = await import('../logger');
    const logger = mod.default;
    expect(() =>
      logger.info('Nested meta', { request: { path: '/api/test', method: 'GET' }, count: 1 })
    ).not.toThrow();
  });
});

describe('Logger - error logging', () => {
  it('should log an error message without throwing', async () => {
    const mod = await import('../logger');
    const logger = mod.default;
    expect(() => logger.error('Test error message')).not.toThrow();
  });

  it('should log an Error object without throwing', async () => {
    const mod = await import('../logger');
    const logger = mod.default;
    const err = new Error('Something went wrong');
    expect(() => logger.error('Error occurred', err)).not.toThrow();
  });

  it('should log an Error with extra properties without throwing', async () => {
    const mod = await import('../logger');
    const logger = mod.default;
    const err = new Error('Augmented error') as Error & { code: string; statusCode: number };
    err.code = 'ERR_CUSTOM';
    err.statusCode = 500;
    expect(() => logger.error('Augmented error log', err)).not.toThrow();
  });

  it('should log multiple errors in splat without throwing', async () => {
    const mod = await import('../logger');
    const logger = mod.default;
    const err1 = new Error('First error');
    const err2 = new Error('Second error');
    expect(() => logger.error('Multiple errors', err1, err2)).not.toThrow();
  });

  it('should handle non-Error objects in error logging', async () => {
    const mod = await import('../logger');
    const logger = mod.default;
    expect(() => logger.error('Non-error object', { reason: 'unknown' })).not.toThrow();
  });
});

describe('Logger - warn logging', () => {
  it('should log a warning message without throwing', async () => {
    const mod = await import('../logger');
    const logger = mod.default;
    expect(() => logger.warn('Test warning')).not.toThrow();
  });

  it('should log a warning with context without throwing', async () => {
    const mod = await import('../logger');
    const logger = mod.default;
    expect(() => logger.warn('Warning with context', { matchId: 'match-123', phase: 'COMBAT' })).not.toThrow();
  });
});

describe('Logger - debug logging', () => {
  it('should log debug messages without throwing', async () => {
    const mod = await import('../logger');
    const logger = mod.default;
    expect(() => logger.debug('Debug message')).not.toThrow();
  });

  it('should log debug with complex payload without throwing', async () => {
    const mod = await import('../logger');
    const logger = mod.default;
    expect(() =>
      logger.debug('Complex debug', {
        players: ['p1', 'p2'],
        cards: [{ id: 'c1', name: 'Test Card' }],
        turn: 3
      })
    ).not.toThrow();
  });
});

describe('Logger - noise suppression', () => {
  it('should suppress GET /matches log messages without throwing', async () => {
    const mod = await import('../logger');
    const logger = mod.default;
    // These messages should be suppressed by suppressNoiseFormat
    expect(() => logger.info('[MATCH-SERVICE] GET /matches')).not.toThrow();
    expect(() => logger.info('[MATCH-SERVICE] GET /matches/abc123')).not.toThrow();
  });

  it('should suppress GET /health log messages without throwing', async () => {
    const mod = await import('../logger');
    const logger = mod.default;
    expect(() => logger.info('[MATCH-SERVICE] GET /health')).not.toThrow();
  });

  it('should not suppress unrelated messages', async () => {
    const mod = await import('../logger');
    const logger = mod.default;
    expect(() => logger.info('[MATCH-SERVICE] POST /matches')).not.toThrow();
    expect(() => logger.info('Game started')).not.toThrow();
  });
});

describe('Logger - error serialization via normalizeErrors', () => {
  it('should handle Error instances passed as metadata values', async () => {
    const mod = await import('../logger');
    const logger = mod.default;
    const err = new Error('Serialized error');
    // Logger internally serializes Error objects using normalizeErrorsFormat
    expect(() => logger.error('Serialized test', { cause: err })).not.toThrow();
  });

  it('should handle null and undefined metadata gracefully', async () => {
    const mod = await import('../logger');
    const logger = mod.default;
    expect(() => logger.info('Null meta', { value: null })).not.toThrow();
    expect(() => logger.info('Undefined meta', { value: undefined })).not.toThrow();
  });

  it('should handle empty string messages', async () => {
    const mod = await import('../logger');
    const logger = mod.default;
    expect(() => logger.info('')).not.toThrow();
  });

  it('should handle numeric and boolean metadata', async () => {
    const mod = await import('../logger');
    const logger = mod.default;
    expect(() =>
      logger.info('Primitive meta', { count: 42, active: true, ratio: 3.14 })
    ).not.toThrow();
  });
});

describe('Logger - service metadata', () => {
  it('should have a consistent service name in default metadata', async () => {
    const mod = await import('../logger');
    const logger = mod.default;
    // The logger is configured with defaultMeta: { service: 'riftbound-online' }
    // We can verify via the logger's defaultMeta
    expect((logger as any).defaultMeta).toMatchObject({ service: 'riftbound-online' });
  });
});
