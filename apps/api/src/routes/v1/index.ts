import { Router } from 'express'
import { healthRouter } from './health.route.js'
import { readyRouter } from './ready.route.js'
import { createAuthRouter } from '../../modules/auth/routes/auth.route.js'
import { createOrganizationsRouter } from '../../modules/organizations/routes/organization.route.js'
import { createCustomersRouter } from '../../modules/customers/routes/customer.route.js'
import { createWishlistRouter } from '../../modules/wishlist/routes/wishlist.route.js'
import type { AppConfig } from '../../config/env.js'
import type { Logger } from '../../lib/logger.js'

export function createV1Router(config: AppConfig, logger: Logger): Router {
  const router = Router()
  router.use(healthRouter)
  router.use(readyRouter)
  router.use(
    '/auth',
    createAuthRouter({
      authConfig: config.auth,
      authRateLimit: config.authRateLimit,
      allowedOrigins: config.corsOrigins,
      isProduction: config.nodeEnv === 'production',
      logger,
    }),
  )
  router.use(
    '/organizations',
    createOrganizationsRouter({
      jwtSecret: config.auth.jwtSecret,
      logger,
    }),
  )
  router.use(
    '/customers',
    createCustomersRouter({
      jwtSecret: config.auth.jwtSecret,
      logger,
    }),
  )
  // No path prefix — wishlist.route.ts defines its own top-level
  // /wishlist and /back-in-stock-requests paths directly, the same
  // no-prefix mounting convention healthRouter/readyRouter already use.
  router.use(
    createWishlistRouter({
      jwtSecret: config.auth.jwtSecret,
      logger,
    }),
  )
  return router
}
