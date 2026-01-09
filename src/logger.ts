import winston from 'winston';

const suppressedMessagePatterns = [
  /^\[MATCH-SERVICE\]\s+GET\s+\/matches(?:\/|$)/i,
  /^\[MATCH-SERVICE\]\s+GET\s+\/health\b/i
];

const serializeError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return error;
  }
  const serialized: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    stack: error.stack
  };
  Object.keys(error).forEach((key) => {
    serialized[key] = (error as unknown as Record<string, unknown>)[key];
  });
  return serialized;
};

const splatSymbol = Symbol.for('splat');

const normalizeErrorsFormat = winston.format((info) => {
  const splat = info[splatSymbol];
  if (Array.isArray(splat)) {
    const errors = splat.filter((item) => item instanceof Error);
    if (errors.length > 0 && !info.error) {
      info.error = serializeError(errors[0]);
    }
    if (errors.length > 1 && !info.errors) {
      info.errors = errors.map((item) => serializeError(item));
    }
  }
  Object.entries(info).forEach(([key, value]) => {
    if (value instanceof Error) {
      info[key] = serializeError(value);
    }
  });
  return info;
});

const suppressNoiseFormat = winston.format((info) => {
  const message = typeof info.message === 'string' ? info.message : '';
  const shouldSuppress = suppressedMessagePatterns.some((pattern) => pattern.test(message));
  return shouldSuppress ? false : info;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    suppressNoiseFormat(),
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    normalizeErrorsFormat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'riftbound-online' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        suppressNoiseFormat(),
        winston.format.colorize(),
        winston.format.printf(({ level, message, timestamp, ...meta }) => {
          const details = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
          return `${timestamp} [${level}]: ${message}${details}`;
        })
      )
    })
  ]
});

export default logger;
