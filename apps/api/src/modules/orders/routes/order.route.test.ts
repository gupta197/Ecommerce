import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import type { Express } from 'express'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { loadConfig } from '../../../config/env.js'
import { createLogger } from '../../../lib/logger.js'
import { createApp } from '../../../app.js'
import { UserModel } from '../../auth/models/user.model.js'
import { SecuritySessionModel } from '../../auth/models/security-session.model.js'
import { LoginAttemptModel } from '../../auth/models/login-attempt.model.js'
import { CustomerModel } from '../../customers/models/customer.model.js'
import { OrganizationModel } from '../../organizations/models/organization.model.js'
import { OrderModel } from '../models/order.model.js'
import { ReturnRequestModel } from '../../returns/models/return-request.model.js'
import { ReturnRequestLockModel } from '../../returns/models/return-request-lock.model.js'
import { AuditEventModel } from '../../audit/models/audit-event.model.js'
import * as organizationRepository from '../../organizations/repositories/organization.repository.js'
import * as orderRepository from '../repositories/order.repository.js'
import type { CreateOrderData } from '../repositories/order.repository.js'

let replSet: MongoMemoryReplSet
let app: Express

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  await mongoose.connect(replSet.getUri(), { dbName: 'com_004_order_route_test' })

  const config = loadConfig({
    NODE_ENV: 'test',
    CORS_ORIGIN: 'http://localhost:5173',
    LOG_LEVEL: 'silent',
    MONGODB_URI: 'mongodb://localhost:27017',
    MONGODB_DB_NAME: 'com_004_order_route_test',
    JWT_ACCESS_TOKEN_SECRET: 'x'.repeat(32),
    AUTH_RATE_LIMIT_MAX: '1000',
    RATE_LIMIT_MAX: '1000',
  } as NodeJS.ProcessEnv)
  const logger = createLogger(config)
  app = createApp(config, logger)
})

after(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

beforeEach(async () => {
  await Promise.all([
    UserModel.deleteMany({}),
    SecuritySessionModel.deleteMany({}),
    LoginAttemptModel.deleteMany({}),
    CustomerModel.deleteMany({}),
    OrganizationModel.deleteMany({}),
    OrderModel.deleteMany({}),
    ReturnRequestModel.deleteMany({}),
    ReturnRequestLockModel.deleteMany({}),
    AuditEventModel.deleteMany({}),
  ])
})

function oid(): Types.ObjectId {
  return new Types.ObjectId()
}

function extractCookieHeader(res: request.Response): string {
  const raw = res.headers['set-cookie']
  const setCookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : []
  return setCookies.map((c) => c.split(';')[0]).join('; ')
}

const PASSWORD = 'correct-password-123'

async function registerLoginAndCreateProfile(
  email: string,
  password: string,
): Promise<{ cookie: string; customerId: Types.ObjectId }> {
  await request(app).post('/api/v1/auth/register').send({ email, password })
  const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password })
  const cookie = extractCookieHeader(loginRes)
  const profileRes = await request(app)
    .post('/api/v1/customers/me')
    .set('Cookie', cookie)
    .send({ firstName: 'Ada', lastName: 'Lovelace' })
  return { cookie, customerId: new Types.ObjectId(profileRes.body.data._id) }
}

function baseAddress() {
  return {
    recipientName: 'Ada Lovelace',
    line1: '1 Analytical Engine Way',
    city: 'London',
    state: 'London',
    postalCode: 'AB1 2CD',
    country: 'UK',
  }
}

async function createRealOrder(
  overrides: Partial<CreateOrderData> & { variantId?: Types.ObjectId; quantity?: number } = {},
) {
  const variantId = overrides.variantId ?? oid()
  return orderRepository.create({
    customerId: overrides.customerId ?? oid(),
    organizationId: overrides.organizationId ?? oid(),
    items: overrides.items ?? [
      {
        variantId,
        productId: oid(),
        name: 'Widget',
        sku: 'SKU-1',
        price: 100,
        quantity: overrides.quantity ?? 3,
        subtotal: 300,
      },
    ],
    subtotal: 300,
    total: 300,
    status: overrides.status ?? 'PENDING_PAYMENT',
    shippingAddress: overrides.shippingAddress ?? baseAddress(),
    billingAddress: overrides.billingAddress ?? baseAddress(),
  })
}

