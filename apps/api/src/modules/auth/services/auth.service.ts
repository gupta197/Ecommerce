import { Types } from 'mongoose'
import * as userRepository from '../repositories/user.repository.js'
import * as securitySessionRepository from '../repositories/security-session.repository.js'
import * as loginAttemptRepository from '../repositories/login-attempt.repository.js'
import { hashPassword, verifyPassword } from './password.service.js'
import {
  signAccessToken,
  generateJti,
  generateRefreshToken,
  hashRefreshToken,
} from './token.service.js'
import {
  registerSchema,
  loginSchema,
  type RegisterInput,
  type LoginInput,
} from '../validation/auth.schema.js'
import { NotFoundError, UnauthenticatedError } from '../../../lib/http-errors.js'
import type { UserDocument } from '../models/user.model.js'
import type { SecuritySessionDocument } from '../models/security-session.model.js'
import type { Logger } from '../../../lib/logger.js'

export interface AuthRequestContext {
  ipAddress?: string
  userAgent?: string
}

export interface AuthConfig {
  jwtSecret: string
  accessTokenTtlMs: number
  refreshTokenTtlMs: number
  absoluteSessionLifetimeMs: number
  loginGraceAttempts: number
  loginBaseDelayMs: number
  loginMaxDelayMs: number
}

export interface AuthTokens {
  accessToken: string
  refreshToken: string
  accessTokenExpiresAt: Date
  refreshTokenExpiresAt: Date
}

const GENERIC_INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password.'
const GENERIC_INVALID_SESSION_MESSAGE = 'Invalid or expired session.'

/**
 * Never issues a session. Always performs password hashing (even for a
 * duplicate email, whose hash is discarded) so response timing does not
 * distinguish new-account from already-exists. Callers must return the same
 * generic response regardless of which branch executed here — see
 * routes/auth.route.ts.
 */
export async function register(input: unknown, _context: AuthRequestContext): Promise<void> {
  const parsed: RegisterInput = registerSchema.parse(input)
  const passwordHash = await hashPassword(parsed.password)
  await userRepository.create({ email: parsed.email, passwordHash })
  // Result (created vs. duplicate) is intentionally not surfaced to the caller.
}

export async function login(
  input: unknown,
  context: AuthRequestContext,
  config: AuthConfig,
): Promise<{ user: UserDocument; tokens: AuthTokens }> {
  const parsed: LoginInput = loginSchema.parse(input)
  const user = await userRepository.findByEmailWithPassword(parsed.email)

  if (!user) {
    await recordAttempt(parsed.email, undefined, false, 'INVALID_CREDENTIALS', context)
    throw new UnauthenticatedError(GENERIC_INVALID_CREDENTIALS_MESSAGE)
  }

  const now = new Date()

  if (user.nextAttemptAllowedAt && user.nextAttemptAllowedAt.getTime() > now.getTime()) {
    await recordAttempt(parsed.email, user._id, false, 'THROTTLED', context)
    throw new UnauthenticatedError(GENERIC_INVALID_CREDENTIALS_MESSAGE)
  }

  if (user.status !== 'ACTIVE') {
    await recordAttempt(parsed.email, user._id, false, 'ACCOUNT_DISABLED', context)
    throw new UnauthenticatedError(GENERIC_INVALID_CREDENTIALS_MESSAGE)
  }

  const passwordValid = await verifyPassword(user.passwordHash, parsed.password)

  if (!passwordValid) {
    const failedAttempts = user.failedLoginAttempts + 1
    const nextAttemptAllowedAt = computeNextAttemptAllowedAt(failedAttempts, config, now)
    await userRepository.recordLoginFailure(user._id, {
      failedLoginAttempts: failedAttempts,
      nextAttemptAllowedAt,
    })
    await recordAttempt(parsed.email, user._id, false, 'INVALID_CREDENTIALS', context)
    throw new UnauthenticatedError(GENERIC_INVALID_CREDENTIALS_MESSAGE)
  }

  await userRepository.resetLoginFailures(user._id)
  await recordAttempt(parsed.email, user._id, true, undefined, context)

  const tokens = await issueNewSession(user._id, context, config)
  return { user, tokens }
}

/**
 * The atomic-rotation refresh flow (§2 of the approved plan). See
 * security-session.repository.ts's claimActiveByHash for the atomic
 * compare-and-swap this depends on.
 */
