import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import type { Express } from 'express'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose from 'mongoose'
import { loadConfig } from '../../../config/env.js'
import { createLogger } from '../../../lib/logger.js'
import { createApp } from '../../../app.js'
import { UserModel } from '../models/user.model.js'
import { SecuritySessionModel } from '../models/security-session.model.js'
import { LoginAttemptModel } from '../models/login-attempt.model.js'

const VALID_ORIGIN = 'http://localhost:5173'

let mongod: MongoMemoryServer
let app: Express

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'sec_001_auth_route_test' })

  const config = loadConfig({
    NODE_ENV: 'test',
    CORS_ORIGIN: VALID_ORIGIN,
    LOG_LEVEL: 'silent',
    MONGODB_URI: 'mongodb://localhost:27017',
    MONGODB_DB_NAME: 'sec_001_auth_route_test',
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
  ])
})

function extractCookieHeader(res: request.Response): string {
  const raw = res.headers['set-cookie']
  const setCookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : []
  return setCookies.map((c) => c.split(';')[0]).join('; ')
}

function extractCookieValue(res: request.Response, name: string): string | undefined {
  const raw = res.headers['set-cookie']
  const setCookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : []
  for (const cookie of setCookies) {
    const [pair] = cookie.split(';')
    const [cookieName, value] = (pair ?? '').split('=')
    if (cookieName === name) return value
  }
  return undefined
}

async function registerAndLogin(email: string, password: string) {
  await request(app).post('/api/v1/auth/register').send({ email, password })
  const loginRes = await request(app)
    .post('/api/v1/auth/login')
    .set('Origin', VALID_ORIGIN)
    .send({ email, password })
  const cookieHeader = extractCookieHeader(loginRes)
  const csrfToken = extractCookieValue(loginRes, 'xsrf_token')
  return { loginRes, cookieHeader, csrfToken: csrfToken! }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test('POST /register responds with the generic success envelope for a new email', async () => {
  const res = await request(app)
    .post('/api/v1/auth/register')
    .send({ email: 'new@example.com', password: 'a-long-enough-password' })

  assert.equal(res.status, 201)
  assert.equal(res.body.success, true)
  assert.ok(res.body.data.message)
  assert.equal(res.headers['set-cookie'], undefined)
})

test('POST /register responds identically for a duplicate email (no enumeration)', async () => {
  await request(app)
    .post('/api/v1/auth/register')
    .send({ email: 'dup@example.com', password: 'original-password-123' })

  const res = await request(app)
    .post('/api/v1/auth/register')
    .send({ email: 'dup@example.com', password: 'attacker-password-123' })

  assert.equal(res.status, 201)
  assert.equal(res.body.success, true)
  assert.ok(res.body.data.message)
})

test('POST /register rejects a payload with an unknown extra field', async () => {
  const res = await request(app)
    .post('/api/v1/auth/register')
    .send({ email: 'strict@example.com', password: 'a-long-enough-password', isAdmin: true })

  assert.equal(res.status, 422)
  assert.equal(res.body.error.code, 'VALIDATION_ERROR')
})

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

test('POST /login sets access_token, refresh_token, and xsrf_token cookies on success', async () => {
  await request(app)
    .post('/api/v1/auth/register')
    .send({ email: 'login@example.com', password: 'correct-password-123' })

  const res = await request(app)
    .post('/api/v1/auth/login')
    .set('Origin', VALID_ORIGIN)
    .send({ email: 'login@example.com', password: 'correct-password-123' })

  assert.equal(res.status, 200)
  assert.equal(res.body.success, true)
  assert.equal(res.body.data.email, 'login@example.com')

  const raw = res.headers['set-cookie']
  const setCookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : []
  const names = setCookies.map((c) => c.split('=')[0])
  assert.ok(names.includes('access_token'))
  assert.ok(names.includes('refresh_token'))
  assert.ok(names.includes('xsrf_token'))

  const accessCookie = setCookies.find((c) => c.startsWith('access_token='))
  const refreshCookie = setCookies.find((c) => c.startsWith('refresh_token='))
  assert.ok(accessCookie?.toLowerCase().includes('httponly'))
  assert.ok(accessCookie?.toLowerCase().includes('samesite=lax'))
  assert.ok(refreshCookie?.toLowerCase().includes('path=/api/v1/auth'))
})

test('POST /login returns a generic error for invalid credentials', async () => {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .set('Origin', VALID_ORIGIN)
    .send({ email: 'nobody@example.com', password: 'whatever-123' })

  assert.equal(res.status, 401)
  assert.equal(res.body.error.code, 'UNAUTHENTICATED')
})

// ---------------------------------------------------------------------------
// CSRF enforcement
// ---------------------------------------------------------------------------

test('POST /logout is rejected without a CSRF token even with a valid session cookie', async () => {
  const { cookieHeader } = await registerAndLogin(
    'logoutnocsrf@example.com',
    'correct-password-123',
  )

  const res = await request(app)
    .post('/api/v1/auth/logout')
    .set('Cookie', cookieHeader)
    .set('Origin', VALID_ORIGIN)

  assert.equal(res.status, 422)
  assert.equal(res.body.error.code, 'VALIDATION_ERROR')
})

test('POST /logout is rejected when the CSRF header does not match the cookie', async () => {
  const { cookieHeader } = await registerAndLogin(
    'logoutmismatch@example.com',
    'correct-password-123',
  )

  const res = await request(app)
    .post('/api/v1/auth/logout')
    .set('Cookie', cookieHeader)
    .set('Origin', VALID_ORIGIN)
    .set('x-xsrf-token', 'not-the-real-token')

  assert.equal(res.status, 422)
})

test('POST /logout is rejected for a disallowed Origin even with a matching CSRF token', async () => {
  const { cookieHeader, csrfToken } = await registerAndLogin(
    'logoutbadorigin@example.com',
    'correct-password-123',
  )

  const res = await request(app)
    .post('/api/v1/auth/logout')
    .set('Cookie', cookieHeader)
    .set('Origin', 'http://evil.example.com')
    .set('x-xsrf-token', csrfToken)

  assert.equal(res.status, 422)
})

test('POST /logout succeeds with a valid session cookie, matching CSRF token, and allowed Origin', async () => {
  const { cookieHeader, csrfToken } = await registerAndLogin(
    'logoutok@example.com',
    'correct-password-123',
  )

  const res = await request(app)
    .post('/api/v1/auth/logout')
    .set('Cookie', cookieHeader)
    .set('Origin', VALID_ORIGIN)
    .set('x-xsrf-token', csrfToken)

  assert.equal(res.status, 200)
  assert.equal(res.body.data.loggedOut, true)

  const raw = res.headers['set-cookie']
  const setCookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : []
  const cleared = setCookies.filter((c) => /expires=thu, 01 jan 1970/i.test(c))
  assert.ok(cleared.length >= 3, 'expected all three auth cookies to be cleared')
})

test('login and registration do NOT require a CSRF token', async () => {
  const registerRes = await request(app)
    .post('/api/v1/auth/register')
    .send({ email: 'nocsrfneeded@example.com', password: 'a-long-enough-password' })
  assert.equal(registerRes.status, 201)

  const loginRes = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: 'nocsrfneeded@example.com', password: 'a-long-enough-password' })
  assert.equal(loginRes.status, 200)
})

