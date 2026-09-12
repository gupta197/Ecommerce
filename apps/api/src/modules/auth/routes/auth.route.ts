import { Router, type Request, type Response } from 'express'
import { Types } from 'mongoose'
import { randomBytes } from 'node:crypto'
import * as authService from '../services/auth.service.js'
import type { AuthConfig, AuthTokens } from '../services/auth.service.js'
import { sendSuccess } from '../../../lib/response.js'
import { UnauthenticatedError } from '../../../lib/http-errors.js'
import {
  createAuthenticateMiddleware,
  ACCESS_TOKEN_COOKIE_NAME,
} from '../../../middleware/authenticate.js'
import { createCsrfMiddleware, CSRF_COOKIE_NAME } from '../../../middleware/csrf.js'
import { createRateLimiter } from '../../../middleware/rate-limit.js'
import { readCookie } from '../../../lib/cookies.js'
import { sessionIdParamSchema } from '../validation/auth.schema.js'
import type { Logger } from '../../../lib/logger.js'

const REFRESH_TOKEN_COOKIE_NAME = 'refresh_token'
const REFRESH_COOKIE_PATH = '/api/v1/auth'

export interface CreateAuthRouterOptions {
  authConfig: AuthConfig
  authRateLimit: { windowMs: number; max: number }
  allowedOrigins: string[]
  isProduction: boolean
  logger: Logger
}

function requestContext(req: Request): { ipAddress?: string; userAgent?: string } {
  const userAgentHeader = req.headers['user-agent']
  return {
    ipAddress: req.ip,
    userAgent: Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader,
  }
}

export function createAuthRouter(options: CreateAuthRouterOptions): Router {
  const router = Router()
  const authenticate = createAuthenticateMiddleware(options.authConfig.jwtSecret)
  const csrf = createCsrfMiddleware({ allowedOrigins: options.allowedOrigins })
  const authRateLimiter = createRateLimiter(options.authRateLimit)

  function setAuthCookies(res: Response, tokens: AuthTokens): void {
    res.cookie(ACCESS_TOKEN_COOKIE_NAME, tokens.accessToken, {
      httpOnly: true,
      secure: options.isProduction,
      sameSite: 'lax',
      path: '/',
      expires: tokens.accessTokenExpiresAt,
    })
    res.cookie(REFRESH_TOKEN_COOKIE_NAME, tokens.refreshToken, {
      httpOnly: true,
      secure: options.isProduction,
      sameSite: 'lax',
      path: REFRESH_COOKIE_PATH,
      expires: tokens.refreshTokenExpiresAt,
    })
    // Non-HttpOnly by design — the double-submit CSRF pattern requires
    // client-side JS to read this value and echo it back in a header.
    res.cookie(CSRF_COOKIE_NAME, randomBytes(16).toString('hex'), {
      httpOnly: false,
      secure: options.isProduction,
      sameSite: 'lax',
      path: '/',
      expires: tokens.accessTokenExpiresAt,
    })
  }

  function clearAuthCookies(res: Response): void {
    res.clearCookie(ACCESS_TOKEN_COOKIE_NAME, { path: '/' })
    res.clearCookie(REFRESH_TOKEN_COOKIE_NAME, { path: REFRESH_COOKIE_PATH })
    res.clearCookie(CSRF_COOKIE_NAME, { path: '/' })
  }

  router.post('/register', authRateLimiter, async (req, res) => {
    await authService.register(req.body, requestContext(req))
    sendSuccess(
      res,
      { message: 'If this email is available, your account has been created. Please log in.' },
      {},
      201,
    )
  })

  router.post('/login', authRateLimiter, async (req, res) => {
    const { user, tokens } = await authService.login(
      req.body,
      requestContext(req),
      options.authConfig,
    )
    setAuthCookies(res, tokens)
    sendSuccess(res, { id: user._id, email: user.email })
  })

  router.post('/logout', authenticate, csrf, async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    await authService.logoutCurrentSession(
      new Types.ObjectId(req.auth.userId),
      new Types.ObjectId(req.auth.sessionId),
    )
    clearAuthCookies(res)
    sendSuccess(res, { loggedOut: true })
  })

  router.post('/refresh', csrf, async (req, res) => {
    const presented = readCookie(req.headers.cookie, REFRESH_TOKEN_COOKIE_NAME)
    if (!presented) {
      throw new UnauthenticatedError('Invalid or expired session.')
    }
    const tokens = await authService.refresh(
      presented,
      requestContext(req),
      options.authConfig,
      options.logger,
    )
    setAuthCookies(res, tokens)
    sendSuccess(res, { refreshed: true })
  })

  router.get('/sessions', authenticate, async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    const sessions = await authService.listSessions(new Types.ObjectId(req.auth.userId))
    sendSuccess(res, sessions)
  })

  router.post('/sessions/:id/revoke', authenticate, csrf, async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    const { id } = sessionIdParamSchema.parse(req.params)
    const session = await authService.revokeSession(
      new Types.ObjectId(req.auth.userId),
      new Types.ObjectId(id),
    )
    sendSuccess(res, session)
  })

  router.post('/sessions/revoke-others', authenticate, csrf, async (req, res) => {
    if (!req.auth) {
      throw new UnauthenticatedError()
    }
    await authService.revokeOtherSessions(
      new Types.ObjectId(req.auth.userId),
      new Types.ObjectId(req.auth.sessionId),
    )
    sendSuccess(res, { revoked: true })
  })

  return router
}
