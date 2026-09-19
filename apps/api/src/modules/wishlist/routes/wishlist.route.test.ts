import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import type { Express } from 'express'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose from 'mongoose'
import { loadConfig } from '../../../config/env.js'
import { createLogger } from '../../../lib/logger.js'
import { createApp } from '../../../app.js'
import { UserModel } from '../../auth/models/user.model.js'
import { SecuritySessionModel } from '../../auth/models/security-session.model.js'
import { LoginAttemptModel } from '../../auth/models/login-attempt.model.js'
import { CustomerModel } from '../../customers/models/customer.model.js'
import { OrganizationModel } from '../../organizations/models/organization.model.js'
import { ProductModel } from '../../catalog/models/product.model.js'
import { ProductVariantModel } from '../../catalog/models/product-variant.model.js'
import { WishlistItemModel } from '../models/wishlist-item.model.js'
import { BackInStockRequestModel } from '../models/back-in-stock-request.model.js'
import * as organizationRepository from '../../organizations/repositories/organization.repository.js'
import * as productRepository from '../../catalog/repositories/product.repository.js'
import * as productVariantRepository from '../../catalog/repositories/product-variant.repository.js'

// No transaction is used anywhere in the wishlist module — a standalone
// MongoMemoryServer is sufficient (unlike organization/customer route
// tests that exercise a genuine multi-document transaction).
let mongod: MongoMemoryServer
let app: Express

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'com_001_wishlist_route_test' })

  const config = loadConfig({
    NODE_ENV: 'test',
    CORS_ORIGIN: 'http://localhost:5173',
    LOG_LEVEL: 'silent',
    MONGODB_URI: 'mongodb://localhost:27017',
    MONGODB_DB_NAME: 'com_001_wishlist_route_test',
    JWT_ACCESS_TOKEN_SECRET: 'x'.repeat(32),
    AUTH_RATE_LIMIT_MAX: '1000',
    RATE_LIMIT_MAX: '1000',
  } as NodeJS.ProcessEnv)
  const logger = createLogger(config)
  app = createApp(config, logger)
})

