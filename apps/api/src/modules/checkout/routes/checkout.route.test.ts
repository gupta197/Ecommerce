import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import type { Express } from 'express'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import mongoose, { type Types } from 'mongoose'
import { loadConfig } from '../../../config/env.js'
import { createLogger } from '../../../lib/logger.js'
import { createApp } from '../../../app.js'
import { UserModel } from '../../auth/models/user.model.js'
import { SecuritySessionModel } from '../../auth/models/security-session.model.js'
import { LoginAttemptModel } from '../../auth/models/login-attempt.model.js'
import { CustomerModel } from '../../customers/models/customer.model.js'
import { AddressModel } from '../../customers/models/address.model.js'
import { OrganizationModel } from '../../organizations/models/organization.model.js'
import { ProductModel } from '../../catalog/models/product.model.js'
import { ProductVariantModel } from '../../catalog/models/product-variant.model.js'
import { CartModel } from '../../cart/models/cart.model.js'
import { CartItemModel } from '../../cart/models/cart-item.model.js'
import { StockBalanceModel } from '../../inventory/models/stock-balance.model.js'
import { LocationModel } from '../../inventory/models/location.model.js'
import { InventoryTransactionModel } from '../../inventory/models/inventory-transaction.model.js'
import { OrderModel } from '../../orders/models/order.model.js'
import * as organizationRepository from '../../organizations/repositories/organization.repository.js'
import * as productRepository from '../../catalog/repositories/product.repository.js'
import * as productVariantRepository from '../../catalog/repositories/product-variant.repository.js'
import * as stockBalanceRepository from '../../inventory/repositories/stock-balance.repository.js'
import * as locationRepository from '../../inventory/repositories/location.repository.js'

// A replica set is required — POST /api/v1/checkout uses withTransaction(),
// which a standalone MongoMemoryServer cannot run (mirrors CUST-001's own
// customer.route.test.ts requirement for setDefaultAddress).
let replSet: MongoMemoryReplSet
let app: Express

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  await mongoose.connect(replSet.getUri(), { dbName: 'com_003_checkout_route_test' })

  const config = loadConfig({
    NODE_ENV: 'test',
    CORS_ORIGIN: 'http://localhost:5173',
    LOG_LEVEL: 'silent',
    MONGODB_URI: 'mongodb://localhost:27017',
    MONGODB_DB_NAME: 'com_003_checkout_route_test',
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
    AddressModel.deleteMany({}),
    OrganizationModel.deleteMany({}),
    ProductModel.deleteMany({}),
    ProductVariantModel.deleteMany({}),
    CartModel.deleteMany({}),
    CartItemModel.deleteMany({}),
    StockBalanceModel.deleteMany({}),
    LocationModel.deleteMany({}),
    InventoryTransactionModel.deleteMany({}),
    OrderModel.deleteMany({}),
  ])
})

function extractCookieHeader(res: request.Response): string {
  const raw = res.headers['set-cookie']
  const setCookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : []
  return setCookies.map((c) => c.split(';')[0]).join('; ')
}

async function registerLoginAndCreateProfile(email: string, password: string): Promise<string> {
  await request(app).post('/api/v1/auth/register').send({ email, password })
  const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password })
  const cookie = extractCookieHeader(loginRes)
  await request(app)
    .post('/api/v1/customers/me')
    .set('Cookie', cookie)
    .send({ firstName: 'Ada', lastName: 'Lovelace' })
  return cookie
}

const PASSWORD = 'correct-password-123'

async function createRealOrgAndVariant(price = 100) {
  const organization = await organizationRepository.create({
    name: 'Acme Inc',
    status: 'ACTIVE',
    activeOwnerCount: 1,
  })
  const product = await productRepository.create({
    organizationId: organization._id,
    name: 'Real Product',
    slug: `real-product-${organization._id.toString()}`,
    status: 'ACTIVE',
  })
  const variant = await productVariantRepository.create({
    organizationId: organization._id,
    productId: product._id,
    sku: `SKU-${organization._id.toString()}`,
    price,
    status: 'ACTIVE',
  })
  return { organization, variant }
}

async function giveStock(
  organizationId: Types.ObjectId,
  variantId: Types.ObjectId,
  quantity: number,
) {
  const location = await locationRepository.create({
    organizationId,
    name: 'Warehouse',
    status: 'ACTIVE',
  })
  const session = await mongoose.startSession()
  try {
    await stockBalanceRepository.incrementOrCreate(
      { organizationId, locationId: location._id, variantId },
      quantity,
      session,
    )
  } finally {
    await session.endSession()
  }
}

