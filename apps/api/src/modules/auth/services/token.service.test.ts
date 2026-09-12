import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  signAccessToken,
  verifyAccessToken,
  generateJti,
  generateRefreshToken,
  hashRefreshToken,
} from './token.service.js'

const SECRET = 'a'.repeat(32)
const OTHER_SECRET = 'b'.repeat(32)

test('a signed token round-trips through verification', async () => {
  const token = await signAccessToken(
    { sub: 'user-1', sid: 'session-1', jti: 'jti-1' },
    SECRET,
    900_000,
  )
  const verified = await verifyAccessToken(token, SECRET)

  assert.equal(verified.userId, 'user-1')
  assert.equal(verified.sessionId, 'session-1')
  assert.equal(verified.jti, 'jti-1')
})

test('verification fails with the wrong secret (bad signature)', async () => {
  const token = await signAccessToken(
    { sub: 'user-1', sid: 'session-1', jti: 'jti-1' },
    SECRET,
    900_000,
  )
  await assert.rejects(() => verifyAccessToken(token, OTHER_SECRET))
})

test('verification fails for a malformed token string', async () => {
  await assert.rejects(() => verifyAccessToken('not-a-real-jwt', SECRET))
})

test('verification fails for an expired token', async () => {
  const token = await signAccessToken(
    { sub: 'user-1', sid: 'session-1', jti: 'jti-1' },
    SECRET,
    -1_000, // already expired
  )
  await assert.rejects(() => verifyAccessToken(token, SECRET))
})

test('verification fails for a token with an unexpected issuer', async () => {
  const { SignJWT } = await import('jose')
  const key = new TextEncoder().encode(SECRET)
  const token = await new SignJWT({ sub: 'user-1', sid: 'session-1', jti: 'jti-1' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('some-other-issuer')
    .setAudience('ecommerce-platform')
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
    .sign(key)

  await assert.rejects(() => verifyAccessToken(token, SECRET))
})

test('verification fails for a token with an unexpected audience', async () => {
  const { SignJWT } = await import('jose')
  const key = new TextEncoder().encode(SECRET)
  const token = await new SignJWT({ sub: 'user-1', sid: 'session-1', jti: 'jti-1' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('ecommerce-api')
    .setAudience('some-other-audience')
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
    .sign(key)

  await assert.rejects(() => verifyAccessToken(token, SECRET))
})

test('verification fails for a token signed with a disallowed algorithm', async () => {
  const { SignJWT } = await import('jose')
  const key = new TextEncoder().encode(SECRET)
  const token = await new SignJWT({ sub: 'user-1', sid: 'session-1', jti: 'jti-1' })
    .setProtectedHeader({ alg: 'HS384' })
    .setIssuer('ecommerce-api')
    .setAudience('ecommerce-platform')
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
    .sign(key)

  await assert.rejects(() => verifyAccessToken(token, SECRET))
})

test('verification fails when required claims (sid) are missing', async () => {
  const { SignJWT } = await import('jose')
  const key = new TextEncoder().encode(SECRET)
  const token = await new SignJWT({ sub: 'user-1', jti: 'jti-1' }) // no sid
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('ecommerce-api')
    .setAudience('ecommerce-platform')
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
    .sign(key)

  await assert.rejects(() => verifyAccessToken(token, SECRET))
})

test('generateJti produces unique values', () => {
  const a = generateJti()
  const b = generateJti()
  assert.notEqual(a, b)
})

test('generateRefreshToken produces high-entropy, URL-safe values', () => {
  const a = generateRefreshToken()
  const b = generateRefreshToken()
  assert.notEqual(a, b)
  assert.match(a, /^[A-Za-z0-9_-]+$/)
  assert.ok(a.length >= 40)
})

test('hashRefreshToken is deterministic and does not return the plaintext', () => {
  const token = generateRefreshToken()
  const hashA = hashRefreshToken(token)
  const hashB = hashRefreshToken(token)
  assert.equal(hashA, hashB)
  assert.notEqual(hashA, token)
  assert.match(hashA, /^[a-f0-9]{64}$/)
})
