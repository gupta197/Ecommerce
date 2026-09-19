import { Router } from 'express'
import { Types } from 'mongoose'
import * as cartService from '../services/cart.service.js'
import { resolveCustomerId } from '../services/shared-validation.js'
import { objectIdSchema } from '../validation/common.schema.js'
import { sendSuccess } from '../../../lib/response.js'
import { UnauthenticatedError } from '../../../lib/http-errors.js'
import { createAuthenticateMiddleware } from '../../../middleware/authenticate.js'
import type { Logger } from '../../../lib/logger.js'

export interface CreateCartRouterOptions {
  jwtSecret: string
  logger: Logger
}

// Self-service only, mirroring customers/organizations exactly: every
// handler resolves the acting customer from req.auth.userId and never from
// a client-supplied customerId/userId. Mounted UNDER a '/cart' prefix by
// routes/v1/index.ts (the same convention customers/organizations use) —
// deliberately NOT the no-prefix convention wishlist.route.ts uses, so a
// blanket router.use(authenticate) here is safe: every request that reaches
// this router has already been matched to start with '/cart' by the parent
// router, so there is no unrelated/unmatched path for it to incorrectly
// intercept (the exact class of bug found and fixed in COM-001).
export function createCartRouter(options: CreateCartRouterOptions): Router {
  const router = Router()
  const authenticate = createAuthenticateMiddleware(options.jwtSecret)
  router.use(authenticate)

  // GET must never create a Cart merely because it was read (approved
  // COM-002 correction #2) — cartService.getCart returns an empty-cart view
  // when none exists yet.
  router.get('/', async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    const organizationId = new Types.ObjectId(objectIdSchema.parse(req.query.organizationId))
    const customerId = await resolveCustomerId(new Types.ObjectId(req.auth.userId))
    const cart = await cartService.getCart(customerId, organizationId)
    sendSuccess(res, cart)
  })

  router.post('/items', async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    const customerId = await resolveCustomerId(new Types.ObjectId(req.auth.userId))
    const item = await cartService.addCartItem(customerId, req.body)
    sendSuccess(res, item, {}, 201)
  })

  router.patch('/items/:id', async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    const id = new Types.ObjectId(objectIdSchema.parse(req.params.id))
    const customerId = await resolveCustomerId(new Types.ObjectId(req.auth.userId))
    const item = await cartService.updateCartItemQuantity(customerId, id, req.body)
    sendSuccess(res, item)
  })

  router.delete('/items/:id', async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    const id = new Types.ObjectId(objectIdSchema.parse(req.params.id))
    const customerId = await resolveCustomerId(new Types.ObjectId(req.auth.userId))
    const item = await cartService.removeCartItem(customerId, id)
    sendSuccess(res, item)
  })

  router.delete('/', async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    const organizationId = new Types.ObjectId(objectIdSchema.parse(req.query.organizationId))
    const customerId = await resolveCustomerId(new Types.ObjectId(req.auth.userId))
    const cart = await cartService.clearCart(customerId, organizationId)
    sendSuccess(res, cart)
  })

  return router
}
