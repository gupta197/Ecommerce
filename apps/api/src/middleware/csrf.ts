import type { NextFunction, Request, Response } from 'express'
import { ValidationError } from '../lib/http-errors.js'
import { readCookie } from '../lib/cookies.js'

export const CSRF_COOKIE_NAME = 'xsrf_token'
const CSRF_HEADER_NAME = 'x-xsrf-token'

export interface CsrfOptions {
  allowedOrigins: string[]
}

/**
 * Double-submit cookie check (primary control) plus Origin/Referer
 * validation (defense-in-depth on an independent, browser-enforced signal).
 * Applied only to cookie-authenticated, state-changing auth endpoints —
 * never to /login or /register, which have no pre-existing session/cookie
 * for CSRF to ride on.
 */
export function createCsrfMiddleware(options: CsrfOptions) {
  return function csrf(req: Request, _res: Response, next: NextFunction): void {
    const origin = req.headers.origin
    const referer = req.headers.referer

    if (typeof origin === 'string') {
      if (!options.allowedOrigins.includes(origin)) {
        next(new ValidationError('Request origin is not allowed.'))
        return
      }
    } else if (typeof referer === 'string') {
      const refererOrigin = safeOriginFromUrl(referer)
      if (!refererOrigin || !options.allowedOrigins.includes(refererOrigin)) {
        next(new ValidationError('Request origin is not allowed.'))
        return
      }
    }
    // Neither header present: don't hard-fail on that alone — the
    // double-submit token below is the primary, mandatory control.

    const cookieToken = readCookie(req.headers.cookie, CSRF_COOKIE_NAME)
    const headerValue = req.headers[CSRF_HEADER_NAME]
    const headerToken = Array.isArray(headerValue) ? headerValue[0] : headerValue

    if (!cookieToken || !headerToken || headerToken !== cookieToken) {
      next(new ValidationError('Missing or invalid CSRF token.'))
      return
    }

    next()
  }
}

function safeOriginFromUrl(url: string): string | undefined {
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}
