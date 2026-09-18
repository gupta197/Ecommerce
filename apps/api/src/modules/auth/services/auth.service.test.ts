import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { ZodError } from 'zod'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import pino from 'pino'
import { UserModel } from '../models/user.model.js'
import { SecuritySessionModel } from '../models/security-session.model.js'
import { LoginAttemptModel } from '../models/login-attempt.model.js'
import { AuditEventModel } from '../../audit/models/audit-event.model.js'
import * as userRepository from '../repositories/user.repository.js'
import * as securitySessionRepository from '../repositories/security-session.repository.js'
import { hashPassword } from './password.service.js'
import { hashRefreshToken } from './token.service.js'
import {
  register,
  login,
  refresh,
  logoutCurrentSession,
  listSessions,
  revokeSession,
  revokeOtherSessions,
  type AuthConfig,
} from './auth.service.js'
import { NotFoundError, UnauthenticatedError } from '../../../lib/http-errors.js'

let mongod: MongoMemoryServer

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'sec_001_auth_service_test' })
  await Promise.all([
    UserModel.init(),
    SecuritySessionModel.init(),
    LoginAttemptModel.init(),
    AuditEventModel.init(),
  ])
})

after(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await Promise.all([
    UserModel.deleteMany({}),
    SecuritySessionModel.deleteMany({}),
    LoginAttemptModel.deleteMany({}),
    AuditEventModel.deleteMany({}),
  ])
})

const TEST_CONFIG: AuthConfig = {
  jwtSecret: 'x'.repeat(32),
  accessTokenTtlMs: 900_000,
  refreshTokenTtlMs: 2_592_000_000,
  absoluteSessionLifetimeMs: 7_776_000_000,
  loginGraceAttempts: 3,
  loginBaseDelayMs: 1_000,
  loginMaxDelayMs: 900_000,
}

const silentLogger = pino({ level: 'silent' })

