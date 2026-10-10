import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { ReturnRequestLockModel } from '../models/return-request-lock.model.js'
import * as returnRequestLockRepository from './return-request-lock.repository.js'

let replSet: MongoMemoryReplSet

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  await mongoose.connect(replSet.getUri(), { dbName: 'com_004_return_lock_repo_test' })
  await ReturnRequestLockModel.init()
})

after(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

beforeEach(async () => {
  await ReturnRequestLockModel.deleteMany({})
})

function oid(): Types.ObjectId {
  return new Types.ObjectId()
}

async function withSession<T>(fn: (session: mongoose.ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession()
  try {
    let result: T | undefined
    await session.withTransaction(async () => {
      result = await fn(session)
    })
    return result as T
  } finally {
    await session.endSession()
  }
}

test('touch creates the lock document on first use', async () => {
  const orderId = oid()
  await withSession((session) => returnRequestLockRepository.touch(orderId, session))
  assert.equal(await ReturnRequestLockModel.countDocuments({ orderId }), 1)
})

test('touch is idempotent: a second touch for the same orderId does not create a duplicate', async () => {
  const orderId = oid()
  await withSession((session) => returnRequestLockRepository.touch(orderId, session))
  await withSession((session) => returnRequestLockRepository.touch(orderId, session))
  assert.equal(await ReturnRequestLockModel.countDocuments({ orderId }), 1)
})

test('the declared {orderId} unique index exists', async () => {
  const indexes = await ReturnRequestLockModel.collection.indexes()
  const index = indexes.find((idx) => JSON.stringify(idx.key) === JSON.stringify({ orderId: 1 }))
  assert.ok(index, 'expected an {orderId:1} index')
  assert.equal(index?.unique, true)
})

test('CONCURRENCY: two simultaneous transactions touching the same orderId — exactly one commits first, the other retries and still succeeds', async () => {
  const orderId = oid()
  const attempt = () =>
    withSession((session) => returnRequestLockRepository.touch(orderId, session))
  await Promise.all([attempt(), attempt()])
  // Both attempts must ultimately succeed (touch never fails outright — the
  // driver's automatic retry resolves the write conflict transparently),
  // and exactly one lock document must exist afterward.
  assert.equal(await ReturnRequestLockModel.countDocuments({ orderId }), 1)
})
