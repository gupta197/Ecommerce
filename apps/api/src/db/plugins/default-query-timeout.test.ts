import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose from 'mongoose'
import { registerDefaultQueryTimeoutPlugin } from './default-query-timeout.js'

test('applies the default maxTimeMS to find queries that do not set their own', async () => {
  const mongod = await MongoMemoryServer.create()
  try {
    await mongoose.connect(mongod.getUri(), { dbName: 'db_001_timeout_default' })
    registerDefaultQueryTimeoutPlugin(1234)

    const Thing = mongoose.model('DbOneTimeoutDefaultThing', new mongoose.Schema({ name: String }))
    const query = Thing.find({})
    await query.exec()

    assert.equal(query.getOptions().maxTimeMS, 1234)
  } finally {
    await mongoose.disconnect()
    await mongod.stop()
  }
})

test('does not override a query that sets its own maxTimeMS', async () => {
  const mongod = await MongoMemoryServer.create()
  try {
    await mongoose.connect(mongod.getUri(), { dbName: 'db_001_timeout_override' })
    registerDefaultQueryTimeoutPlugin(1234)

    const Thing = mongoose.model('DbOneTimeoutOverrideThing', new mongoose.Schema({ name: String }))
    const query = Thing.find({}).maxTimeMS(999)
    await query.exec()

    assert.equal(query.getOptions().maxTimeMS, 999)
  } finally {
    await mongoose.disconnect()
    await mongod.stop()
  }
})