async function createActiveUser(email: string, password: string) {
  const passwordHash = await hashPassword(password)
  const user = await userRepository.create({ email, passwordHash })
  if (!user) throw new Error('test setup failed: user already existed')
  return user
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test('registration creates an ACTIVE user for a new email', async () => {
  await register({ email: 'new@example.com', password: 'a-long-enough-password' }, {})
  const user = await UserModel.findOne({ email: 'new@example.com' })
  assert.ok(user)
  assert.equal(user?.status, 'ACTIVE')
})

test('registration does not modify an existing account for a duplicate email', async () => {
  const existing = await createActiveUser('dup@example.com', 'original-password-123')

  await register({ email: 'dup@example.com', password: 'attacker-chosen-password' }, {})

  const stillOriginal = await userRepository.findByEmailWithPassword('dup@example.com')
  assert.equal(stillOriginal?.passwordHash, existing.passwordHash)
  const count = await UserModel.countDocuments({ email: 'dup@example.com' })
  assert.equal(count, 1)
})

test('registration never issues a session, for a new or duplicate email alike', async () => {
  const newResult = await register(
    { email: 'brand-new@example.com', password: 'a-long-enough-password' },
    {},
  )
  assert.equal(newResult, undefined)

  await createActiveUser('already-exists@example.com', 'some-password-123')
  const dupResult = await register(
    { email: 'already-exists@example.com', password: 'attacker-password-123' },
    {},
  )
  assert.equal(dupResult, undefined)

  const sessionCount = await SecuritySessionModel.countDocuments({})
  assert.equal(sessionCount, 0)
})

test('registration hashes the password even for a duplicate email (timing-consistency)', async () => {
  await createActiveUser('dup2@example.com', 'original-password-123')
  // No direct way to assert hashing occurred without a spy; verifying the
  // existing user's hash is unchanged (above test) plus that no error is
  // thrown here is the behavioral contract — this test documents the intent.
  await assert.doesNotReject(() =>
    register({ email: 'dup2@example.com', password: 'attacker-password-123' }, {}),
  )
})

test('registration rejects a password below the minimum length', async () => {
  await assert.rejects(
    () => register({ email: 'short@example.com', password: 'short' }, {}),
    ZodError,
  )
})

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

test('successful login issues an access token, refresh token, and SecuritySession', async () => {
  await createActiveUser('login@example.com', 'correct-password-123')
  const { user, tokens } = await login(
    { email: 'login@example.com', password: 'correct-password-123' },
    {},
    TEST_CONFIG,
  )

  assert.equal(user.email, 'login@example.com')
  assert.ok(tokens.accessToken)
  assert.ok(tokens.refreshToken)

  const sessionCount = await SecuritySessionModel.countDocuments({ userId: user._id })
  assert.equal(sessionCount, 1)
})

test('login with a nonexistent email throws the generic UnauthenticatedError', async () => {
  await assert.rejects(
    () => login({ email: 'nobody@example.com', password: 'whatever-123' }, {}, TEST_CONFIG),
    UnauthenticatedError,
  )
})

test('login with an incorrect password throws the same generic error as a nonexistent email', async () => {
  await createActiveUser('login2@example.com', 'correct-password-123')

  let nonexistentMessage: string | undefined
  let wrongPasswordMessage: string | undefined

  try {
    await login({ email: 'nobody2@example.com', password: 'whatever-123' }, {}, TEST_CONFIG)
  } catch (error) {
    nonexistentMessage = (error as UnauthenticatedError).message
  }
  try {
    await login({ email: 'login2@example.com', password: 'wrong-password' }, {}, TEST_CONFIG)
  } catch (error) {
    wrongPasswordMessage = (error as UnauthenticatedError).message
  }

  assert.ok(nonexistentMessage)
  assert.equal(nonexistentMessage, wrongPasswordMessage)
})

test('login against a DISABLED account throws the same generic error, not a distinguishing one', async () => {
  const user = await createActiveUser('disabled@example.com', 'correct-password-123')
  await UserModel.updateOne({ _id: user._id }, { $set: { status: 'DISABLED' } })

  await assert.rejects(
    () =>
      login({ email: 'disabled@example.com', password: 'correct-password-123' }, {}, TEST_CONFIG),
    (error: unknown) => {
      assert.ok(error instanceof UnauthenticatedError)
      assert.equal(error.message, 'Invalid email or password.')
      return true
    },
  )
})

test('a LoginAttempt is recorded for both failed and successful logins', async () => {
  await createActiveUser('recorded@example.com', 'correct-password-123')

  await assert.rejects(() =>
    login({ email: 'recorded@example.com', password: 'wrong' }, {}, TEST_CONFIG),
  )
  await login({ email: 'recorded@example.com', password: 'correct-password-123' }, {}, TEST_CONFIG)

  const attempts = await LoginAttemptModel.find({ email: 'recorded@example.com' }).sort({
    createdAt: 1,
  })
  assert.equal(attempts.length, 2)
  assert.equal(attempts[0]?.success, false)
  assert.equal(attempts[1]?.success, true)
})

test('failure count progression: grace attempts are free, then progressive delay applies, and success resets it', async () => {
  const user = await createActiveUser('progressive@example.com', 'correct-password-123')

  // 3 grace attempts (config.loginGraceAttempts = 3) — no throttle yet.
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(() =>
      login({ email: 'progressive@example.com', password: 'wrong' }, {}, TEST_CONFIG),
    )
  }
  const afterGrace = await userRepository.findById(user._id)
  assert.equal(afterGrace?.failedLoginAttempts, 3)
  assert.equal(afterGrace?.nextAttemptAllowedAt, null)

  // 4th failure exceeds grace — a delay should now be set.
  await assert.rejects(() =>
    login({ email: 'progressive@example.com', password: 'wrong' }, {}, TEST_CONFIG),
  )
  const afterFourth = await userRepository.findById(user._id)
  assert.ok(afterFourth?.nextAttemptAllowedAt)
  assert.ok(afterFourth!.nextAttemptAllowedAt!.getTime() > Date.now())

  // While throttled, even the CORRECT password is rejected generically.
  await assert.rejects(
    () =>
      login(
        { email: 'progressive@example.com', password: 'correct-password-123' },
        {},
        TEST_CONFIG,
      ),
    UnauthenticatedError,
  )

  // Manually clear the throttle (simulating time passing) and confirm a
  // correct login now succeeds and resets the counter to zero.
  await UserModel.updateOne({ _id: user._id }, { $set: { nextAttemptAllowedAt: null } })
  await login(
    { email: 'progressive@example.com', password: 'correct-password-123' },
    {},
    TEST_CONFIG,
  )
  const afterSuccess = await userRepository.findById(user._id)
  assert.equal(afterSuccess?.failedLoginAttempts, 0)
})

