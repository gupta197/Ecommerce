import type { NextFunction, Request, Response } from 'express'
import { verifyAccessToken } from '../modules/auth/services/token.service.js'
import { UnauthenticatedError } from '../lib/http-errors.js'
import { readCookie } from '../lib/cookies.js'

export const ACCESS_TOKEN_COOKIE_NAME = 'access_token'
const BEARER_PREFIX = 'Bearer '

/**
 * Cryptographically verifies the access token (signature, algorithm
 * allowlist, issuer, audience, expiration, required claim shape — all
 * enforced inside token.service.ts's verifyAccessToken) and attaches
 * `req.auth = {userId, sessionId}`.
 *
 * Deliberately does NOT perform a MongoDB session lookup on every request —
 * access tokens are short-lived specifically so per-request verification
 * stays stateless and fast. A revoked session's still-unexpired access token
 * remains cryptographically valid until its own natural expiry; the short
 * TTL is the accepted mitigation for that window, not a gap to close here.
 *
 * Stronger checks (immediate revocation enforcement, step-up
 * re-authentication for sensitive operations) belong in a separate,
 * additional middleware layered on top of this one for specific
 * high-sensitivity routes — not built in SEC-001.
 */
export function createAuthenticateMiddleware(jwtSecret: string) {
  return function authenticate(req: Request, _res: Response, next: NextFunction): void {
    const token = extractToken(req)
    if (!token) {
      next(new UnauthenticatedError())
      return
    }

    verifyAccessToken(token, jwtSecret)
      .then((verified) => {
        req.auth = { userId: verified.userId, sessionId: verified.sessionId }
        next()
      })
      .catch(() => {
        next(new UnauthenticatedError())
      })
  }
}

function extractToken(req: Request): string | undefined {
  const header = req.headers.authorization
  if (typeof header === 'string' && header.startsWith(BEARER_PREFIX)) {
    return header.slice(BEARER_PREFIX.length).trim()
  }
  return readCookie(req.headers.cookie, ACCESS_TOKEN_COOKIE_NAME)
}