// ---------------------------------------------------------------------------
// Authentication boundary
// ---------------------------------------------------------------------------

test('every order/return route requires authentication', async () => {
  assert.equal((await request(app).get('/api/v1/orders')).status, 401)
  assert.equal((await request(app).get('/api/v1/orders/000000000000000000000000')).status, 401)
  assert.equal(
    (await request(app).post('/api/v1/orders/000000000000000000000000/cancel').send({})).status,
    401,
  )
  assert.equal(
    (await request(app).get('/api/v1/orders/000000000000000000000000/returns')).status,
    401,
  )
  assert.equal(
    (await request(app).post('/api/v1/orders/000000000000000000000000/returns').send({})).status,
    401,
  )
})

// ---------------------------------------------------------------------------
// List / get
// ---------------------------------------------------------------------------

test("GET /orders returns only the caller's own orders", async () => {
  const { cookie, customerId } = await registerLoginAndCreateProfile(
    'ordersmine@example.com',
    PASSWORD,
  )
  await createRealOrder({ customerId })
  await createRealOrder({ customerId: oid() })

  const res = await request(app).get('/api/v1/orders').set('Cookie', cookie)
  assert.equal(res.status, 200)
  assert.equal(res.body.data.length, 1)
  assert.equal(res.body.meta.total, 1)
})

test('GET /orders/:id returns the order detail', async () => {
  const { cookie, customerId } = await registerLoginAndCreateProfile(
    'ordersdetail@example.com',
    PASSWORD,
  )
  const order = await createRealOrder({ customerId })

  const res = await request(app).get(`/api/v1/orders/${order._id.toString()}`).set('Cookie', cookie)
  assert.equal(res.status, 200)
  assert.equal(res.body.data._id, order._id.toString())
  assert.equal(res.body.data.items[0].name, 'Widget')
})

test("GET /orders/:id returns 404 for another customer's order (IDOR, no enumeration)", async () => {
  const { cookie: cookieA } = await registerLoginAndCreateProfile(
    'ordersidorA@example.com',
    PASSWORD,
  )
  const { customerId: customerB } = await registerLoginAndCreateProfile(
    'ordersidorB@example.com',
    PASSWORD,
  )
  const order = await createRealOrder({ customerId: customerB })

  const res = await request(app)
    .get(`/api/v1/orders/${order._id.toString()}`)
    .set('Cookie', cookieA)
  assert.equal(res.status, 404)
})

test('a malformed order id in the URL is rejected before any DB lookup', async () => {
  const { cookie } = await registerLoginAndCreateProfile('ordersmalformed@example.com', PASSWORD)
  const res = await request(app).get('/api/v1/orders/not-an-object-id').set('Cookie', cookie)
  assert.equal(res.status, 422)
})

test('GET /orders rejects a Mongo-operator-shaped status filter', async () => {
  const { cookie } = await registerLoginAndCreateProfile('ordersop@example.com', PASSWORD)
  const res = await request(app).get('/api/v1/orders?status[$ne]=x').set('Cookie', cookie)
  assert.equal(res.status, 422)
})

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

test('POST /orders/:id/cancel cancels an eligible order', async () => {
  const { cookie, customerId } = await registerLoginAndCreateProfile(
    'orderscancel@example.com',
    PASSWORD,
  )
  const order = await createRealOrder({ customerId })

  const res = await request(app)
    .post(`/api/v1/orders/${order._id.toString()}/cancel`)
    .set('Cookie', cookie)
    .send({ reason: 'Changed my mind' })
  assert.equal(res.status, 200)
  assert.equal(res.body.data.status, 'CANCELLED')
  assert.equal(res.body.data.cancellationReason, 'Changed my mind')
})