after(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await Promise.all([
    UserModel.deleteMany({}),
    SecuritySessionModel.deleteMany({}),
    LoginAttemptModel.deleteMany({}),
    CustomerModel.deleteMany({}),
    OrganizationModel.deleteMany({}),
    ProductModel.deleteMany({}),
    ProductVariantModel.deleteMany({}),
    WishlistItemModel.deleteMany({}),
    BackInStockRequestModel.deleteMany({}),
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

async function createRealOrgAndVariant() {
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
    price: 100,
    status: 'ACTIVE',
  })
  return { organization, variant }
}

// ---------------------------------------------------------------------------
// Authentication boundary
// ---------------------------------------------------------------------------

test('every wishlist/back-in-stock route requires authentication', async () => {
  assert.equal((await request(app).get('/api/v1/wishlist')).status, 401)
  assert.equal((await request(app).post('/api/v1/wishlist').send({})).status, 401)
  assert.equal((await request(app).delete('/api/v1/wishlist/000000000000000000000000')).status, 401)
  assert.equal((await request(app).get('/api/v1/back-in-stock-requests')).status, 401)
  assert.equal((await request(app).post('/api/v1/back-in-stock-requests').send({})).status, 401)
  assert.equal(
    (await request(app).delete('/api/v1/back-in-stock-requests/000000000000000000000000')).status,
    401,
  )
})

// ---------------------------------------------------------------------------
// Wishlist lifecycle
// ---------------------------------------------------------------------------

test('full wishlist lifecycle via routes: create, list, remove, re-add', async () => {
  const cookie = await registerLoginAndCreateProfile('wishlist@example.com', PASSWORD)
  const { organization, variant } = await createRealOrgAndVariant()

  const created = await request(app)
    .post('/api/v1/wishlist')
    .set('Cookie', cookie)
    .send({ organizationId: organization._id.toString(), variantId: variant._id.toString() })
  assert.equal(created.status, 201)
  assert.equal(created.body.data.status, 'ACTIVE')
  const itemId = created.body.data._id

  const list = await request(app).get('/api/v1/wishlist').set('Cookie', cookie)
  assert.equal(list.status, 200)
  assert.equal(list.body.data.length, 1)

  const removed = await request(app).delete(`/api/v1/wishlist/${itemId}`).set('Cookie', cookie)
  assert.equal(removed.status, 200)
  assert.equal(removed.body.data.status, 'ARCHIVED')

  const listAfterRemove = await request(app).get('/api/v1/wishlist').set('Cookie', cookie)
  assert.equal(listAfterRemove.body.data.length, 0)

  const readded = await request(app)
    .post('/api/v1/wishlist')
    .set('Cookie', cookie)
    .send({ organizationId: organization._id.toString(), variantId: variant._id.toString() })
  assert.equal(readded.status, 201)
})

test('POST /wishlist rejects mass-assignment of customerId/status/_id', async () => {
  const cookie = await registerLoginAndCreateProfile('wishlistmass@example.com', PASSWORD)
  const { organization, variant } = await createRealOrgAndVariant()

  const res = await request(app).post('/api/v1/wishlist').set('Cookie', cookie).send({
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    status: 'ARCHIVED',
  })
  assert.equal(res.status, 422)
})

test('POST /wishlist rejects a Mongo-operator-shaped organizationId', async () => {
  const cookie = await registerLoginAndCreateProfile('wishlistop@example.com', PASSWORD)
  const res = await request(app)
    .post('/api/v1/wishlist')
    .set('Cookie', cookie)
    .send({ organizationId: { $gt: '' }, variantId: '000000000000000000000000' })
  assert.equal(res.status, 422)
})

test("a customer cannot read or remove another customer's wishlist item (IDOR)", async () => {
  const cookieA = await registerLoginAndCreateProfile('wishlistIdorA@example.com', PASSWORD)
  const cookieB = await registerLoginAndCreateProfile('wishlistIdorB@example.com', PASSWORD)
  const { organization, variant } = await createRealOrgAndVariant()

  const created = await request(app)
    .post('/api/v1/wishlist')
    .set('Cookie', cookieA)
    .send({ organizationId: organization._id.toString(), variantId: variant._id.toString() })
  const itemId = created.body.data._id

  const listForB = await request(app).get('/api/v1/wishlist').set('Cookie', cookieB)
  assert.equal(listForB.body.data.length, 0)

  const removeAttempt = await request(app)
    .delete(`/api/v1/wishlist/${itemId}`)
    .set('Cookie', cookieB)
  assert.equal(removeAttempt.status, 404)
})

test('a malformed wishlist item id in the URL is rejected before any DB lookup', async () => {
  const cookie = await registerLoginAndCreateProfile('wishlistmalformed@example.com', PASSWORD)
  const res = await request(app).delete('/api/v1/wishlist/not-an-object-id').set('Cookie', cookie)
  assert.equal(res.status, 422)
})

// ---------------------------------------------------------------------------
// Back-in-stock lifecycle
// ---------------------------------------------------------------------------

test('full back-in-stock lifecycle via routes: create (out of stock), list, cancel, recreate', async () => {
  const cookie = await registerLoginAndCreateProfile('bisr@example.com', PASSWORD)
  const { organization, variant } = await createRealOrgAndVariant()

  const created = await request(app)
    .post('/api/v1/back-in-stock-requests')
    .set('Cookie', cookie)
    .send({ organizationId: organization._id.toString(), variantId: variant._id.toString() })
  assert.equal(created.status, 201)
  assert.equal(created.body.data.status, 'PENDING')
  const requestId = created.body.data._id

  const list = await request(app).get('/api/v1/back-in-stock-requests').set('Cookie', cookie)
  assert.equal(list.status, 200)
  assert.equal(list.body.data.length, 1)

  const cancelled = await request(app)
    .delete(`/api/v1/back-in-stock-requests/${requestId}`)
    .set('Cookie', cookie)
  assert.equal(cancelled.status, 200)
  assert.equal(cancelled.body.data.status, 'CANCELLED')

  const recreated = await request(app)
    .post('/api/v1/back-in-stock-requests')
    .set('Cookie', cookie)
    .send({ organizationId: organization._id.toString(), variantId: variant._id.toString() })
  assert.equal(recreated.status, 201)
})

test('POST /back-in-stock-requests rejects mass-assignment of customerId/status/_id', async () => {
  const cookie = await registerLoginAndCreateProfile('bisrmass@example.com', PASSWORD)
  const { organization, variant } = await createRealOrgAndVariant()

  const res = await request(app).post('/api/v1/back-in-stock-requests').set('Cookie', cookie).send({
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    status: 'PENDING',
  })
  assert.equal(res.status, 422)
})

test("a customer cannot read or cancel another customer's back-in-stock request (IDOR)", async () => {
  const cookieA = await registerLoginAndCreateProfile('bisrIdorA@example.com', PASSWORD)
  const cookieB = await registerLoginAndCreateProfile('bisrIdorB@example.com', PASSWORD)
  const { organization, variant } = await createRealOrgAndVariant()

  const created = await request(app)
    .post('/api/v1/back-in-stock-requests')
    .set('Cookie', cookieA)
    .send({ organizationId: organization._id.toString(), variantId: variant._id.toString() })
  const requestId = created.body.data._id

  const listForB = await request(app).get('/api/v1/back-in-stock-requests').set('Cookie', cookieB)
  assert.equal(listForB.body.data.length, 0)

  const cancelAttempt = await request(app)
    .delete(`/api/v1/back-in-stock-requests/${requestId}`)
    .set('Cookie', cookieB)
  assert.equal(cancelAttempt.status, 404)
})

test('a malformed back-in-stock request id in the URL is rejected before any DB lookup', async () => {
  const cookie = await registerLoginAndCreateProfile('bisrmalformed@example.com', PASSWORD)
  const res = await request(app)
    .delete('/api/v1/back-in-stock-requests/not-an-object-id')
    .set('Cookie', cookie)
  assert.equal(res.status, 422)
})

test('POST /back-in-stock-requests validation failure on a nonexistent organization returns a generic error, not a 500', async () => {
  const cookie = await registerLoginAndCreateProfile('bisrnoorg@example.com', PASSWORD)
  const res = await request(app)
    .post('/api/v1/back-in-stock-requests')
    .set('Cookie', cookie)
    .send({ organizationId: '000000000000000000000000', variantId: '000000000000000000000000' })
  assert.equal(res.status, 422)
})
