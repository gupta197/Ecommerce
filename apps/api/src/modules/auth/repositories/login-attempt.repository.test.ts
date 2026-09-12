import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose from 'mongoose'
import { LoginAttemptModel } from '../models/login-attempt.model.js'
import * as loginAttemptRepository from './login-attempt.repository.js'

let mongod: MongoMemoryServer

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'sec_001_login_attempt_repo_test' })
  await LoginAttemptModel.init()
})

after(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await LoginAttemptModel.deleteMany({})
})

test('records a successful attempt', async () => {
  const attempt = await loginAttemptRepository.create({ email: 'a@example.com', success: true })
  assert.equal(attempt.success, true)
  assert.equal(attempt.reason, undefined)
})

test('records a failed attempt with a reason', async () => {
  const attempt = await loginAttemptRepository.create({
    email: 'a@example.com',
    success: false,
    reason: 'INVALID_CREDENTIALS',
    ipAddress: '203.0.113.1',
    userAgent: 'test-agent',
  })
  assert.equal(attempt.success, false)
  assert.equal(attempt.reason, 'INVALID_CREDENTIALS')
  assert.equal(attempt.ipAddress, '203.0.113.1')
})

test('the declared indexes exist, including the 90-day TTL index on createdAt', async () => {
  const indexes = await LoginAttemptModel.collection.indexes()

  const emailIndex = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ email: 1, createdAt: -1 }),
  )
  assert.ok(emailIndex, 'expected an {email: 1, createdAt: -1} index')

  const ttlIndex = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ createdAt: 1 }),
  )
  assert.ok(ttlIndex, 'expected a {createdAt: 1} TTL index')
  assert.equal(ttlIndex?.expireAfterSeconds, 90 * 24 * 60 * 60)
})
