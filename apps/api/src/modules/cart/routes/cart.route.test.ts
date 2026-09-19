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
import { CartModel } from '../models/cart.model.js'
import { CartItemModel } from '../models/cart-item.model.js'
import * as organizationRepository from '../../organizations/repositories/organization.repository.js'
import * as productRepository from '../../catalog/repositories/product.repository.js'
import * as productVariantRepository from '../../catalog/repositories/product-variant.repository.js'

// No transaction is used anywhere in the cart module — a standalone
// MongoMemoryServer is sufficient (unlike organization/customer route
// tests that exercise a genuine multi-document transaction).
let mongod: MongoMemoryServer
let app: Express

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'com_002_cart_route_test' })

  const config = loadConfig({
    NODE_ENV: 'test',
    CORS_ORIGIN: 'http://localhost:5173',
    LOG_LEVEL: 'silent',
    MONGODB_URI: 'mongodb://localhost:27017',
    MONGODB_DB_NAME: 'com_002_cart_route_test',
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
    CartModel.deleteMany({}),
    CartItemModel.deleteMany({}),
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

// ---------------------------------------------------------------------------
// Authentication boundary
// ---------------------------------------------------------------------------

test('every cart route requires authentication', async () => {
  assert.equal(
    (await request(app).get('/api/v1/cart?organizationId=000000000000000000000000')).status,
    401,
  )
  assert.equal((await request(app).post('/api/v1/cart/items').send({})).status, 401)
  assert.equal(
    (await request(app).patch('/api/v1/cart/items/000000000000000000000000').send({ quantity: 1 }))
      .status,
    401,
  )
  assert.equal(
    (await request(app).delete('/api/v1/cart/items/000000000000000000000000')).status,
    401,
  )
  assert.equal(
    (await request(app).delete('/api/v1/cart?organizationId=000000000000000000000000')).status,
    401,
  )
})

// ---------------------------------------------------------------------------
// GET must not create a Cart
// ---------------------------------------------------------------------------

test('GET /cart on a customer with no cart yet returns an empty cart and creates nothing', async () => {
  const cookie = await registerLoginAndCreateProfile('cartempty@example.com', PASSWORD)
  const { organization } = await createRealOrgAndVariant()

  const res = await request(app)
    .get(`/api/v1/cart?organizationId=${organization._id.toString()}`)
    .set('Cookie', cookie)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.data.items, [])
  assert.equal(res.body.data.total, 0)
  assert.equal(await CartModel.countDocuments({}), 0)
})

// ---------------------------------------------------------------------------
// Full lifecycle
// ---------------------------------------------------------------------------

test('full cart lifecycle via routes: add, get, increment, patch, remove, clear', async () => {
  const cookie = await registerLoginAndCreateProfile('cartlifecycle@example.com', PASSWORD)
  const { organization, variant } = await createRealOrgAndVariant(250)

  const added = await request(app).post('/api/v1/cart/items').set('Cookie', cookie).send({
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    quantity: 2,
  })
  assert.equal(added.status, 201)
  assert.equal(added.body.data.quantity, 2)
  const itemId = added.body.data._id

  const getRes = await request(app)
    .get(`/api/v1/cart?organizationId=${organization._id.toString()}`)
    .set('Cookie', cookie)
  assert.equal(getRes.status, 200)
  assert.equal(getRes.body.data.items.length, 1)
  assert.equal(getRes.body.data.items[0].price, 250)
  assert.equal(getRes.body.data.items[0].subtotal, 500)
  assert.equal(getRes.body.data.total, 500)

  const incremented = await request(app).post('/api/v1/cart/items').set('Cookie', cookie).send({
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    quantity: 3,
  })
  assert.equal(incremented.status, 201)
  assert.equal(incremented.body.data.quantity, 5)
  assert.equal(incremented.body.data._id, itemId)

  const patched = await request(app)
    .patch(`/api/v1/cart/items/${itemId}`)
    .set('Cookie', cookie)
    .send({ quantity: 10 })
  assert.equal(patched.status, 200)
  assert.equal(patched.body.data.quantity, 10)

  const removed = await request(app).delete(`/api/v1/cart/items/${itemId}`).set('Cookie', cookie)
  assert.equal(removed.status, 200)

  const emptyAfterRemove = await request(app)
    .get(`/api/v1/cart?organizationId=${organization._id.toString()}`)
    .set('Cookie', cookie)
  assert.equal(emptyAfterRemove.body.data.items.length, 0)

  const readded = await request(app).post('/api/v1/cart/items').set('Cookie', cookie).send({
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    quantity: 1,
  })
  assert.equal(readded.status, 201)

  const cleared = await request(app)
    .delete(`/api/v1/cart?organizationId=${organization._id.toString()}`)
    .set('Cookie', cookie)
  assert.equal(cleared.status, 200)
  assert.deepEqual(cleared.body.data.items, [])

  const afterClear = await request(app)
    .get(`/api/v1/cart?organizationId=${organization._id.toString()}`)
    .set('Cookie', cookie)
  assert.equal(afterClear.body.data.items.length, 0)
})

// ---------------------------------------------------------------------------
// 9999 ceiling via HTTP
// ---------------------------------------------------------------------------

test('POST /cart/items: 9990 + 20 is rejected (422), 9990 + 9 succeeds at 9999', async () => {
  const cookie = await registerLoginAndCreateProfile('cartceiling@example.com', PASSWORD)
  const { organization, variant } = await createRealOrgAndVariant()

  await request(app).post('/api/v1/cart/items').set('Cookie', cookie).send({
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    quantity: 9990,
  })

  const rejected = await request(app).post('/api/v1/cart/items').set('Cookie', cookie).send({
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    quantity: 20,
  })
  assert.equal(rejected.status, 422)

  const stillAt9990 = await request(app)
    .get(`/api/v1/cart?organizationId=${organization._id.toString()}`)
    .set('Cookie', cookie)
  assert.equal(stillAt9990.body.data.items[0].quantity, 9990)

  const succeeded = await request(app).post('/api/v1/cart/items').set('Cookie', cookie).send({
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    quantity: 9,
  })
  assert.equal(succeeded.status, 201)
  assert.equal(succeeded.body.data.quantity, 9999)
})

// ---------------------------------------------------------------------------
// Validation / mass-assignment / injection
// ---------------------------------------------------------------------------

test('POST /cart/items rejects mass-assignment of customerId/cartId/price/subtotal/total', async () => {
  const cookie = await registerLoginAndCreateProfile('cartmass@example.com', PASSWORD)
  const { organization, variant } = await createRealOrgAndVariant()

  const res = await request(app).post('/api/v1/cart/items').set('Cookie', cookie).send({
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    quantity: 1,
    price: 1,
    subtotal: 1,
    total: 1,
  })
  assert.equal(res.status, 422)
})

test('POST /cart/items rejects a Mongo-operator-shaped organizationId', async () => {
  const cookie = await registerLoginAndCreateProfile('cartop@example.com', PASSWORD)
  const res = await request(app)
    .post('/api/v1/cart/items')
    .set('Cookie', cookie)
    .send({ organizationId: { $gt: '' }, variantId: '000000000000000000000000', quantity: 1 })
  assert.equal(res.status, 422)
})

test('POST /cart/items rejects quantity 0, negative, fractional, and over-limit', async () => {
  const cookie = await registerLoginAndCreateProfile('cartqty@example.com', PASSWORD)
  const { organization, variant } = await createRealOrgAndVariant()

  for (const quantity of [0, -1, 1.5, 10000]) {
    const res = await request(app).post('/api/v1/cart/items').set('Cookie', cookie).send({
      organizationId: organization._id.toString(),
      variantId: variant._id.toString(),
      quantity,
    })
    assert.equal(res.status, 422)
  }
})

test('PATCH /cart/items/:id rejects mass-assignment of cartId/organizationId', async () => {
  const cookie = await registerLoginAndCreateProfile('cartpatchmass@example.com', PASSWORD)
  const { organization, variant } = await createRealOrgAndVariant()
  const added = await request(app).post('/api/v1/cart/items').set('Cookie', cookie).send({
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    quantity: 1,
  })

  const res = await request(app)
    .patch(`/api/v1/cart/items/${added.body.data._id}`)
    .set('Cookie', cookie)
    .send({ quantity: 5, cartId: '000000000000000000000000' })
  assert.equal(res.status, 422)
})

test('a malformed cart item id in the URL is rejected before any DB lookup', async () => {
  const cookie = await registerLoginAndCreateProfile('cartmalformed@example.com', PASSWORD)
  const res = await request(app).delete('/api/v1/cart/items/not-an-object-id').set('Cookie', cookie)
  assert.equal(res.status, 422)
})

test('GET /cart requires a valid organizationId query parameter', async () => {
  const cookie = await registerLoginAndCreateProfile('cartnoorg@example.com', PASSWORD)
  const res = await request(app)
    .get('/api/v1/cart?organizationId=not-an-object-id')
    .set('Cookie', cookie)
  assert.equal(res.status, 422)
})

test('POST /cart/items on a nonexistent organization returns 422, not a 500', async () => {
  const cookie = await registerLoginAndCreateProfile('cartnoorg2@example.com', PASSWORD)
  const res = await request(app).post('/api/v1/cart/items').set('Cookie', cookie).send({
    organizationId: '000000000000000000000000',
    variantId: '000000000000000000000000',
    quantity: 1,
  })
  assert.equal(res.status, 422)
})

// ---------------------------------------------------------------------------
// IDOR
// ---------------------------------------------------------------------------

test("a customer cannot see, update, or remove another customer's cart item (IDOR)", async () => {
  const cookieA = await registerLoginAndCreateProfile('cartIdorA@example.com', PASSWORD)
  const cookieB = await registerLoginAndCreateProfile('cartIdorB@example.com', PASSWORD)
  const { organization, variant } = await createRealOrgAndVariant()

  const created = await request(app).post('/api/v1/cart/items').set('Cookie', cookieA).send({
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    quantity: 1,
  })
  const itemId = created.body.data._id

  const getForB = await request(app)
    .get(`/api/v1/cart?organizationId=${organization._id.toString()}`)
    .set('Cookie', cookieB)
  assert.equal(getForB.body.data.items.length, 0)

  const patchAttempt = await request(app)
    .patch(`/api/v1/cart/items/${itemId}`)
    .set('Cookie', cookieB)
    .send({ quantity: 99 })
  assert.equal(patchAttempt.status, 404)

  const removeAttempt = await request(app)
    .delete(`/api/v1/cart/items/${itemId}`)
    .set('Cookie', cookieB)
  assert.equal(removeAttempt.status, 404)

  const stillThereForA = await request(app)
    .get(`/api/v1/cart?organizationId=${organization._id.toString()}`)
    .set('Cookie', cookieA)
  assert.equal(stillThereForA.body.data.items.length, 1)
  assert.equal(stillThereForA.body.data.items[0].quantity, 1)
})

test("a customer's cart for one organization is isolated from another organization's cart (cross-organization isolation)", async () => {
  const cookie = await registerLoginAndCreateProfile('cartorgiso@example.com', PASSWORD)
  const { organization: organizationA, variant: variantA } = await createRealOrgAndVariant()
  const { organization: organizationB, variant: variantB } = await createRealOrgAndVariant()

  await request(app).post('/api/v1/cart/items').set('Cookie', cookie).send({
    organizationId: organizationA._id.toString(),
    variantId: variantA._id.toString(),
    quantity: 1,
  })
  await request(app).post('/api/v1/cart/items').set('Cookie', cookie).send({
    organizationId: organizationB._id.toString(),
    variantId: variantB._id.toString(),
    quantity: 2,
  })

  const viewA = await request(app)
    .get(`/api/v1/cart?organizationId=${organizationA._id.toString()}`)
    .set('Cookie', cookie)
  const viewB = await request(app)
    .get(`/api/v1/cart?organizationId=${organizationB._id.toString()}`)
    .set('Cookie', cookie)
  assert.equal(viewA.body.data.items.length, 1)
  assert.equal(viewB.body.data.items.length, 1)
  assert.equal(viewA.body.data.items[0].quantity, 1)
  assert.equal(viewB.body.data.items[0].quantity, 2)
})

test('rejects a variant belonging to a different organization (cross-org variant reference)', async () => {
  const cookie = await registerLoginAndCreateProfile('cartcrossorgvariant@example.com', PASSWORD)
  const { organization: organizationA } = await createRealOrgAndVariant()
  const { variant: variantB } = await createRealOrgAndVariant()

  const res = await request(app).post('/api/v1/cart/items').set('Cookie', cookie).send({
    organizationId: organizationA._id.toString(),
    variantId: variantB._id.toString(),
    quantity: 1,
  })
  assert.equal(res.status, 422)
})

// ---------------------------------------------------------------------------
// Archived variant behavior
// ---------------------------------------------------------------------------

test('archived variant: POST rejects, PATCH rejects, DELETE succeeds, item stays visible in GET', async () => {
  const cookie = await registerLoginAndCreateProfile('cartarchived@example.com', PASSWORD)
  const { organization, variant } = await createRealOrgAndVariant()

  const added = await request(app).post('/api/v1/cart/items').set('Cookie', cookie).send({
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    quantity: 1,
  })
  const itemId = added.body.data._id

  await productVariantRepository.update(organization._id, variant._id, { status: 'ARCHIVED' })

  const secondAddAttempt = await request(app)
    .post('/api/v1/cart/items')
    .set('Cookie', cookie)
    .send({
      organizationId: organization._id.toString(),
      variantId: variant._id.toString(),
      quantity: 1,
    })
  assert.equal(secondAddAttempt.status, 422)

  const patchAttempt = await request(app)
    .patch(`/api/v1/cart/items/${itemId}`)
    .set('Cookie', cookie)
    .send({ quantity: 5 })
  assert.equal(patchAttempt.status, 422)

  const getRes = await request(app)
    .get(`/api/v1/cart?organizationId=${organization._id.toString()}`)
    .set('Cookie', cookie)
  assert.equal(getRes.body.data.items.length, 1)
  assert.equal(getRes.body.data.items[0].variantStatus, 'ARCHIVED')

  const removeRes = await request(app).delete(`/api/v1/cart/items/${itemId}`).set('Cookie', cookie)
  assert.equal(removeRes.status, 200)
})

// ---------------------------------------------------------------------------
// Route regression protection
// ---------------------------------------------------------------------------

test('an unrelated, unmatched route still returns the standardized 404 envelope (route mounting regression check)', async () => {
  const res = await request(app).get('/api/v1/this-route-does-not-exist')
  assert.equal(res.status, 404)
  assert.equal(res.body.success, false)
})
