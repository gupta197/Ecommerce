import { randomUUID } from 'node:crypto'
import { pinoHttp } from 'pino-http'
import type { Logger } from '../lib/logger.js'

export function createRequestLogger(logger: Logger) {
  return pinoHttp({
    logger,
    genReqId: (req) => (req as { id?: string }).id ?? randomUUID(),
  })
}
