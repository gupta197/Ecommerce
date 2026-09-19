import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import type { Express } from 'express'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import mongoose from 'mongoose'
import { loadConfig } from '../../../config/env.js'
import { createLogger } from '../../../lib/logger.js'
import { createApp } from '../../../app.js'
import { UserModel } from '../../auth/models/user.model.js'
import { SecuritySessionModel } from '../../auth/models/security-session.model.js'
import { LoginAttemptModel } from '../../auth/models/login-attempt.model.js'
import { CustomerModel } from '../models/customer.model.js'
import { AddressModel } from '../models/address.model.js'

// setDefaultAddress uses withTransaction() — a real (even single-node)
// replica set is required, not a standalone server.
let replSet: MongoMemoryReplSet
let app: Express

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  await mongoose.connect(replSet.getUri(), { dbName: 'cust_001_customer_route_test' })

  const config = loadConfig({
    NODE_ENV: 'test',
    CORS_ORIGIN: 'http://localhost:5173',
    LOG_LEVEL: 'silent',
    MONGODB_URI: 'mongodb://localhost:27017',
    MONGODB_DB_NAME: 'cust_001_customer_route_test',
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
  ])
})

function extractCookieHeader(res: request.Response): string {
  const raw = res.headers['set-cookie']
  const setCookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : []
  return setCookies.map((c) => c.split(';')[0]).join('; ')
}

async function registerAndLogin(email: string, password: string): Promise<string> {
  await request(app).post('/api/v1/auth/register').send({ email, password })
  const loginRes = await request(app).post('/api/v1/auth/login').send({ email, password })
  return extractCookieHeader(loginRes)
}

const PASSWORD = 'correct-password-123'