// ---------------------------------------------------------------------------
// Refresh (end-to-end, via real cookies)
// ---------------------------------------------------------------------------

test('POST /refresh rotates cookies end-to-end and the old refresh cookie stops working', async () => {
  const { cookieHeader, csrfToken } = await registerAndLogin(
    'refreshflow@example.com',
    'correct-password-123',
  )

  const refreshRes = await request(app)
    .post('/api/v1/auth/refresh')
    .set('Cookie', cookieHeader)
    .set('Origin', VALID_ORIGIN)
    .set('x-xsrf-token', csrfToken)

  assert.equal(refreshRes.status, 200)
  assert.equal(refreshRes.body.data.refreshed, true)

  const secondRefreshRes = await request(app)
    .post('/api/v1/auth/refresh')
    .set('Cookie', cookieHeader) // reusing the now-rotated-away original cookie
    .set('Origin', VALID_ORIGIN)
    .set('x-xsrf-token', csrfToken)

  assert.equal(secondRefreshRes.status, 401)
})

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

test('GET /sessions requires authentication', async () => {
  const res = await request(app).get('/api/v1/auth/sessions')
  assert.equal(res.status, 401)
})

test("GET /sessions returns only the caller's own sessions", async () => {
  const userA = await registerAndLogin('sessionsRouteA@example.com', 'correct-password-123')
  await registerAndLogin('sessionsRouteB@example.com', 'correct-password-123')

  const res = await request(app).get('/api/v1/auth/sessions').set('Cookie', userA.cookieHeader)

  assert.equal(res.status, 200)
  assert.equal(res.body.data.length, 1)
})

test("a user cannot revoke another user's session via the route", async () => {
  const owner = await registerAndLogin('routeOwner@example.com', 'correct-password-123')
  const attacker = await registerAndLogin('routeAttacker@example.com', 'correct-password-123')

  const ownerSessions = await request(app)
    .get('/api/v1/auth/sessions')
    .set('Cookie', owner.cookieHeader)
  const ownerSessionId = ownerSessions.body.data[0].id ?? ownerSessions.body.data[0]._id

  const res = await request(app)
    .post(`/api/v1/auth/sessions/${ownerSessionId}/revoke`)
    .set('Cookie', attacker.cookieHeader)
    .set('Origin', VALID_ORIGIN)
    .set('x-xsrf-token', attacker.csrfToken)

  assert.equal(res.status, 404)
})

test("POST /sessions/revoke-others revokes every session but the caller's current one", async () => {
  const first = await registerAndLogin('revokeOthersRoute@example.com', 'correct-password-123')
  await request(app)
    .post('/api/v1/auth/login')
    .set('Origin', VALID_ORIGIN)
    .send({ email: 'revokeOthersRoute@example.com', password: 'correct-password-123' })

  const res = await request(app)
    .post('/api/v1/auth/sessions/revoke-others')
    .set('Cookie', first.cookieHeader)
    .set('Origin', VALID_ORIGIN)
    .set('x-xsrf-token', first.csrfToken)

  assert.equal(res.status, 200)
  assert.equal(res.body.data.revoked, true)

  const sessionsAfter = await request(app)
    .get('/api/v1/auth/sessions')
    .set('Cookie', first.cookieHeader)
  assert.equal(sessionsAfter.body.data.length, 1)
})