async function addToCartViaRoute(
  cookie: string,
  organizationId: string,
  variantId: string,
  quantity: number,
) {
  return request(app)
    .post('/api/v1/cart/items')
    .set('Cookie', cookie)
    .send({ organizationId, variantId, quantity })
}

async function setDefaultShippingAddress(cookie: string): Promise<string> {
  const res = await request(app).post('/api/v1/customers/me/addresses').set('Cookie', cookie).send({
    recipientName: 'Ada Lovelace',
    line1: '1 Analytical Engine Way',
    city: 'London',
    state: 'London',
    postalCode: 'AB1 2CD',
    country: 'UK',
  })
  const addressId = res.body.data._id
  await request(app)
    .post(`/api/v1/customers/me/addresses/${addressId}/default`)
    .set('Cookie', cookie)
    .send({ type: 'shipping' })
  return addressId
}

// ---------------------------------------------------------------------------
// Authentication boundary
// ---------------------------------------------------------------------------

test('every checkout route requires authentication', async () => {
  assert.equal((await request(app).post('/api/v1/checkout/preview').send({})).status, 401)
  assert.equal((await request(app).post('/api/v1/checkout').send({})).status, 401)
})

// ---------------------------------------------------------------------------
// Full flow
// ---------------------------------------------------------------------------

test('full checkout flow via routes: add to cart, preview, confirm, cart cleared', async () => {
  const cookie = await registerLoginAndCreateProfile('checkoutflow@example.com', PASSWORD)
  const { organization, variant } = await createRealOrgAndVariant(250)
  await giveStock(organization._id, variant._id, 10)
  await addToCartViaRoute(cookie, organization._id.toString(), variant._id.toString(), 2)
  await setDefaultShippingAddress(cookie)

  const preview = await request(app)
    .post('/api/v1/checkout/preview')
    .set('Cookie', cookie)
    .send({ organizationId: organization._id.toString() })
  assert.equal(preview.status, 200)
  assert.equal(preview.body.data.subtotal, 500)
  assert.equal(preview.body.data.total, 500)
  assert.equal(preview.body.data.items.length, 1)

  const confirm = await request(app)
    .post('/api/v1/checkout')
    .set('Cookie', cookie)
    .send({ organizationId: organization._id.toString() })
  assert.equal(confirm.status, 201)
  assert.equal(confirm.body.data.status, 'PENDING_PAYMENT')
  assert.equal(confirm.body.data.subtotal, 500)
  assert.equal(confirm.body.data.total, 500)
  assert.equal(confirm.body.data.items[0].quantity, 2)
  assert.ok(confirm.body.data.shippingAddress)
  assert.ok(confirm.body.data.billingAddress)

  const cartAfter = await request(app)
    .get(`/api/v1/cart?organizationId=${organization._id.toString()}`)
    .set('Cookie', cookie)
  assert.equal(cartAfter.body.data.items.length, 0)
})

test('preview does not create an Order or modify the Cart', async () => {
  const cookie = await registerLoginAndCreateProfile('checkoutpreview@example.com', PASSWORD)
  const { organization, variant } = await createRealOrgAndVariant()
  await giveStock(organization._id, variant._id, 10)
  await addToCartViaRoute(cookie, organization._id.toString(), variant._id.toString(), 1)
  await setDefaultShippingAddress(cookie)

  await request(app)
    .post('/api/v1/checkout/preview')
    .set('Cookie', cookie)
    .send({ organizationId: organization._id.toString() })

  assert.equal(await OrderModel.countDocuments({}), 0)
  const cartAfter = await request(app)
    .get(`/api/v1/cart?organizationId=${organization._id.toString()}`)
    .set('Cookie', cookie)
  assert.equal(cartAfter.body.data.items.length, 1)
})

// ---------------------------------------------------------------------------
// Validation / mass-assignment / injection
// ---------------------------------------------------------------------------

test('POST /checkout rejects mass-assignment of customerId/price/subtotal/total/status/orderId', async () => {
  const cookie = await registerLoginAndCreateProfile('checkoutmass@example.com', PASSWORD)
  const { organization, variant } = await createRealOrgAndVariant()
  await giveStock(organization._id, variant._id, 10)
  await addToCartViaRoute(cookie, organization._id.toString(), variant._id.toString(), 1)
  await setDefaultShippingAddress(cookie)

  const res = await request(app).post('/api/v1/checkout').set('Cookie', cookie).send({
    organizationId: organization._id.toString(),
    customerId: '000000000000000000000000',
    price: 1,
    subtotal: 1,
    total: 1,
    status: 'PENDING_PAYMENT',
    orderId: '000000000000000000000000',
  })
  assert.equal(res.status, 422)
  assert.equal(await OrderModel.countDocuments({}), 0)
})