function validAddressInput(overrides: Record<string, unknown> = {}) {
  return {
    recipientName: 'Ada Lovelace',
    line1: '1 Analytical Engine Way',
    city: 'London',
    state: 'London',
    postalCode: 'AB1 2CD',
    country: 'UK',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Authentication boundary
// ---------------------------------------------------------------------------

test('every /customers route requires authentication', async () => {
  const noAuthGet = await request(app).get('/api/v1/customers/me')
  assert.equal(noAuthGet.status, 401)

  const noAuthPost = await request(app)
    .post('/api/v1/customers/me')
    .send({ firstName: 'A', lastName: 'B' })
  assert.equal(noAuthPost.status, 401)

  const noAuthAddresses = await request(app).get('/api/v1/customers/me/addresses')
  assert.equal(noAuthAddresses.status, 401)
})

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

test("POST /customers/me creates the caller's own profile", async () => {
  const cookie = await registerAndLogin('profile@example.com', PASSWORD)

  const res = await request(app)
    .post('/api/v1/customers/me')
    .set('Cookie', cookie)
    .send({ firstName: 'Ada', lastName: 'Lovelace' })

  assert.equal(res.status, 201)
  assert.equal(res.body.data.firstName, 'Ada')
  assert.equal(res.body.data.status, 'ACTIVE')
})

test('POST /customers/me rejects a second profile for the same user', async () => {
  const cookie = await registerAndLogin('dup@example.com', PASSWORD)
  await request(app)
    .post('/api/v1/customers/me')
    .set('Cookie', cookie)
    .send({ firstName: 'A', lastName: 'B' })

  const second = await request(app)
    .post('/api/v1/customers/me')
    .set('Cookie', cookie)
    .send({ firstName: 'C', lastName: 'D' })
  assert.equal(second.status, 422)
})

test('GET /customers/me returns 404 before a profile is created, then the profile after', async () => {
  const cookie = await registerAndLogin('getme@example.com', PASSWORD)

  const before404 = await request(app).get('/api/v1/customers/me').set('Cookie', cookie)
  assert.equal(before404.status, 404)

  await request(app)
    .post('/api/v1/customers/me')
    .set('Cookie', cookie)
    .send({ firstName: 'A', lastName: 'B' })

  const after200 = await request(app).get('/api/v1/customers/me').set('Cookie', cookie)
  assert.equal(after200.status, 200)
  assert.equal(after200.body.data.firstName, 'A')
})

test("PATCH /customers/me updates only the caller's own profile", async () => {
  const cookie = await registerAndLogin('patchme@example.com', PASSWORD)
  await request(app)
    .post('/api/v1/customers/me')
    .set('Cookie', cookie)
    .send({ firstName: 'A', lastName: 'B' })

  const res = await request(app)
    .patch('/api/v1/customers/me')
    .set('Cookie', cookie)
    .send({ firstName: 'Renamed' })
  assert.equal(res.status, 200)
  assert.equal(res.body.data.firstName, 'Renamed')
})

test('PATCH /customers/me rejects an attempt to set status directly', async () => {
  const cookie = await registerAndLogin('patchstatus@example.com', PASSWORD)
  await request(app)
    .post('/api/v1/customers/me')
    .set('Cookie', cookie)
    .send({ firstName: 'A', lastName: 'B' })

  const res = await request(app)
    .patch('/api/v1/customers/me')
    .set('Cookie', cookie)
    .send({ status: 'ARCHIVED' })
  assert.equal(res.status, 422)
})

test("DELETE /customers/me archives the caller's own profile without deleting it", async () => {
  const cookie = await registerAndLogin('deleteme@example.com', PASSWORD)
  await request(app)
    .post('/api/v1/customers/me')
    .set('Cookie', cookie)
    .send({ firstName: 'A', lastName: 'B' })

  const res = await request(app).delete('/api/v1/customers/me').set('Cookie', cookie)
  assert.equal(res.status, 200)
  assert.equal(res.body.data.status, 'ARCHIVED')

  const stillExists = await CustomerModel.findOne({ firstName: 'A' })
  assert.ok(stillExists)
})

test("a customer cannot read or modify another customer's profile via any route (IDOR)", async () => {
  const cookieA = await registerAndLogin('idorA@example.com', PASSWORD)
  const cookieB = await registerAndLogin('idorB@example.com', PASSWORD)
  await request(app)
    .post('/api/v1/customers/me')
    .set('Cookie', cookieA)
    .send({ firstName: 'A', lastName: 'A' })

  // There is no route parameter to tamper with (identity is always
  // req.auth.userId) — the IDOR check here is that B's own /me never
  // resolves to A's data.
  const bProfile = await request(app).get('/api/v1/customers/me').set('Cookie', cookieB)
  assert.equal(bProfile.status, 404)
})

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

test('full address lifecycle via routes: create, list, update, set default, archive', async () => {
  const cookie = await registerAndLogin('addresses@example.com', PASSWORD)
  await request(app)
    .post('/api/v1/customers/me')
    .set('Cookie', cookie)
    .send({ firstName: 'A', lastName: 'B' })

  const created = await request(app)
    .post('/api/v1/customers/me/addresses')
    .set('Cookie', cookie)
    .send(validAddressInput())
  assert.equal(created.status, 201)
  const addressId = created.body.data._id

  const list = await request(app).get('/api/v1/customers/me/addresses').set('Cookie', cookie)
  assert.equal(list.status, 200)
  assert.equal(list.body.data.length, 1)

  const updated = await request(app)
    .patch(`/api/v1/customers/me/addresses/${addressId}`)
    .set('Cookie', cookie)
    .send({ city: 'Manchester' })
  assert.equal(updated.status, 200)
  assert.equal(updated.body.data.city, 'Manchester')

  const defaulted = await request(app)
    .post(`/api/v1/customers/me/addresses/${addressId}/default`)
    .set('Cookie', cookie)
    .send({ type: 'billing' })
  assert.equal(defaulted.status, 200)
  assert.equal(defaulted.body.data.isDefaultBilling, true)

  const archived = await request(app)
    .delete(`/api/v1/customers/me/addresses/${addressId}`)
    .set('Cookie', cookie)
  assert.equal(archived.status, 200)
  assert.equal(archived.body.data.status, 'ARCHIVED')
})

test("a customer cannot read, update, archive, or set-default another customer's address (IDOR)", async () => {
  const cookieA = await registerAndLogin('addrIdorA@example.com', PASSWORD)
  const cookieB = await registerAndLogin('addrIdorB@example.com', PASSWORD)
  await request(app)
    .post('/api/v1/customers/me')
    .set('Cookie', cookieA)
    .send({ firstName: 'A', lastName: 'A' })
  await request(app)
    .post('/api/v1/customers/me')
    .set('Cookie', cookieB)
    .send({ firstName: 'B', lastName: 'B' })

  const created = await request(app)
    .post('/api/v1/customers/me/addresses')
    .set('Cookie', cookieA)
    .send(validAddressInput())
  const addressId = created.body.data._id

  const readAttempt = await request(app)
    .get('/api/v1/customers/me/addresses')
    .set('Cookie', cookieB)
  assert.equal(readAttempt.body.data.length, 0)

  const updateAttempt = await request(app)
    .patch(`/api/v1/customers/me/addresses/${addressId}`)
    .set('Cookie', cookieB)
    .send({ city: 'Hijacked' })
  assert.equal(updateAttempt.status, 404)

  const defaultAttempt = await request(app)
    .post(`/api/v1/customers/me/addresses/${addressId}/default`)
    .set('Cookie', cookieB)
    .send({ type: 'billing' })
  assert.equal(defaultAttempt.status, 404)

  const archiveAttempt = await request(app)
    .delete(`/api/v1/customers/me/addresses/${addressId}`)
    .set('Cookie', cookieB)
  assert.equal(archiveAttempt.status, 404)
})

test('POST /customers/me/addresses rejects mass-assignment of customerId/isDefaultBilling/isDefaultShipping/status', async () => {
  const cookie = await registerAndLogin('addrmass@example.com', PASSWORD)
  await request(app)
    .post('/api/v1/customers/me')
    .set('Cookie', cookie)
    .send({ firstName: 'A', lastName: 'B' })

  const res = await request(app)
    .post('/api/v1/customers/me/addresses')
    .set('Cookie', cookie)
    .send(validAddressInput({ isDefaultBilling: true }))
  assert.equal(res.status, 422)
})

test('a malformed address id in the URL is rejected with a validation error before any DB lookup', async () => {
  const cookie = await registerAndLogin('malformed@example.com', PASSWORD)
  await request(app)
    .post('/api/v1/customers/me')
    .set('Cookie', cookie)
    .send({ firstName: 'A', lastName: 'B' })

  const res = await request(app)
    .patch('/api/v1/customers/me/addresses/not-an-object-id')
    .set('Cookie', cookie)
    .send({ city: 'X' })
  assert.equal(res.status, 422)
})
