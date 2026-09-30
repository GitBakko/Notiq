import pino from 'pino';

const REDACT_KEYS = ['authKey', 'serverShare', 'passphrase', 'pin', 'codeA', 'codeB'];
export const REDACT_PATHS = REDACT_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`]);

export const loggerOptions = {
  level: process.env.LOG_LEVEL || 'info',
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
};

const logger = pino(loggerOptions);

export default logger;
