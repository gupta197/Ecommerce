import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose from 'mongoose'
import { UserModel } from '../models/user.model.js'
import * as userRepository from './user.repository.js'

let mongod: MongoMemoryServer

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'sec_001_user_repo_test' })
  await UserModel.init()
})

after(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await UserModel.deleteMany({})
})

test('creates a user', async () => {
  const user = await userRepository.create({ email: 'a@example.com', passwordHash: 'hash' })
  assert.ok(user)
  assert.equal(user?.email, 'a@example.com')
})

test('create returns null (not a thrown error) for a duplicate email', async () => {
  await userRepository.create({ email: 'a@example.com', passwordHash: 'hash1' })
  const second = await userRepository.create({ email: 'a@example.com', passwordHash: 'hash2' })
  assert.equal(second, null)

  const count = await UserModel.countDocuments({ email: 'a@example.com' })
  assert.equal(count, 1)
})

test('findByEmailWithPassword includes passwordHash despite select:false on the schema', async () => {
  await userRepository.create({ email: 'a@example.com', passwordHash: 'hash' })
  const found = await userRepository.findByEmailWithPassword('a@example.com')
  assert.equal(found?.passwordHash, 'hash')
})

test('plain findById does not return passwordHash', async () => {
  const created = await userRepository.create({ email: 'a@example.com', passwordHash: 'hash' })
  const found = await userRepository.findById(created!._id)
  assert.equal(found?.passwordHash, undefined)
})

test('the email unique index rejects a duplicate at the database level', async () => {
  await UserModel.create({ email: 'a@example.com', passwordHash: 'hash1' })
  await assert.rejects(() => UserModel.create({ email: 'a@example.com', passwordHash: 'hash2' }))
})

test('recordLoginFailure and resetLoginFailures update the expected fields', async () => {
  const created = await userRepository.create({ email: 'a@example.com', passwordHash: 'hash' })
  const nextAttemptAllowedAt = new Date(Date.now() + 60_000)

  await userRepository.recordLoginFailure(created!._id, {
    failedLoginAttempts: 4,
    nextAttemptAllowedAt,
  })
  const afterFailure = await userRepository.findById(created!._id)
  assert.equal(afterFailure?.failedLoginAttempts, 4)
  assert.equal(afterFailure?.nextAttemptAllowedAt?.getTime(), nextAttemptAllowedAt.getTime())

  await userRepository.resetLoginFailures(created!._id)
  const afterReset = await userRepository.findById(created!._id)
  assert.equal(afterReset?.failedLoginAttempts, 0)
  assert.equal(afterReset?.nextAttemptAllowedAt, null)
})

test('toJSON output never includes passwordHash or __v', async () => {
  const created = await userRepository.create({ email: 'a@example.com', passwordHash: 'hash' })
  const json = created!.toJSON() as unknown as Record<string, unknown>
  assert.equal(json.passwordHash, undefined)
  assert.equal(json.__v, undefined)
})

test('the declared email index exists and is unique', async () => {
  const indexes = await UserModel.collection.indexes()
  const emailIndex = indexes.find((idx) => JSON.stringify(idx.key) === JSON.stringify({ email: 1 }))
  assert.ok(emailIndex, 'expected an {email: 1} index')
  assert.equal(emailIndex?.unique, true)
})
