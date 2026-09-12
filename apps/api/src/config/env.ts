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
    MONGODB_URI: z
      .string()
      .refine((v) => v.startsWith('mongodb://') || v.startsWith('mongodb+srv://'), {
        message: 'MONGODB_URI must start with mongodb:// or mongodb+srv://',
      }),
    MONGODB_DB_NAME: z.string().min(1),
    MONGODB_MAX_POOL_SIZE: z.coerce.number().int().positive().default(10),
    MONGODB_MIN_POOL_SIZE: z.coerce.number().int().nonnegative().default(0),
    MONGODB_SERVER_SELECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    MONGODB_SOCKET_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
    MONGODB_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    MONGODB_INITIAL_CONNECT_RETRIES: z.coerce.number().int().nonnegative().default(5),
    MONGODB_INITIAL_CONNECT_RETRY_DELAY_MS: z.coerce.number().int().positive().default(2_000),
    JWT_ACCESS_TOKEN_SECRET: z.string().min(32),
    ACCESS_TOKEN_TTL_MS: z.coerce.number().int().positive().default(900_000),
    REFRESH_TOKEN_TTL_MS: z.coerce.number().int().positive().default(2_592_000_000),
    ABSOLUTE_SESSION_LIFETIME_MS: z.coerce.number().int().positive().default(7_776_000_000),
    LOGIN_GRACE_ATTEMPTS: z.coerce.number().int().nonnegative().default(3),
    LOGIN_BASE_DELAY_MS: z.coerce.number().int().positive().default(1_000),
    LOGIN_MAX_DELAY_MS: z.coerce.number().int().positive().default(900_000),
    AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
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
    } else if (origin.split(',').some((o) => o.trim() === '*')) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGIN'],
        message: 'CORS_ORIGIN must not be "*" in production.',
      })
    }

    const authority = getMongoAuthority(env.MONGODB_URI)
    if (authority.includes('localhost') || authority.includes('127.0.0.1')) {
      ctx.addIssue({
        code: 'custom',
        path: ['MONGODB_URI'],
        message:
          'MONGODB_URI must not point at localhost/127.0.0.1 in production — this guards ' +
          'against accidentally running production against a development database.',
      })
    }

    const isSrv = env.MONGODB_URI.startsWith('mongodb+srv://')
    const hasExplicitTls = /[?&](tls|ssl)=true/i.test(env.MONGODB_URI)
    if (!isSrv && !hasExplicitTls) {
      ctx.addIssue({
        code: 'custom',
        path: ['MONGODB_URI'],
        message:
          'MONGODB_URI must use mongodb+srv:// or include tls=true/ssl=true in production. ' +
          'This is a startup safety guard, not a substitute for correct infrastructure-level ' +
          'TLS configuration.',
      })
    }
  })

/** Extracts the host(s) portion of a Mongo connection string (credentials
 *  stripped), tolerant of multi-host replica-set URIs that aren't valid
 *  single-authority URLs. */
function getMongoAuthority(uri: string): string {
  const withoutScheme = uri.replace(/^mongodb(\+srv)?:\/\//, '')
  const authority = (withoutScheme.split('/')[0] ?? '').split('?')[0] ?? ''
  const atIndex = authority.lastIndexOf('@')
  return (atIndex === -1 ? authority : authority.slice(atIndex + 1)).toLowerCase()
}

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
    mongo: {
      uri: env.MONGODB_URI,
      dbName: env.MONGODB_DB_NAME,
      maxPoolSize: env.MONGODB_MAX_POOL_SIZE,
      minPoolSize: env.MONGODB_MIN_POOL_SIZE,
      serverSelectionTimeoutMs: env.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
      socketTimeoutMs: env.MONGODB_SOCKET_TIMEOUT_MS,
      queryTimeoutMs: env.MONGODB_QUERY_TIMEOUT_MS,
      initialConnect: {
        retries: env.MONGODB_INITIAL_CONNECT_RETRIES,
        retryDelayMs: env.MONGODB_INITIAL_CONNECT_RETRY_DELAY_MS,
      },
    },
    auth: {
      jwtSecret: env.JWT_ACCESS_TOKEN_SECRET,
      accessTokenTtlMs: env.ACCESS_TOKEN_TTL_MS,
      refreshTokenTtlMs: env.REFRESH_TOKEN_TTL_MS,
      absoluteSessionLifetimeMs: env.ABSOLUTE_SESSION_LIFETIME_MS,
      loginGraceAttempts: env.LOGIN_GRACE_ATTEMPTS,
      loginBaseDelayMs: env.LOGIN_BASE_DELAY_MS,
      loginMaxDelayMs: env.LOGIN_MAX_DELAY_MS,
    },
    authRateLimit: { windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS, max: env.AUTH_RATE_LIMIT_MAX },
  }
}

export type AppConfig = ReturnType<typeof loadConfig>
