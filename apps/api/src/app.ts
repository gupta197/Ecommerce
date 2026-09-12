import express, { type Express } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import type { AppConfig } from './config/env.js'
import type { Logger } from './lib/logger.js'
import { requestContext } from './middleware/request-context.js'
import { createRequestLogger } from './middleware/request-logger.js'
import { createRateLimiter } from './middleware/rate-limit.js'
import { notFoundHandler } from './middleware/not-found.js'
import { createErrorHandler } from './middleware/error-handler.js'
import { createV1Router } from './routes/v1/index.js'

export function createApp(config: AppConfig, logger: Logger): Express {
  const app = express()

  app.use(helmet())
  app.use(cors({ origin: config.corsOrigins }))
  app.use(express.json({ limit: '1mb' }))
  app.use(requestContext)
  app.use(createRequestLogger(logger))
  app.use(createRateLimiter(config.rateLimit))

  app.use('/api/v1', createV1Router(config, logger))

  app.use(notFoundHandler)
  app.use(createErrorHandler(logger))

  return app
}