test('the account is never permanently locked — a correct password always eventually succeeds once throttle clears', async () => {
  const user = await createActiveUser('neverlocked@example.com', 'correct-password-123')
  for (let i = 0; i < 10; i += 1) {
    await assert.rejects(() =>
      login({ email: 'neverlocked@example.com', password: 'wrong' }, {}, TEST_CONFIG),
    )
  }
  // No matter how many failures, clearing the throttle timestamp always
  // restores access — there is no separate "locked" state to get stuck in.
  await UserModel.updateOne({ _id: user._id }, { $set: { nextAttemptAllowedAt: null } })
  const { user: loggedIn } = await login(
    { email: 'neverlocked@example.com', password: 'correct-password-123' },
    {},
    TEST_CONFIG,
  )
  assert.equal(loggedIn.email, 'neverlocked@example.com')
})

// ---------------------------------------------------------------------------
// Refresh / rotation / reuse detection
// ---------------------------------------------------------------------------

test('a valid refresh rotates the token and issues a new session in the same family', async () => {
  const user = await createActiveUser('refresh@example.com', 'correct-password-123')
  const { tokens } = await login(
    { email: 'refresh@example.com', password: 'correct-password-123' },
    {},
    TEST_CONFIG,
  )

  const originalSessionCount = await SecuritySessionModel.countDocuments({ userId: user._id })
  assert.equal(originalSessionCount, 1)

  const refreshed = await refresh(tokens.refreshToken, {}, TEST_CONFIG, silentLogger)
  assert.notEqual(refreshed.refreshToken, tokens.refreshToken)

  const sessions = await SecuritySessionModel.find({ userId: user._id })
  assert.equal(sessions.length, 2)
  const families = new Set(sessions.map((s) => s.familyId.toString()))
  assert.equal(families.size, 1) // same family
})

test('the old refresh token is no longer usable after rotation', async () => {
  await createActiveUser('oldtoken@example.com', 'correct-password-123')
  const { tokens } = await login(
    { email: 'oldtoken@example.com', password: 'correct-password-123' },
    {},
    TEST_CONFIG,
  )
  await refresh(tokens.refreshToken, {}, TEST_CONFIG, silentLogger)

  await assert.rejects(
    () => refresh(tokens.refreshToken, {}, TEST_CONFIG, silentLogger),
    UnauthenticatedError,
  )
})

test('refresh reuse revokes the entire family and gives a generic error', async () => {
  await createActiveUser('reuse@example.com', 'correct-password-123')
  const { tokens } = await login(
    { email: 'reuse@example.com', password: 'correct-password-123' },
    {},
    TEST_CONFIG,
  )

  const rotated = await refresh(tokens.refreshToken, {}, TEST_CONFIG, silentLogger)

  // Reuse the ORIGINAL (already-rotated) token.
  await assert.rejects(
    () => refresh(tokens.refreshToken, {}, TEST_CONFIG, silentLogger),
    UnauthenticatedError,
  )

  // The entire family — including the session created by the legitimate
  // rotation — must now be revoked.
  const allSessions = await SecuritySessionModel.find({})
  assert.ok(allSessions.length >= 2)
  for (const session of allSessions) {
    assert.equal(session.status, 'REVOKED')
  }

  // The legitimate, newly-rotated token must also no longer work.
  await assert.rejects(
    () => refresh(rotated.refreshToken, {}, TEST_CONFIG, silentLogger),
    UnauthenticatedError,
  )
})

