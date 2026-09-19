import { Router } from 'express'
import { Types } from 'mongoose'
import * as customerService from '../services/customer.service.js'
import * as addressService from '../services/address.service.js'
import { objectIdSchema } from '../validation/common.schema.js'
import { sendSuccess } from '../../../lib/response.js'
import { UnauthenticatedError } from '../../../lib/http-errors.js'
import { createAuthenticateMiddleware } from '../../../middleware/authenticate.js'
import type { Logger } from '../../../lib/logger.js'

export interface CreateCustomersRouterOptions {
  jwtSecret: string
  logger: Logger
}

// Self-service only: every handler resolves the acting customer from
// req.auth.userId (attached by authenticate()) and never from a client-
// supplied userId/customerId — the identity boundary required by the
// approved plan. No organization context is used anywhere in this router,
// since Customer is a deliberately global entity (approved decision).
export function createCustomersRouter(options: CreateCustomersRouterOptions): Router {
  const router = Router()
  const authenticate = createAuthenticateMiddleware(options.jwtSecret)

  router.use(authenticate)

  router.get('/me', async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    const customer = await customerService.getCustomerProfile(new Types.ObjectId(req.auth.userId))
    sendSuccess(res, customer)
  })

  router.post('/me', async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    const customer = await customerService.createCustomerProfile(
      new Types.ObjectId(req.auth.userId),
      req.body,
    )
    sendSuccess(res, customer, {}, 201)
  })

  router.patch('/me', async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    const customer = await customerService.updateCustomerProfile(
      new Types.ObjectId(req.auth.userId),
      req.body,
    )
    sendSuccess(res, customer)
  })

  router.delete('/me', async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    const customer = await customerService.archiveCustomerProfile(
      new Types.ObjectId(req.auth.userId),
    )
    sendSuccess(res, customer)
  })

  router.get('/me/addresses', async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    const customer = await customerService.getCustomerProfile(new Types.ObjectId(req.auth.userId))
    const addresses = await addressService.listAddresses(customer._id)
    sendSuccess(res, addresses)
  })

  router.post('/me/addresses', async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    const customer = await customerService.getCustomerProfile(new Types.ObjectId(req.auth.userId))
    const address = await addressService.createAddress(customer._id, req.body)
    sendSuccess(res, address, {}, 201)
  })

  router.patch('/me/addresses/:id', async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    const addressId = new Types.ObjectId(objectIdSchema.parse(req.params.id))
    const customer = await customerService.getCustomerProfile(new Types.ObjectId(req.auth.userId))
    const address = await addressService.updateAddress(customer._id, addressId, req.body)
    sendSuccess(res, address)
  })

  router.delete('/me/addresses/:id', async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    const addressId = new Types.ObjectId(objectIdSchema.parse(req.params.id))
    const customer = await customerService.getCustomerProfile(new Types.ObjectId(req.auth.userId))
    const address = await addressService.archiveAddress(customer._id, addressId)
    sendSuccess(res, address)
  })

  router.post('/me/addresses/:id/default', async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    const addressId = new Types.ObjectId(objectIdSchema.parse(req.params.id))
    const customer = await customerService.getCustomerProfile(new Types.ObjectId(req.auth.userId))
    const address = await addressService.setDefaultAddress(customer._id, addressId, req.body)
    sendSuccess(res, address)
  })

  return router
}
