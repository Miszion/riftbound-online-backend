import winston from 'winston';

const suppressedMessagePatterns = [
  /^\[MATCH-SERVICE\]\s+GET\s+\/matches(?:\/|$)/i,
  /^\[MATCH-SERVICE\]\s+GET\s+\/health\b/i
];

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
