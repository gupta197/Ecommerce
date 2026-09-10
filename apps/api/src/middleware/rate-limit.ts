import rateLimit from 'express-rate-limit'

/**
 * In-memory store — correct for a single instance only. NOT coordinated
 * across multiple horizontally-scaled instances; swap for a Redis-backed
 * store (e.g. rate-limit-redis) when distributed deployment / Redis
 * infrastructure is introduced. No route is wired to this yet — it's a
 * reusable factory for SEC-001 and later tasks to apply.
 */
export function createRateLimiter(options: { windowMs: number; max: number }) {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        success: false,
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests, please try again later.',
          details: [],
        },
      })
    },
  })
}