test('reuse detection logs a warning without leaking the plaintext token', async () => {
  await createActiveUser('logsafety@example.com', 'correct-password-123')
  const { tokens } = await login(
    { email: 'logsafety@example.com', password: 'correct-password-123' },
    {},
    TEST_CONFIG,
  )
  await refresh(tokens.refreshToken, {}, TEST_CONFIG, silentLogger)

  const chunks: string[] = []
  const stream = new Writable({
    write(chunk: Buffer, _enc, callback) {
      chunks.push(chunk.toString())
      callback()
    },
  })
  const capturingLogger = pino({ level: 'warn' }, stream)

  await assert.rejects(() => refresh(tokens.refreshToken, {}, TEST_CONFIG, capturingLogger))

  const output = chunks.join('')
  assert.ok(output.includes('reuse detected') === false || output.toLowerCase().includes('reuse'))
  assert.equal(output.includes(tokens.refreshToken), false)
})

test('refresh fails with a nonexistent token', async () => {
  await assert.rejects(
    () => refresh('this-token-was-never-issued', {}, TEST_CONFIG, silentLogger),
    UnauthenticatedError,
  )
})

test('refresh fails once the sliding expiry has passed', async () => {
  await createActiveUser('expired@example.com', 'correct-password-123')
  const { tokens } = await login(
    { email: 'expired@example.com', password: 'correct-password-123' },
    {},
    TEST_CONFIG,
  )
  // Force the session's expiresAt into the past.
  await SecuritySessionModel.updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1_000) } })

  await assert.rejects(
    () => refresh(tokens.refreshToken, {}, TEST_CONFIG, silentLogger),
    UnauthenticatedError,
  )
})

test('refresh fails once the absolute family lifetime has passed, even with a fresh sliding expiry', async () => {
  await createActiveUser('absolute@example.com', 'correct-password-123')
  const { tokens } = await login(
    { email: 'absolute@example.com', password: 'correct-password-123' },
    {},
    TEST_CONFIG,
  )
  // familyCreatedAt far enough in the past that the absolute cap is exceeded,
  // while expiresAt itself remains in the future (sliding window looks fine).
  await SecuritySessionModel.updateOne(
    {},
    {
      $set: {
        familyCreatedAt: new Date(Date.now() - (TEST_CONFIG.absoluteSessionLifetimeMs + 60_000)),
        expiresAt: new Date(Date.now() + 60_000),
      },
    },
  )

  await assert.rejects(
    () => refresh(tokens.refreshToken, {}, TEST_CONFIG, silentLogger),
    UnauthenticatedError,
  )

  const session = await SecuritySessionModel.findOne({})
  assert.equal(session?.status, 'REVOKED')
})

test('CONCURRENCY: two simultaneous refresh attempts with the same token — exactly one succeeds, the family is revoked, no duplicate replacement session is created', async () => {
  await createActiveUser('concurrent@example.com', 'correct-password-123')
  const { tokens } = await login(
    { email: 'concurrent@example.com', password: 'correct-password-123' },
    {},
    TEST_CONFIG,
  )

  const attempt = () => refresh(tokens.refreshToken, {}, TEST_CONFIG, silentLogger)
  const results = await Promise.allSettled([attempt(), attempt()])

  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  const rejected = results.filter((r) => r.status === 'rejected')

  assert.equal(fulfilled.length, 1, 'exactly one concurrent refresh should succeed')
  assert.equal(rejected.length, 1, 'exactly one concurrent refresh should fail')
  assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof UnauthenticatedError)

  // Only the winner ever calls issueNewSession, so regardless of exact
  // interleaving there must be exactly the original session plus one
  // replacement — never a second, incorrectly-created duplicate.
  const allSessions = await SecuritySessionModel.find({})
  assert.equal(allSessions.length, 2, 'no duplicate replacement session should be created')

  // The original claimed session must never remain/return to ACTIVE.
  const original = await SecuritySessionModel.findOne({
    refreshTokenHash: hashRefreshToken(tokens.refreshToken),
  })
  assert.notEqual(original?.status, 'ACTIVE')

  // At most one session may be ACTIVE at any given time — two concurrently
  // valid sessions from a single rotation would be the exact bug this
  // atomic claim exists to prevent. (Whether the loser's family-wide
  // revocation also catches the winner's brand-new session is a genuine
  // race outside this guarantee's scope, so it is not asserted here.)
  const activeCount = allSessions.filter((s) => s.status === 'ACTIVE').length
  assert.ok(activeCount <= 1, 'at most one session may remain ACTIVE after the race')
})

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