export async function refresh(
  presentedToken: string,
  context: AuthRequestContext,
  config: AuthConfig,
  logger: Logger,
): Promise<AuthTokens> {
  const presentedHash = hashRefreshToken(presentedToken)
  const now = new Date()

  const claimed = await securitySessionRepository.claimActiveByHash(presentedHash, now)

  if (!claimed) {
    const existing = await securitySessionRepository.findByRefreshTokenHash(presentedHash)
    if (existing) {
      await securitySessionRepository.revokeFamily(existing.familyId, now)
      logger.warn(
        { familyId: existing.familyId.toString() },
        'Refresh token reuse detected — entire session family revoked',
      )
    }
    throw new UnauthenticatedError(GENERIC_INVALID_SESSION_MESSAGE)
  }

  if (claimed.expiresAt.getTime() < now.getTime()) {
    // Already claimed (flipped to ROTATED) above; nothing further to revoke —
    // it was expired, not reused. Refuse and let TTL clean it up naturally.
    throw new UnauthenticatedError(GENERIC_INVALID_SESSION_MESSAGE)
  }

  if (claimed.familyCreatedAt.getTime() + config.absoluteSessionLifetimeMs <= now.getTime()) {
    await securitySessionRepository.revokeFamily(claimed.familyId, now)
    throw new UnauthenticatedError(GENERIC_INVALID_SESSION_MESSAGE)
  }

  return issueNewSession(claimed.userId, context, config, {
    familyId: claimed.familyId,
    familyCreatedAt: claimed.familyCreatedAt,
  })
}

export async function logoutCurrentSession(
  userId: Types.ObjectId,
  sessionId: Types.ObjectId,
): Promise<void> {
  await securitySessionRepository.revokeById(userId, sessionId, new Date())
}

export async function listSessions(userId: Types.ObjectId): Promise<SecuritySessionDocument[]> {
  return securitySessionRepository.listActiveForUser(userId)
}

export async function revokeSession(
  userId: Types.ObjectId,
  sessionId: Types.ObjectId,
): Promise<SecuritySessionDocument> {
  const revoked = await securitySessionRepository.revokeById(userId, sessionId, new Date())
  if (!revoked) {
    throw new NotFoundError('Session not found.')
  }
  return revoked
}

export async function revokeOtherSessions(
  userId: Types.ObjectId,
  currentSessionId: Types.ObjectId,
): Promise<void> {
  await securitySessionRepository.revokeOthers(userId, currentSessionId, new Date())
}

/** Progressive delay, never a hard lock (§7 of the approved plan) — the
 *  first `loginGraceAttempts` failures cost nothing beyond the existing
 *  IP-based rate limit; delay then doubles per additional failure from
 *  `loginBaseDelayMs`, capped at `loginMaxDelayMs`. A correct password
 *  always resets the counter to zero (resetLoginFailures) — the account is
 *  never permanently or indefinitely inaccessible. */
function computeNextAttemptAllowedAt(
  failedAttempts: number,
  config: AuthConfig,
  now: Date,
): Date | null {
  if (failedAttempts <= config.loginGraceAttempts) {
    return null
  }
  const exponent = failedAttempts - config.loginGraceAttempts
  const delayMs = Math.min(config.loginBaseDelayMs * 2 ** exponent, config.loginMaxDelayMs)
  return new Date(now.getTime() + delayMs)
}

async function recordAttempt(
  email: string,
  userId: Types.ObjectId | undefined,
  success: boolean,
  reason: 'INVALID_CREDENTIALS' | 'ACCOUNT_DISABLED' | 'THROTTLED' | undefined,
  context: AuthRequestContext,
): Promise<void> {
  await loginAttemptRepository.create({
    email,
    userId,
    success,
    reason,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  })
}

async function issueNewSession(
  userId: Types.ObjectId,
  context: AuthRequestContext,
  config: AuthConfig,
  existingFamily?: { familyId: Types.ObjectId; familyCreatedAt: Date },
): Promise<AuthTokens> {
  const now = new Date()
  const familyId = existingFamily?.familyId ?? new Types.ObjectId()
  const familyCreatedAt = existingFamily?.familyCreatedAt ?? now

  const absoluteDeadline = familyCreatedAt.getTime() + config.absoluteSessionLifetimeMs
  const slidingDeadline = now.getTime() + config.refreshTokenTtlMs
  const refreshTokenExpiresAt = new Date(Math.min(slidingDeadline, absoluteDeadline))

  const refreshToken = generateRefreshToken()
  const refreshTokenHash = hashRefreshToken(refreshToken)

  const session = await securitySessionRepository.create({
    userId,
    familyId,
    familyCreatedAt,
    refreshTokenHash,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    lastUsedAt: now,
    expiresAt: refreshTokenExpiresAt,
  })

  const jti = generateJti()
  const accessTokenExpiresAt = new Date(now.getTime() + config.accessTokenTtlMs)
  const accessToken = await signAccessToken(
    { sub: userId.toString(), sid: session._id.toString(), jti },
    config.jwtSecret,
    config.accessTokenTtlMs,
  )

  return { accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt }
}