test('POST /checkout/preview rejects a Mongo-operator-shaped organizationId', async () => {
  const cookie = await registerLoginAndCreateProfile('checkoutop@example.com', PASSWORD)
  const res = await request(app)
    .post('/api/v1/checkout/preview')
    .set('Cookie', cookie)
    .send({ organizationId: { $gt: '' } })
  assert.equal(res.status, 422)
})

test('a forged shippingAddressId that is not a valid ObjectId is rejected', async () => {
  const cookie = await registerLoginAndCreateProfile('checkoutforged@example.com', PASSWORD)
  const { organization } = await createRealOrgAndVariant()
  const res = await request(app)
    .post('/api/v1/checkout/preview')
    .set('Cookie', cookie)
    .send({ organizationId: organization._id.toString(), shippingAddressId: 'not-an-object-id' })
  assert.equal(res.status, 422)
})

test('checkout on a nonexistent organization returns 422, not a 500', async () => {
  const cookie = await registerLoginAndCreateProfile('checkoutnoorg@example.com', PASSWORD)
  const res = await request(app)
    .post('/api/v1/checkout/preview')
    .set('Cookie', cookie)
    .send({ organizationId: '000000000000000000000000' })
  assert.equal(res.status, 422)
})

// ---------------------------------------------------------------------------
// IDOR
// ---------------------------------------------------------------------------

test("a customer cannot check out another customer's cart (cross-customer isolation)", async () => {
  const cookieA = await registerLoginAndCreateProfile('checkoutIdorA@example.com', PASSWORD)
  const cookieB = await registerLoginAndCreateProfile('checkoutIdorB@example.com', PASSWORD)
  const { organization, variant } = await createRealOrgAndVariant()
  await giveStock(organization._id, variant._id, 10)
  await addToCartViaRoute(cookieA, organization._id.toString(), variant._id.toString(), 1)
  await setDefaultShippingAddress(cookieB)

  // Customer B has no cart items in this organization — B's own checkout
  // must fail as "empty cart," never see or consume A's cart.
  const res = await request(app)
    .post('/api/v1/checkout')
    .set('Cookie', cookieB)
    .send({ organizationId: organization._id.toString() })
  assert.equal(res.status, 422)
  assert.equal(await OrderModel.countDocuments({}), 0)
})

test("a customer's own address cannot be used by another customer's checkout (IDOR)", async () => {
  const cookieA = await registerLoginAndCreateProfile('checkoutAddrA@example.com', PASSWORD)
  const cookieB = await registerLoginAndCreateProfile('checkoutAddrB@example.com', PASSWORD)
  const { organization, variant } = await createRealOrgAndVariant()
  await giveStock(organization._id, variant._id, 10)
  await addToCartViaRoute(cookieB, organization._id.toString(), variant._id.toString(), 1)

  const addressResA = await request(app)
    .post('/api/v1/customers/me/addresses')
    .set('Cookie', cookieA)
    .send({
      recipientName: 'Ada',
      line1: 'Line 1',
      city: 'City',
      state: 'State',
      postalCode: '00000',
      country: 'UK',
    })
  const addressIdA = addressResA.body.data._id

  const res = await request(app)
    .post('/api/v1/checkout')
    .set('Cookie', cookieB)
    .send({ organizationId: organization._id.toString(), shippingAddressId: addressIdA })
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

test('an insufficient-stock checkout returns the standardized error envelope', async () => {
  const cookie = await registerLoginAndCreateProfile('checkoutstock@example.com', PASSWORD)
  const { organization, variant } = await createRealOrgAndVariant()
  await addToCartViaRoute(cookie, organization._id.toString(), variant._id.toString(), 1)
  await setDefaultShippingAddress(cookie)

  const res = await request(app)
    .post('/api/v1/checkout')
    .set('Cookie', cookie)
    .send({ organizationId: organization._id.toString() })
  assert.equal(res.status, 422)
  assert.equal(res.body.success, false)
  assert.equal(res.body.error.code, 'VALIDATION_ERROR')
})