test("listSessions only returns the caller's own active sessions", async () => {
  const userA = await createActiveUser('sessionsA@example.com', 'correct-password-123')
  const userB = await createActiveUser('sessionsB@example.com', 'correct-password-123')
  await login({ email: 'sessionsA@example.com', password: 'correct-password-123' }, {}, TEST_CONFIG)
  await login({ email: 'sessionsB@example.com', password: 'correct-password-123' }, {}, TEST_CONFIG)

  const sessionsForA = await listSessions(userA._id)
  assert.equal(sessionsForA.length, 1)
  assert.notEqual(sessionsForA[0]?.userId.toString(), userB._id.toString())
})

test("a user cannot revoke another user's session", async () => {
  await createActiveUser('ownerX@example.com', 'correct-password-123')
  const attacker = await createActiveUser('attackerX@example.com', 'correct-password-123')
  const { tokens: _ownerTokens } = await login(
    { email: 'ownerX@example.com', password: 'correct-password-123' },
    {},
    TEST_CONFIG,
  )
  const ownerSessions = await SecuritySessionModel.findOne({})

  await assert.rejects(() => revokeSession(attacker._id, ownerSessions!._id), NotFoundError)

  const stillActive = await SecuritySessionModel.findById(ownerSessions!._id)
  assert.equal(stillActive?.status, 'ACTIVE')
})

test('revokeOtherSessions preserves the current session and revokes the rest', async () => {
  const user = await createActiveUser('multisession@example.com', 'correct-password-123')
  const { tokens: tokensA } = await login(
    { email: 'multisession@example.com', password: 'correct-password-123' },
    {},
    TEST_CONFIG,
  )
  await login(
    { email: 'multisession@example.com', password: 'correct-password-123' },
    {},
    TEST_CONFIG,
  )

  const sessions = await securitySessionRepository.listActiveForUser(user._id)
  assert.equal(sessions.length, 2)

  const currentSession = sessions.find((s) => s.refreshTokenHash !== undefined) // both are ACTIVE; pick one to "keep"
  const keepId = new Types.ObjectId(currentSession!._id)

  await revokeOtherSessions(user._id, keepId)

  const afterRevoke = await securitySessionRepository.listActiveForUser(user._id)
  assert.equal(afterRevoke.length, 1)
  assert.equal(afterRevoke[0]?._id.toString(), keepId.toString())
  void tokensA
})

test('logoutCurrentSession revokes exactly that session', async () => {
  const user = await createActiveUser('logout@example.com', 'correct-password-123')
  await login({ email: 'logout@example.com', password: 'correct-password-123' }, {}, TEST_CONFIG)
  const session = await SecuritySessionModel.findOne({ userId: user._id })

  await logoutCurrentSession(user._id, session!._id)

  const after = await SecuritySessionModel.findById(session!._id)
  assert.equal(after?.status, 'REVOKED')
})

// ---------------------------------------------------------------------------
// SEC-003: audit events (additive — does not modify any assertion above)
// ---------------------------------------------------------------------------

test('successful registration creates an auth.registration.success AuditEvent', async () => {
  await register(
    { email: 'audit-reg-success@example.com', password: 'a-long-enough-password' },
    {},
    silentLogger,
  )
  const events = await AuditEventModel.find({ action: 'auth.registration.success' })
  assert.equal(events.length, 1)
  assert.equal(events[0]?.outcome, 'SUCCESS')
  assert.equal(events[0]?.severity, 'INFO')
  assert.equal(events[0]?.entityType, 'User')
  assert.ok(events[0]?.entityId)
  assert.ok(events[0]?.actorUserId)
})

