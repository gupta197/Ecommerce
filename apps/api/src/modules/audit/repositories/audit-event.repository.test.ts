import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { AuditEventModel } from '../models/audit-event.model.js'
import * as auditEventRepository from './audit-event.repository.js'

let mongod: MongoMemoryServer

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'sec_003_audit_repo_test' })
  await AuditEventModel.init()
})

after(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await AuditEventModel.deleteMany({})
})

test('creates an audit event with the given fields', async () => {
  const event = await auditEventRepository.create({
    actorUserId: new Types.ObjectId(),
    action: 'auth.login.success',
    entityType: 'User',
    outcome: 'SUCCESS',
    severity: 'INFO',
  })
  assert.equal(event.action, 'auth.login.success')
  assert.equal(event.outcome, 'SUCCESS')
  assert.equal(event.severity, 'INFO')
  assert.ok(event.createdAt instanceof Date)
})

test('the repository module exposes only create() — no update/delete/patch/replace', async () => {
  const repositoryModule = await import('./audit-event.repository.js')
  const exportedNames = Object.keys(repositoryModule)
  assert.deepEqual(exportedNames, ['create'])
})

test('toJSON output never includes __v', async () => {
  const event = await auditEventRepository.create({
    action: 'auth.logout',
    entityType: 'SecuritySession',
    outcome: 'SUCCESS',
    severity: 'INFO',
  })
  const json = event.toJSON() as unknown as Record<string, unknown>
  assert.equal(json.__v, undefined)
})

test('the declared indexes exist', async () => {
  const indexes = await AuditEventModel.collection.indexes()

  const orgIndex = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ organizationId: 1, createdAt: -1 }),
  )
  assert.ok(orgIndex, 'expected an {organizationId: 1, createdAt: -1} index')

  const actorIndex = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ actorUserId: 1, createdAt: -1 }),
  )
  assert.ok(actorIndex, 'expected an {actorUserId: 1, createdAt: -1} index')

  // No TTL index anywhere on this collection.
  for (const idx of indexes) {
    assert.equal(
      idx.expireAfterSeconds,
      undefined,
      `unexpected TTL on index ${JSON.stringify(idx.key)}`,
    )
  }
})

test('rejects an unknown action value (schema enum)', async () => {
  await assert.rejects(() =>
    AuditEventModel.create({
      // @ts-expect-error - deliberately invalid to prove the enum is enforced
      action: 'not.a.real.action',
      entityType: 'User',
      outcome: 'SUCCESS',
      severity: 'INFO',
    }),
  )
})
