import { z } from 'zod'

export class ConfigError extends Error {}

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    CORS_ORIGIN: z.string().optional(),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return
    const origin = env.CORS_ORIGIN?.trim()
    if (!origin) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGIN'],
        message: 'CORS_ORIGIN is required in production.',
      })
      return
    }
    if (origin.split(',').some((o) => o.trim() === '*')) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGIN'],
        message: 'CORS_ORIGIN must not be "*" in production.',
      })
    }
  })

function resolveCorsOrigins(raw: string | undefined): string[] {
  const trimmed = raw?.trim()
  if (trimmed) {
    return trimmed.split(',').map((origin) => origin.trim())
  }
  // Only reachable outside production — superRefine above guarantees CORS_ORIGIN
  // is present and non-wildcard whenever NODE_ENV === 'production'.
  return ['http://localhost:5173', 'http://localhost:5174']
}

/** Loads a local .env file if present. A missing file is expected (and fine)
 *  in production/container environments where vars are injected directly. */
export function loadLocalEnvFile(path = '.env'): void {
  try {
    process.loadEnvFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new ConfigError(`Invalid environment configuration: ${issues}`)
  }
  const env = parsed.data
  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    corsOrigins: resolveCorsOrigins(env.CORS_ORIGIN),
    logLevel: env.LOG_LEVEL,
    rateLimit: { windowMs: env.RATE_LIMIT_WINDOW_MS, max: env.RATE_LIMIT_MAX },
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  }
}

export type AppConfig = ReturnType<typeof loadConfig>
