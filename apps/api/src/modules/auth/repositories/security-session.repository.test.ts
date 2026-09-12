import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { SecuritySessionModel } from '../models/security-session.model.js'
import * as securitySessionRepository from './security-session.repository.js'

let mongod: MongoMemoryServer

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'sec_001_session_repo_test' })
  await SecuritySessionModel.init()
})

after(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await SecuritySessionModel.deleteMany({})
})

function oid(): Types.ObjectId {
  return new Types.ObjectId()
}

function makeSessionData(
  overrides: Partial<Parameters<typeof securitySessionRepository.create>[0]> = {},
) {
  const now = new Date()
  return {
    userId: oid(),
    familyId: oid(),
    familyCreatedAt: now,
    refreshTokenHash: 'hash-' + Math.random().toString(36).slice(2),
    lastUsedAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
    ...overrides,
  }
}

test('creates a session with status ACTIVE by default', async () => {
  const session = await securitySessionRepository.create(makeSessionData())
  assert.equal(session.status, 'ACTIVE')
})

test('claimActiveByHash atomically flips ACTIVE to ROTATED and returns the pre-update doc', async () => {
  const created = await securitySessionRepository.create(makeSessionData())
  const claimed = await securitySessionRepository.claimActiveByHash(
    created.refreshTokenHash,
    new Date(),
  )

  assert.ok(claimed)
  assert.equal(claimed?.status, 'ACTIVE') // pre-update snapshot

  const afterClaim = await SecuritySessionModel.findById(created._id)
  assert.equal(afterClaim?.status, 'ROTATED')
})

test('claimActiveByHash fails (returns null) for an already-ROTATED session', async () => {
  const created = await securitySessionRepository.create(makeSessionData())
  await securitySessionRepository.claimActiveByHash(created.refreshTokenHash, new Date())

  const secondClaim = await securitySessionRepository.claimActiveByHash(
    created.refreshTokenHash,
    new Date(),
  )
  assert.equal(secondClaim, null)
})

test('claimActiveByHash fails for an unknown hash', async () => {
  const claimed = await securitySessionRepository.claimActiveByHash('no-such-hash', new Date())
  assert.equal(claimed, null)
})

test('revokeFamily revokes every session sharing a familyId regardless of current status', async () => {
  const familyId = oid()
  const s1 = await securitySessionRepository.create(makeSessionData({ familyId }))
  const s2 = await securitySessionRepository.create(makeSessionData({ familyId }))
  await securitySessionRepository.claimActiveByHash(s1.refreshTokenHash, new Date()) // s1 -> ROTATED

  await securitySessionRepository.revokeFamily(familyId, new Date())

  const s1After = await SecuritySessionModel.findById(s1._id)
  const s2After = await SecuritySessionModel.findById(s2._id)
  assert.equal(s1After?.status, 'REVOKED')
  assert.equal(s2After?.status, 'REVOKED')
})

test('revokeById only revokes a session owned by the given userId', async () => {
  const userId = oid()
  const otherUserId = oid()
  const session = await securitySessionRepository.create(makeSessionData({ userId }))

  const wrongOwnerResult = await securitySessionRepository.revokeById(
    otherUserId,
    session._id,
    new Date(),
  )
  assert.equal(wrongOwnerResult, null)

  const stillActive = await SecuritySessionModel.findById(session._id)
  assert.equal(stillActive?.status, 'ACTIVE')

  const correctOwnerResult = await securitySessionRepository.revokeById(
    userId,
    session._id,
    new Date(),
  )
  assert.equal(correctOwnerResult?.status, 'REVOKED')
})

test('revokeOthers preserves the excepted session and revokes the rest for that user', async () => {
  const userId = oid()
  const keep = await securitySessionRepository.create(makeSessionData({ userId }))
  const other1 = await securitySessionRepository.create(makeSessionData({ userId }))
  const other2 = await securitySessionRepository.create(makeSessionData({ userId }))

  await securitySessionRepository.revokeOthers(userId, keep._id, new Date())

  assert.equal((await SecuritySessionModel.findById(keep._id))?.status, 'ACTIVE')
  assert.equal((await SecuritySessionModel.findById(other1._id))?.status, 'REVOKED')
  assert.equal((await SecuritySessionModel.findById(other2._id))?.status, 'REVOKED')
})

test('listActiveForUser only returns ACTIVE sessions for that user', async () => {
  const userId = oid()
  const otherUserId = oid()
  const active = await securitySessionRepository.create(makeSessionData({ userId }))
  const rotated = await securitySessionRepository.create(makeSessionData({ userId }))
  await securitySessionRepository.create(makeSessionData({ userId: otherUserId }))
  await securitySessionRepository.claimActiveByHash(rotated.refreshTokenHash, new Date())

  const results = await securitySessionRepository.listActiveForUser(userId)
  assert.equal(results.length, 1)
  assert.equal(results[0]?._id.toString(), active._id.toString())
})

test('toJSON output never includes refreshTokenHash or __v', async () => {
  const session = await securitySessionRepository.create(makeSessionData())
  const json = session.toJSON() as unknown as Record<string, unknown>
  assert.equal(json.refreshTokenHash, undefined)
  assert.equal(json.__v, undefined)
})

test('the declared indexes exist, including the unique refreshTokenHash index and the TTL index', async () => {
  const indexes = await SecuritySessionModel.collection.indexes()

  const hashIndex = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ refreshTokenHash: 1 }),
  )
  assert.ok(hashIndex, 'expected a {refreshTokenHash: 1} index')
  assert.equal(hashIndex?.unique, true)

  const userStatusIndex = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ userId: 1, status: 1 }),
  )
  assert.ok(userStatusIndex, 'expected a {userId: 1, status: 1} index')

  const familyIndex = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ familyId: 1 }),
  )
  assert.ok(familyIndex, 'expected a {familyId: 1} index')

  const ttlIndex = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ expiresAt: 1 }),
  )
  assert.ok(ttlIndex, 'expected an {expiresAt: 1} index')
  assert.equal(ttlIndex?.expireAfterSeconds, 0)
})