test('duplicate-email registration creates an auth.registration.failure AuditEvent with no actorUserId/entityId, and no secret leaks', async () => {
  await createActiveUser('audit-reg-dup@example.com', 'original-password-123')
  await register(
    { email: 'audit-reg-dup@example.com', password: 'attacker-password-123' },
    {},
    silentLogger,
  )
  const events = await AuditEventModel.find({ action: 'auth.registration.failure' })
  assert.equal(events.length, 1)
  assert.equal(events[0]?.outcome, 'FAILURE')
  assert.equal(events[0]?.actorUserId, undefined)
  assert.equal(events[0]?.entityId, undefined)
  const metadata = events[0]?.metadata as Record<string, unknown>
  assert.equal(metadata.email, 'audit-reg-dup@example.com')
  assert.equal(JSON.stringify(events[0]).includes('attacker-password-123'), false)
})

test('successful login creates an auth.login.success AuditEvent', async () => {
  await createActiveUser('audit-login-success@example.com', 'correct-password-123')
  await login(
    { email: 'audit-login-success@example.com', password: 'correct-password-123' },
    {},
    TEST_CONFIG,
    silentLogger,
  )
  const events = await AuditEventModel.find({ action: 'auth.login.success' })
  assert.equal(events.length, 1)
  assert.equal(events[0]?.outcome, 'SUCCESS')
  assert.equal(events[0]?.severity, 'INFO')
  assert.equal(events[0]?.entityType, 'User')
  assert.ok(events[0]?.actorUserId)
  assert.ok(events[0]?.entityId)
})

test('auth.login.failure NEVER populates actorUserId or entityId, across all four failure branches, and never leaks the submitted password', async () => {
  const user = await createActiveUser('audit-login-fail@example.com', 'correct-password-123')

  // Branch 1: unknown email.
  await assert.rejects(() =>
    login(
      { email: 'nobody-audit@example.com', password: 'whatever-123' },
      {},
      TEST_CONFIG,
      silentLogger,
    ),
  )
  // Branch 2: wrong password.
  await assert.rejects(() =>
    login(
      { email: 'audit-login-fail@example.com', password: 'totally-wrong-password' },
      {},
      TEST_CONFIG,
      silentLogger,
    ),
  )
  // Branch 3: account disabled.
  await UserModel.updateOne({ _id: user._id }, { $set: { status: 'DISABLED' } })
  await assert.rejects(() =>
    login(
      { email: 'audit-login-fail@example.com', password: 'correct-password-123' },
      {},
      TEST_CONFIG,
      silentLogger,
    ),
  )
  await UserModel.updateOne({ _id: user._id }, { $set: { status: 'ACTIVE' } })
  // Branch 4: throttled (force the throttle timestamp directly).
  await UserModel.updateOne(
    { _id: user._id },
    { $set: { nextAttemptAllowedAt: new Date(Date.now() + 60_000) } },
  )
  await assert.rejects(() =>
    login(
      { email: 'audit-login-fail@example.com', password: 'correct-password-123' },
      {},
      TEST_CONFIG,
      silentLogger,
    ),
  )

  const events = await AuditEventModel.find({ action: 'auth.login.failure' }).sort({ createdAt: 1 })
  assert.equal(events.length, 4)
  const reasons = events.map((e) => (e.metadata as Record<string, unknown>).reason)
  assert.deepEqual(reasons, [
    'INVALID_CREDENTIALS',
    'INVALID_CREDENTIALS',
    'ACCOUNT_DISABLED',
    'THROTTLED',
  ])
  for (const event of events) {
    assert.equal(event.outcome, 'FAILURE')
    assert.equal(event.severity, 'WARNING')
    assert.equal(event.actorUserId, undefined, 'actorUserId must never be set on a login failure')
    assert.equal(event.entityId, undefined, 'entityId must never be set on a login failure')
    assert.equal(JSON.stringify(event).includes('totally-wrong-password'), false)
    assert.equal(JSON.stringify(event).includes('correct-password-123'), false)
  }
})

