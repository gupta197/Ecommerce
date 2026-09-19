import { Router } from 'express'
import { Types } from 'mongoose'
import * as wishlistService from '../services/wishlist.service.js'
import * as backInStockRequestService from '../services/back-in-stock-request.service.js'
import { resolveCustomerId } from '../services/shared-validation.js'
import { objectIdSchema } from '../validation/common.schema.js'
import { sendSuccess } from '../../../lib/response.js'
import { UnauthenticatedError } from '../../../lib/http-errors.js'
import { createAuthenticateMiddleware } from '../../../middleware/authenticate.js'
import type { Logger } from '../../../lib/logger.js'

export interface CreateWishlistRouterOptions {
  jwtSecret: string
  logger: Logger
}

// Self-service only, mirroring customers/routes/customer.route.ts exactly:
// every handler resolves the acting customer from req.auth.userId and
// never from a client-supplied customerId/userId. No organization
// membership context is used anywhere here — a client-supplied
// organizationId is validated (existence + ACTIVE) but never trusted as
// authorization; the authoritative tenant check is the ProductVariant's
// own organizationId (see shared-validation.ts's assertValidVariant).
export function createWishlistRouter(options: CreateWishlistRouterOptions): Router {
  const router = Router()
  const authenticate = createAuthenticateMiddleware(options.jwtSecret)

  // Scoped to exactly the two paths this router owns — unlike
  // customers/organizations (mounted under their own '/customers'/
  // '/organizations' prefix by routes/v1/index.ts), this router is mounted
  // with no prefix (its routes already define their own top-level paths,
  // the same convention healthRouter/readyRouter use). A blanket
  // `router.use(authenticate)` here would incorrectly intercept every
  // request that reaches this router in the chain — including a
  // completely unrelated, genuinely unmatched path — and 401 it instead of
  // letting it fall through to the app's real 404 handler. Scoping the
  // middleware to these two path prefixes only fixes that.
  router.use(['/wishlist', '/back-in-stock-requests'], authenticate)

  router.get('/wishlist', async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    const customerId = await resolveCustomerId(new Types.ObjectId(req.auth.userId))
    const items = await wishlistService.listWishlistItems(customerId)
    sendSuccess(res, items)
  })

  router.post('/wishlist', async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    const customerId = await resolveCustomerId(new Types.ObjectId(req.auth.userId))
    const item = await wishlistService.createWishlistItem(customerId, req.body)
    sendSuccess(res, item, {}, 201)
  })

  router.delete('/wishlist/:id', async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    const id = new Types.ObjectId(objectIdSchema.parse(req.params.id))
    const customerId = await resolveCustomerId(new Types.ObjectId(req.auth.userId))
    const item = await wishlistService.archiveWishlistItem(customerId, id)
    sendSuccess(res, item)
  })

  router.get('/back-in-stock-requests', async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    const customerId = await resolveCustomerId(new Types.ObjectId(req.auth.userId))
    const requests = await backInStockRequestService.listBackInStockRequests(customerId)
    sendSuccess(res, requests)
  })

  router.post('/back-in-stock-requests', async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    const customerId = await resolveCustomerId(new Types.ObjectId(req.auth.userId))
    const request = await backInStockRequestService.createBackInStockRequest(customerId, req.body)
    sendSuccess(res, request, {}, 201)
  })

  router.delete('/back-in-stock-requests/:id', async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    const id = new Types.ObjectId(objectIdSchema.parse(req.params.id))
    const customerId = await resolveCustomerId(new Types.ObjectId(req.auth.userId))
    const request = await backInStockRequestService.cancelBackInStockRequest(customerId, id)
    sendSuccess(res, request)
  })

  return router
}