test('POST /orders/:id/cancel rejects an order that is no longer cancellable', async () => {
  const { cookie, customerId } = await registerLoginAndCreateProfile(
    'orderscancelfail@example.com',
    PASSWORD,
  )
  const order = await createRealOrder({ customerId, status: 'SHIPPED' })

  const res = await request(app)
    .post(`/api/v1/orders/${order._id.toString()}/cancel`)
    .set('Cookie', cookie)
    .send({})
  assert.equal(res.status, 422)
})

test("a customer cannot cancel another customer's order (IDOR)", async () => {
  const { cookie: cookieA } = await registerLoginAndCreateProfile(
    'orderscancelidorA@example.com',
    PASSWORD,
  )
  const { customerId: customerB } = await registerLoginAndCreateProfile(
    'orderscancelidorB@example.com',
    PASSWORD,
  )
  const order = await createRealOrder({ customerId: customerB })

  const res = await request(app)
    .post(`/api/v1/orders/${order._id.toString()}/cancel`)
    .set('Cookie', cookieA)
    .send({})
  assert.equal(res.status, 404)
  const current = await OrderModel.findById(order._id)
  assert.equal(current?.status, 'PENDING_PAYMENT')
})

test('POST /orders/:id/cancel rejects mass-assignment of status/customerId', async () => {
  const { cookie, customerId } = await registerLoginAndCreateProfile(
    'orderscancelmass@example.com',
    PASSWORD,
  )
  const order = await createRealOrder({ customerId })

  const res = await request(app)
    .post(`/api/v1/orders/${order._id.toString()}/cancel`)
    .set('Cookie', cookie)
    .send({ status: 'DELIVERED', customerId: oid().toString() })
  assert.equal(res.status, 422)
})

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

test('POST /orders/:id/returns creates a return request for a delivered order', async () => {
  const { cookie, customerId } = await registerLoginAndCreateProfile(
    'ordersreturn@example.com',
    PASSWORD,
  )
  const variantId = oid()
  const order = await createRealOrder({ customerId, variantId, status: 'DELIVERED', quantity: 2 })

  const res = await request(app)
    .post(`/api/v1/orders/${order._id.toString()}/returns`)
    .set('Cookie', cookie)
    .send({ items: [{ variantId: variantId.toString(), quantity: 1 }], reason: 'Wrong size' })
  assert.equal(res.status, 201)
  assert.equal(res.body.data.status, 'PENDING')
})

test('POST /orders/:id/returns rejects a return for a non-delivered order', async () => {
  const { cookie, customerId } = await registerLoginAndCreateProfile(
    'ordersreturnfail@example.com',
    PASSWORD,
  )
  const variantId = oid()
  const order = await createRealOrder({ customerId, variantId, status: 'SHIPPED' })

  const res = await request(app)
    .post(`/api/v1/orders/${order._id.toString()}/returns`)
    .set('Cookie', cookie)
    .send({ items: [{ variantId: variantId.toString(), quantity: 1 }], reason: 'Wrong size' })
  assert.equal(res.status, 422)
})

test("a customer cannot request a return against another customer's order (IDOR)", async () => {
  const { cookie: cookieA } = await registerLoginAndCreateProfile(
    'ordersreturnidorA@example.com',
    PASSWORD,
  )
  const { customerId: customerB } = await registerLoginAndCreateProfile(
    'ordersreturnidorB@example.com',
    PASSWORD,
  )
  const variantId = oid()
  const order = await createRealOrder({ customerId: customerB, variantId, status: 'DELIVERED' })

  const res = await request(app)
    .post(`/api/v1/orders/${order._id.toString()}/returns`)
    .set('Cookie', cookieA)
    .send({ items: [{ variantId: variantId.toString(), quantity: 1 }], reason: 'Test' })
  assert.equal(res.status, 404)
})

test("GET /orders/:id/returns lists the order's own return requests", async () => {
  const { cookie, customerId } = await registerLoginAndCreateProfile(
    'ordersreturnlist@example.com',
    PASSWORD,
  )
  const variantId = oid()
  const order = await createRealOrder({ customerId, variantId, status: 'DELIVERED', quantity: 2 })
  await request(app)
    .post(`/api/v1/orders/${order._id.toString()}/returns`)
    .set('Cookie', cookie)
    .send({ items: [{ variantId: variantId.toString(), quantity: 1 }], reason: 'Test' })

  const res = await request(app)
    .get(`/api/v1/orders/${order._id.toString()}/returns`)
    .set('Cookie', cookie)
  assert.equal(res.status, 200)
  assert.equal(res.body.data.length, 1)
})