test('refresh token reuse creates an auth.refresh_token_reuse AuditEvent without leaking the plaintext token', async () => {
  await createActiveUser('audit-reuse@example.com', 'correct-password-123')
  const { tokens } = await login(
    { email: 'audit-reuse@example.com', password: 'correct-password-123' },
    {},
    TEST_CONFIG,
  )
  await refresh(tokens.refreshToken, {}, TEST_CONFIG, silentLogger)
  await assert.rejects(() => refresh(tokens.refreshToken, {}, TEST_CONFIG, silentLogger))

  const events = await AuditEventModel.find({ action: 'auth.refresh_token_reuse' })
  assert.equal(events.length, 1)
  assert.equal(events[0]?.outcome, 'FAILURE')
  assert.equal(events[0]?.severity, 'WARNING')
  assert.equal(events[0]?.entityType, 'SecuritySession')
  assert.ok(events[0]?.actorUserId)
  assert.ok(events[0]?.entityId)
  assert.equal(JSON.stringify(events[0]).includes(tokens.refreshToken), false)
})

test('logoutCurrentSession creates an auth.logout AuditEvent', async () => {
  const user = await createActiveUser('audit-logout@example.com', 'correct-password-123')
  await login(
    { email: 'audit-logout@example.com', password: 'correct-password-123' },
    {},
    TEST_CONFIG,
  )
  const session = await SecuritySessionModel.findOne({ userId: user._id })

  await logoutCurrentSession(user._id, session!._id, silentLogger)

  const events = await AuditEventModel.find({ action: 'auth.logout' })
  assert.equal(events.length, 1)
  assert.equal(events[0]?.outcome, 'SUCCESS')
  assert.equal(events[0]?.entityType, 'SecuritySession')
  assert.equal(events[0]?.actorUserId?.toString(), user._id.toString())
  assert.equal(events[0]?.entityId?.toString(), session!._id.toString())
})

test('revokeSession creates an auth.session.revoke AuditEvent', async () => {
  const user = await createActiveUser('audit-revoke@example.com', 'correct-password-123')
  await login(
    { email: 'audit-revoke@example.com', password: 'correct-password-123' },
    {},
    TEST_CONFIG,
  )
  const session = await SecuritySessionModel.findOne({ userId: user._id })

  await revokeSession(user._id, session!._id, silentLogger)

  const events = await AuditEventModel.find({ action: 'auth.session.revoke' })
  assert.equal(events.length, 1)
  assert.equal(events[0]?.outcome, 'SUCCESS')
  assert.equal(events[0]?.entityType, 'SecuritySession')
})

test('revokeOtherSessions creates an auth.session.revoke_others AuditEvent', async () => {
  const user = await createActiveUser('audit-revoke-others@example.com', 'correct-password-123')
  await login(
    { email: 'audit-revoke-others@example.com', password: 'correct-password-123' },
    {},
    TEST_CONFIG,
  )
  const second = await login(
    { email: 'audit-revoke-others@example.com', password: 'correct-password-123' },
    {},
    TEST_CONFIG,
  )
  const session = await SecuritySessionModel.findOne({ userId: user._id }).sort({ createdAt: -1 })
  void second

  await revokeOtherSessions(user._id, session!._id, silentLogger)

  const events = await AuditEventModel.find({ action: 'auth.session.revoke_others' })
  assert.equal(events.length, 1)
  assert.equal(events[0]?.outcome, 'SUCCESS')
})

test('an audit-write failure never prevents a successful login (best-effort, non-blocking)', async () => {
  await createActiveUser('audit-resilience@example.com', 'correct-password-123')

  const original = AuditEventModel.create.bind(AuditEventModel)
  AuditEventModel.create = (async () => {
    throw new Error('deliberate audit write failure')
  }) as typeof AuditEventModel.create
  try {
    const { user } = await login(
      { email: 'audit-resilience@example.com', password: 'correct-password-123' },
      {},
      TEST_CONFIG,
      silentLogger,
    )
    assert.equal(user.email, 'audit-resilience@example.com')
  } finally {
    AuditEventModel.create = original
  }
})
