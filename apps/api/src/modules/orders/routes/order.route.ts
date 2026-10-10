import { Router } from 'express'
import { Types } from 'mongoose'
import * as orderService from '../services/order.service.js'
import * as returnRequestService from '../../returns/services/return-request.service.js'
import { resolveCustomerId } from '../services/shared-validation.js'
import { objectIdSchema } from '../validation/common.schema.js'
import { sendSuccess } from '../../../lib/response.js'
import { UnauthenticatedError } from '../../../lib/http-errors.js'
import { createAuthenticateMiddleware } from '../../../middleware/authenticate.js'
import type { Logger } from '../../../lib/logger.js'

export interface CreateOrdersRouterOptions {
  jwtSecret: string
  logger: Logger
}

// Self-service only, mirroring cart/checkout/customers exactly: every
// handler resolves the acting customer from req.auth.userId and never from
// a client-supplied customerId. Mounted UNDER an '/orders' prefix by
// routes/v1/index.ts, so a blanket router.use(authenticate) is safe here —
// every request reaching this router has already been matched to start
// with '/orders' by the parent router (the same reasoning already applied
// to Cart's/Checkout's own routers, avoiding the no-prefix
// authenticate-scoping bug class found and fixed in COM-001).
//
// Return-request routes are nested here (/:id/returns) rather than in a
// separate router, since they share the same :id path segment — the
// handlers call across into the returns module's own service
// (returns/services/return-request.service.ts), the same one-directional
// cross-module-service-reuse pattern already used throughout this codebase
// (e.g. checkout.service.ts calling into orders' own repository).
//
// Tranche A scope only: no staff/admin route exists here (no order.*
// SEC-002 permission exists yet — deferred, see orders/README.md), and no
// return approval/rejection/receipt route exists (deferred to a future
// Tranche B alongside staff order management).
export function createOrdersRouter(options: CreateOrdersRouterOptions): Router {
  const router = Router()
  const authenticate = createAuthenticateMiddleware(options.jwtSecret)
  router.use(authenticate)

  router.get('/', async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    const customerId = await resolveCustomerId(new Types.ObjectId(req.auth.userId))
    const result = await orderService.listOrders(customerId, req.query)
    sendSuccess(res, result.items, { total: result.total })
  })

  router.get('/:id', async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    const id = new Types.ObjectId(objectIdSchema.parse(req.params.id))
    const customerId = await resolveCustomerId(new Types.ObjectId(req.auth.userId))
    const order = await orderService.getOrder(customerId, id)
    sendSuccess(res, order)
  })

  router.post('/:id/cancel', async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    const id = new Types.ObjectId(objectIdSchema.parse(req.params.id))
    const customerId = await resolveCustomerId(new Types.ObjectId(req.auth.userId))
    const order = await orderService.cancelOrder(customerId, id, req.body, options.logger)
    sendSuccess(res, order)
  })

  router.get('/:id/returns', async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    const id = new Types.ObjectId(objectIdSchema.parse(req.params.id))
    const customerId = await resolveCustomerId(new Types.ObjectId(req.auth.userId))
    const result = await returnRequestService.listReturnsForOrder(customerId, id, req.query)
    sendSuccess(res, result.items, { total: result.total })
  })

  router.post('/:id/returns', async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    const id = new Types.ObjectId(objectIdSchema.parse(req.params.id))
    const customerId = await resolveCustomerId(new Types.ObjectId(req.auth.userId))
    const returnRequest = await returnRequestService.requestReturn(
      customerId,
      id,
      req.body,
      options.logger,
    )
    sendSuccess(res, returnRequest, {}, 201)
  })

  return router
}
