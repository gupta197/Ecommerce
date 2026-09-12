import { SignJWT, jwtVerify } from 'jose'
import { randomUUID, randomBytes, createHash } from 'node:crypto'

const ISSUER = 'ecommerce-api'
const AUDIENCE = 'ecommerce-platform'
const ALGORITHM = 'HS256'

export interface AccessTokenClaims {
  sub: string
  sid: string
  jti: string
}

export interface VerifiedAccessToken {
  userId: string
  sessionId: string
  jti: string
}

export async function signAccessToken(
  claims: AccessTokenClaims,
  secret: string,
  ttlMs: number,
): Promise<string> {
  const key = new TextEncoder().encode(secret)
  const expirationSeconds = Math.floor((Date.now() + ttlMs) / 1000)

  return new SignJWT({ sub: claims.sub, sid: claims.sid, jti: claims.jti })
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(expirationSeconds)
    .sign(key)
}

/**
 * Verifies signature, algorithm (explicit allowlist — jose rejects anything
 * not in this list, including "none"), issuer, audience, and expiration, then
 * asserts the required claim shape. Throws on any failure — callers (the
 * authenticate middleware) must treat every failure identically, never
 * distinguishing "expired" from "bad signature" from "wrong issuer" in any
 * response.
 */
export async function verifyAccessToken(
  token: string,
  secret: string,
): Promise<VerifiedAccessToken> {
  const key = new TextEncoder().encode(secret)
  const { payload } = await jwtVerify(token, key, {
    algorithms: [ALGORITHM],
    issuer: ISSUER,
    audience: AUDIENCE,
  })

  const sub = payload.sub
  const sid = (payload as Record<string, unknown>).sid
  const jti = payload.jti

  if (typeof sub !== 'string' || sub.length === 0) {
    throw new Error('Malformed access token: missing sub')
  }
  if (typeof sid !== 'string' || sid.length === 0) {
    throw new Error('Malformed access token: missing sid')
  }
  if (typeof jti !== 'string' || jti.length === 0) {
    throw new Error('Malformed access token: missing jti')
  }

  return { userId: sub, sessionId: sid, jti }
}

export function generateJti(): string {
  return randomUUID()
}

/** 256 bits of entropy, URL-safe. Never persisted or logged in this form. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Plain SHA-256 — deliberately NOT Argon2/bcrypt. Password hashing must be
 * slow because passwords are low-entropy and guessable; a refresh token
 * already has 256 bits of random entropy, so a fast deterministic hash is
 * both sufficient (nothing brute-forces 256 bits) and necessary (a slow hash
 * would make the by-hash database lookup impractical).
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
