import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { NextFunction, Request, Response } from 'express'
import { SignJWT } from 'jose'
import { createAuthenticateMiddleware } from './authenticate.js'
import { signAccessToken } from '../modules/auth/services/token.service.js'
import { UnauthenticatedError } from '../lib/http-errors.js'

const SECRET = 'a'.repeat(32)
const middleware = createAuthenticateMiddleware(SECRET)

function fakeRequest(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    ...overrides,
  } as Request
}

function runMiddleware(req: Request): Promise<{ error?: unknown; auth?: unknown }> {
  return new Promise((resolve) => {
    const next: NextFunction = ((error?: unknown) => {
      resolve({ error, auth: req.auth })
    }) as NextFunction
    middleware(req, {} as Response, next)
  })
}

test('authenticates via a valid Authorization: Bearer header', async () => {
  const token = await signAccessToken(
    { sub: 'user-1', sid: 'session-1', jti: 'jti-1' },
    SECRET,
    900_000,
  )
  const req = fakeRequest({ headers: { authorization: `Bearer ${token}` } })

  const { error, auth } = await runMiddleware(req)

  assert.equal(error, undefined)
  assert.deepEqual(auth, { userId: 'user-1', sessionId: 'session-1' })
})

test('authenticates via a valid access_token cookie when no Authorization header is present', async () => {
  const token = await signAccessToken(
    { sub: 'user-2', sid: 'session-2', jti: 'jti-2' },
    SECRET,
    900_000,
  )
  const req = fakeRequest({ headers: { cookie: `access_token=${token}` } })

  const { error, auth } = await runMiddleware(req)

  assert.equal(error, undefined)
  assert.deepEqual(auth, { userId: 'user-2', sessionId: 'session-2' })
})

test('prefers the Authorization header over a cookie when both are present', async () => {
  const headerToken = await signAccessToken(
    { sub: 'header-user', sid: 'header-session', jti: 'jti-h' },
    SECRET,
    900_000,
  )
  const cookieToken = await signAccessToken(
    { sub: 'cookie-user', sid: 'cookie-session', jti: 'jti-c' },
    SECRET,
    900_000,
  )
  const req = fakeRequest({
    headers: { authorization: `Bearer ${headerToken}`, cookie: `access_token=${cookieToken}` },
  })

  const { auth } = await runMiddleware(req)

  assert.deepEqual(auth, { userId: 'header-user', sessionId: 'header-session' })
})

test('rejects when no token is present at all', async () => {
  const req = fakeRequest()
  const { error } = await runMiddleware(req)
  assert.ok(error instanceof UnauthenticatedError)
})

test('rejects a malformed token', async () => {
  const req = fakeRequest({ headers: { authorization: 'Bearer not-a-real-jwt' } })
  const { error } = await runMiddleware(req)
  assert.ok(error instanceof UnauthenticatedError)
})

test('rejects an expired token', async () => {
  const token = await signAccessToken(
    { sub: 'user-1', sid: 'session-1', jti: 'jti-1' },
    SECRET,
    -1_000,
  )
  const req = fakeRequest({ headers: { authorization: `Bearer ${token}` } })
  const { error } = await runMiddleware(req)
  assert.ok(error instanceof UnauthenticatedError)
})

test('rejects a token with the wrong issuer', async () => {
  const key = new TextEncoder().encode(SECRET)
  const token = await new SignJWT({ sub: 'user-1', sid: 'session-1', jti: 'jti-1' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('some-other-issuer')
    .setAudience('ecommerce-platform')
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
    .sign(key)
  const req = fakeRequest({ headers: { authorization: `Bearer ${token}` } })
  const { error } = await runMiddleware(req)
  assert.ok(error instanceof UnauthenticatedError)
})

test('rejects a token with the wrong audience', async () => {
  const key = new TextEncoder().encode(SECRET)
  const token = await new SignJWT({ sub: 'user-1', sid: 'session-1', jti: 'jti-1' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('ecommerce-api')
    .setAudience('some-other-audience')
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
    .sign(key)
  const req = fakeRequest({ headers: { authorization: `Bearer ${token}` } })
  const { error } = await runMiddleware(req)
  assert.ok(error instanceof UnauthenticatedError)
})

test('rejects a token signed with a disallowed algorithm', async () => {
  const key = new TextEncoder().encode(SECRET)
  const token = await new SignJWT({ sub: 'user-1', sid: 'session-1', jti: 'jti-1' })
    .setProtectedHeader({ alg: 'HS384' })
    .setIssuer('ecommerce-api')
    .setAudience('ecommerce-platform')
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
    .sign(key)
  const req = fakeRequest({ headers: { authorization: `Bearer ${token}` } })
  const { error } = await runMiddleware(req)
  assert.ok(error instanceof UnauthenticatedError)
})

test('rejects a token missing required claims', async () => {
  const key = new TextEncoder().encode(SECRET)
  const token = await new SignJWT({ sub: 'user-1', jti: 'jti-1' }) // no sid
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('ecommerce-api')
    .setAudience('ecommerce-platform')
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
    .sign(key)
  const req = fakeRequest({ headers: { authorization: `Bearer ${token}` } })
  const { error } = await runMiddleware(req)
  assert.ok(error instanceof UnauthenticatedError)
})

test('rejects a token signed with the wrong secret', async () => {
  const token = await signAccessToken(
    { sub: 'user-1', sid: 'session-1', jti: 'jti-1' },
    'b'.repeat(32),
    900_000,
  )
  const req = fakeRequest({ headers: { authorization: `Bearer ${token}` } })
  const { error } = await runMiddleware(req)
  assert.ok(error instanceof UnauthenticatedError)
})
