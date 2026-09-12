import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import mongoose from 'mongoose'
import { withTransaction } from './transaction.js'

// Transactions require a replica set — a standalone MongoMemoryServer
// cannot run them at all, which is exactly the limitation this helper's
// own documentation warns about.

test('withTransaction commits writes made via the provided session', async () => {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  try {
    await mongoose.connect(replSet.getUri(), { dbName: 'db_001_tx_commit' })
    const Widget = mongoose.model('DbOneTxCommitWidget', new mongoose.Schema({ name: String }))

    await withTransaction(async (session) => {
      await Widget.create([{ name: 'committed' }], { session })
    })

    const found = await Widget.findOne({ name: 'committed' })
    assert.ok(found)
  } finally {
    await mongoose.disconnect()
    await replSet.stop()
  }
})

test('withTransaction rolls back writes when fn throws', async () => {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  try {
    await mongoose.connect(replSet.getUri(), { dbName: 'db_001_tx_rollback' })
    const Widget = mongoose.model('DbOneTxRollbackWidget', new mongoose.Schema({ name: String }))

    await assert.rejects(
      withTransaction(async (session) => {
        await Widget.create([{ name: 'should-not-persist' }], { session })
        throw new Error('deliberate failure')
      }),
    )

    const found = await Widget.findOne({ name: 'should-not-persist' })
    assert.equal(found, null)
  } finally {
    await mongoose.disconnect()
    await replSet.stop()
  }
})