test('POST /orders/:id/returns rejects mass-assignment of status/customerId/orderId', async () => {
  const { cookie, customerId } = await registerLoginAndCreateProfile(
    'ordersreturnmass@example.com',
    PASSWORD,
  )
  const variantId = oid()
  const order = await createRealOrder({ customerId, variantId, status: 'DELIVERED' })

  const res = await request(app)
    .post(`/api/v1/orders/${order._id.toString()}/returns`)
    .set('Cookie', cookie)
    .send({
      items: [{ variantId: variantId.toString(), quantity: 1 }],
      reason: 'Test',
      status: 'APPROVED',
      customerId: oid().toString(),
    })
  assert.equal(res.status, 422)
})

test('POST /orders/:id/returns rejects a Mongo-operator-shaped variantId', async () => {
  const { cookie, customerId } = await registerLoginAndCreateProfile(
    'ordersreturnop@example.com',
    PASSWORD,
  )
  const order = await createRealOrder({ customerId, status: 'DELIVERED' })

  const res = await request(app)
    .post(`/api/v1/orders/${order._id.toString()}/returns`)
    .set('Cookie', cookie)
    .send({ items: [{ variantId: { $gt: '' }, quantity: 1 }], reason: 'Test' })
  assert.equal(res.status, 422)
})

test('POST /orders/:id/returns rejects a quantity exceeding the purchased amount', async () => {
  const { cookie, customerId } = await registerLoginAndCreateProfile(
    'ordersreturnqty@example.com',
    PASSWORD,
  )
  const variantId = oid()
  const order = await createRealOrder({ customerId, variantId, status: 'DELIVERED', quantity: 2 })

  const res = await request(app)
    .post(`/api/v1/orders/${order._id.toString()}/returns`)
    .set('Cookie', cookie)
    .send({ items: [{ variantId: variantId.toString(), quantity: 5 }], reason: 'Test' })
  assert.equal(res.status, 422)
})

// ---------------------------------------------------------------------------
// No staff/admin route exists in this tranche
// ---------------------------------------------------------------------------

test('no staff/admin order-management route exists under /organizations in this tranche', async () => {
  const { cookie } = await registerLoginAndCreateProfile('ordersnostaff@example.com', PASSWORD)
  const organization = await organizationRepository.create({
    name: 'Acme Inc',
    status: 'ACTIVE',
    activeOwnerCount: 1,
  })
  // Authenticated (so a 404 here can only mean "no such route", not "not
  // logged in") — organizations' own router applies a blanket authenticate
  // since it is itself a prefixed mount, so an authenticated request is
  // required to distinguish "route doesn't exist" from "not authenticated".
  const res = await request(app)
    .get(`/api/v1/organizations/${organization._id.toString()}/orders`)
    .set('Cookie', cookie)
  assert.equal(res.status, 404)
})

// ---------------------------------------------------------------------------
// Standardized errors / route regression
// ---------------------------------------------------------------------------

test('an unrelated, unmatched route still returns the standardized 404 envelope (route mounting regression check)', async () => {
  const res = await request(app).get('/api/v1/this-route-does-not-exist')
  assert.equal(res.status, 404)
  assert.equal(res.body.success, false)
})

test('a validation failure returns the standardized error envelope, not a 500', async () => {
  const { cookie, customerId } = await registerLoginAndCreateProfile(
    'ordersenvelope@example.com',
    PASSWORD,
  )
  const order = await createRealOrder({ customerId, status: 'DELIVERED' })
  const res = await request(app)
    .post(`/api/v1/orders/${order._id.toString()}/returns`)
    .set('Cookie', cookie)
    .send({ items: [], reason: 'Test' })
  assert.equal(res.status, 422)
  assert.equal(res.body.success, false)
  assert.equal(res.body.error.code, 'VALIDATION_ERROR')
})
