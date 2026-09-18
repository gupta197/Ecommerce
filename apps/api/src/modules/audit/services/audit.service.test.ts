import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import pino from 'pino'
import { AuditEventModel } from '../models/audit-event.model.js'
import { record } from './audit.service.js'

let mongod: MongoMemoryServer

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'sec_003_audit_service_test' })
  await AuditEventModel.init()
})

after(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await AuditEventModel.deleteMany({})
})

const silentLogger = pino({ level: 'silent' })

test('record() persists a well-formed audit event', async () => {
  await record(
    {
      actorUserId: new Types.ObjectId(),
      action: 'auth.login.success',
      entityType: 'User',
      outcome: 'SUCCESS',
      severity: 'INFO',
      ipAddress: '203.0.113.1',
      userAgent: 'test-agent',
    },
    silentLogger,
  )
  const events = await AuditEventModel.find({})
  assert.equal(events.length, 1)
  assert.equal(events[0]?.action, 'auth.login.success')
  assert.equal(events[0]?.ipAddress, '203.0.113.1')
})

test('record() works without a logger argument at all', async () => {
  await record({
    action: 'auth.logout',
    entityType: 'SecuritySession',
    outcome: 'SUCCESS',
    severity: 'INFO',
  })
  const events = await AuditEventModel.find({})
  assert.equal(events.length, 1)
})

// Stubbing AuditEventModel.create (a mutable Mongoose Model static, exactly
// like OrganizationMembershipModel.create is stubbed in SEC-002's own
// rollback tests) — NOT auditEventRepository.create, which is an ES module
// namespace export and therefore immutable (assigning to it throws).

test('record() never throws even when the underlying write fails', async () => {
  const original = AuditEventModel.create.bind(AuditEventModel)
  AuditEventModel.create = (async () => {
    throw new Error('deliberate audit write failure')
  }) as typeof AuditEventModel.create
  try {
    await assert.doesNotReject(() =>
      record({
        action: 'auth.login.success',
        entityType: 'User',
        outcome: 'SUCCESS',
        severity: 'INFO',
      }),
    )
  } finally {
    AuditEventModel.create = original
  }
})

test('record() logs a warning when the write fails and a logger is provided', async () => {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk: Buffer, _enc, callback) {
      chunks.push(chunk.toString())
      callback()
    },
  })
  const capturingLogger = pino({ level: 'warn' }, stream)

  const original = AuditEventModel.create.bind(AuditEventModel)
  AuditEventModel.create = (async () => {
    throw new Error('deliberate audit write failure')
  }) as typeof AuditEventModel.create
  try {
    await record(
      {
        action: 'auth.login.success',
        entityType: 'User',
        outcome: 'SUCCESS',
        severity: 'INFO',
      },
      capturingLogger,
    )
  } finally {
    AuditEventModel.create = original
  }

  const output = chunks.join('')
  assert.ok(output.toLowerCase().includes('audit event write failed'))
})

test('record() does not log anything when the write fails and no logger is provided (silent swallow)', async () => {
  const original = AuditEventModel.create.bind(AuditEventModel)
  AuditEventModel.create = (async () => {
    throw new Error('deliberate audit write failure')
  }) as typeof AuditEventModel.create
  try {
    await assert.doesNotReject(() =>
      record({
        action: 'auth.login.success',
        entityType: 'User',
        outcome: 'SUCCESS',
        severity: 'INFO',
      }),
    )
  } finally {
    AuditEventModel.create = original
  }
})

test('record() strips forbidden metadata keys case-insensitively before persisting (defense-in-depth backstop)', async () => {
  await record({
    action: 'auth.login.failure',
    entityType: 'User',
    outcome: 'FAILURE',
    severity: 'WARNING',
    metadata: {
      email: 'user@example.com',
      Password: 'should-be-stripped',
      PASSWORDHASH: 'should-be-stripped',
      refreshToken: 'should-be-stripped',
      reason: 'INVALID_CREDENTIALS',
    },
  })
  const events = await AuditEventModel.find({})
  const metadata = events[0]?.metadata as Record<string, unknown>
  assert.equal(metadata.email, 'user@example.com')
  assert.equal(metadata.reason, 'INVALID_CREDENTIALS')
  assert.equal(metadata.Password, undefined)
  assert.equal(metadata.PASSWORDHASH, undefined)
  assert.equal(metadata.refreshToken, undefined)
})

test('record() safely handles a call with no metadata at all', async () => {
  await assert.doesNotReject(() =>
    record({
      action: 'auth.logout',
      entityType: 'SecuritySession',
      outcome: 'SUCCESS',
      severity: 'INFO',
    }),
  )
})
