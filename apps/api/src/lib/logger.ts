import pino from 'pino'
import type { AppConfig } from '../config/env.js'

export function createLogger(config: Pick<AppConfig, 'logLevel'>) {
  return pino({
    level: config.logLevel,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      censor: '[REDACTED]',
    },
  })
}

export type Logger = ReturnType<typeof createLogger>
