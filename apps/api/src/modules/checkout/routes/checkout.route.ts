import { Router } from 'express'
import { Types } from 'mongoose'
import * as checkoutService from '../services/checkout.service.js'
import { resolveCustomerId } from '../services/shared-validation.js'
import { sendSuccess } from '../../../lib/response.js'
import { UnauthenticatedError } from '../../../lib/http-errors.js'
import { createAuthenticateMiddleware } from '../../../middleware/authenticate.js'
import type { Logger } from '../../../lib/logger.js'

export interface CreateCheckoutRouterOptions {
  jwtSecret: string
  logger: Logger
}

// Self-service only, mirroring cart/customers exactly: every handler
// resolves the acting customer from req.auth.userId and never from a
// client-supplied customerId. Mounted UNDER a '/checkout' prefix by
// routes/v1/index.ts, so a blanket router.use(authenticate) is safe here —
// every request reaching this router has already been matched to start
// with '/checkout' by the parent router (the same reasoning already
// applied to Cart's own router, avoiding the no-prefix authenticate-
// scoping bug class found and fixed in COM-001).
export function createCheckoutRouter(options: CreateCheckoutRouterOptions): Router {
  const router = Router()
  const authenticate = createAuthenticateMiddleware(options.jwtSecret)
  router.use(authenticate)

  // Read-only: never creates an Order, never modifies Cart or inventory.
  router.post('/preview', async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    const customerId = await resolveCustomerId(new Types.ObjectId(req.auth.userId))
    const view = await checkoutService.previewCheckout(customerId, req.body)
    sendSuccess(res, view)
  })

  // Creates the Order and clears the Cart atomically.
  router.post('/', async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    const customerId = await resolveCustomerId(new Types.ObjectId(req.auth.userId))
    const order = await checkoutService.confirmCheckout(customerId, req.body)
    sendSuccess(res, order, {}, 201)
  })

  return router
}
