import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose, { Types, type ClientSession } from 'mongoose'
import { StockBalanceModel } from '../models/stock-balance.model.js'
import * as stockBalanceRepository from './stock-balance.repository.js'

let mongod: MongoMemoryServer

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'inv_001_stock_balance_repo_test' })
  await StockBalanceModel.init()
})

after(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await StockBalanceModel.deleteMany({})
})

function oid(): Types.ObjectId {
  return new Types.ObjectId()
}

async function withSession<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession()
  try {
    return await fn(session)
  } finally {
    await session.endSession()
  }
}

test('incrementOrCreate creates a balance document when none exists', async () => {
  const key = { organizationId: oid(), locationId: oid(), variantId: oid() }
  const balance = await withSession((session) =>
    stockBalanceRepository.incrementOrCreate(key, 10, session),
  )
  assert.equal(balance.quantityOnHand, 10)
})

test('incrementOrCreate adds to an existing balance', async () => {
  const key = { organizationId: oid(), locationId: oid(), variantId: oid() }
  await withSession((session) => stockBalanceRepository.incrementOrCreate(key, 10, session))
  const updated = await withSession((session) =>
    stockBalanceRepository.incrementOrCreate(key, 5, session),
  )
  assert.equal(updated.quantityOnHand, 15)
})

test('decrementIfSufficient succeeds and reduces the balance when sufficient', async () => {
  const key = { organizationId: oid(), locationId: oid(), variantId: oid() }
  await withSession((session) => stockBalanceRepository.incrementOrCreate(key, 10, session))
  const result = await withSession((session) =>
    stockBalanceRepository.decrementIfSufficient(key, 6, session),
  )
  assert.equal(result?.quantityOnHand, 4)
})

test('decrementIfSufficient returns null and performs no write when insufficient', async () => {
  const key = { organizationId: oid(), locationId: oid(), variantId: oid() }
  await withSession((session) => stockBalanceRepository.incrementOrCreate(key, 5, session))
  const result = await withSession((session) =>
    stockBalanceRepository.decrementIfSufficient(key, 10, session),
  )
  assert.equal(result, null)
  const stillFive = await stockBalanceRepository.findByVariantAndLocation(
    key.organizationId,
    key.locationId,
    key.variantId,
  )
  assert.equal(stillFive?.quantityOnHand, 5)
})

test('decrementIfSufficient returns null (not an error) when no balance document exists at all', async () => {
  const key = { organizationId: oid(), locationId: oid(), variantId: oid() }
  const result = await withSession((session) =>
    stockBalanceRepository.decrementIfSufficient(key, 1, session),
  )
  assert.equal(result, null)
})

test('the balance never becomes negative under a guarded decrement', async () => {
  const key = { organizationId: oid(), locationId: oid(), variantId: oid() }
  await withSession((session) => stockBalanceRepository.incrementOrCreate(key, 3, session))
  const result = await withSession((session) =>
    stockBalanceRepository.decrementIfSufficient(key, 4, session),
  )
  assert.equal(result, null)
  const stillThree = await stockBalanceRepository.findByVariantAndLocation(
    key.organizationId,
    key.locationId,
    key.variantId,
  )
  assert.equal(stillThree?.quantityOnHand, 3)
})

test('organizations are isolated: findByVariantAndLocation scopes by organizationId', async () => {
  const orgA = oid()
  const orgB = oid()
  const locationId = oid()
  const variantId = oid()
  await withSession((session) =>
    stockBalanceRepository.incrementOrCreate(
      { organizationId: orgA, locationId, variantId },
      10,
      session,
    ),
  )
  const foundByOwner = await stockBalanceRepository.findByVariantAndLocation(
    orgA,
    locationId,
    variantId,
  )
  const foundByOther = await stockBalanceRepository.findByVariantAndLocation(
    orgB,
    locationId,
    variantId,
  )
  assert.ok(foundByOwner)
  assert.equal(foundByOther, null)
})

test('list only returns balances belonging to the caller organization', async () => {
  const orgA = oid()
  const orgB = oid()
  await withSession((session) =>
    stockBalanceRepository.incrementOrCreate(
      { organizationId: orgA, locationId: oid(), variantId: oid() },
      10,
      session,
    ),
  )
  await withSession((session) =>
    stockBalanceRepository.incrementOrCreate(
      { organizationId: orgB, locationId: oid(), variantId: oid() },
      10,
      session,
    ),
  )
  const result = await stockBalanceRepository.list(orgA, {}, { page: 1, limit: 20 })
  assert.equal(result.items.length, 1)
})

test('the declared unique index exists on {organizationId, locationId, variantId}', async () => {
  const indexes = await StockBalanceModel.collection.indexes()
  const key = indexes.find(
    (idx) =>
      JSON.stringify(idx.key) ===
      JSON.stringify({ organizationId: 1, locationId: 1, variantId: 1 }),
  )
  assert.ok(key, 'expected an {organizationId, locationId, variantId} index')
  assert.equal(key?.unique, true)
})

test('CONCURRENCY: two concurrent initial increments for the same key both apply, exactly one document is created, no lost update', async () => {
  const key = { organizationId: oid(), locationId: oid(), variantId: oid() }

  const results = await Promise.allSettled([
    withSession((session) => stockBalanceRepository.incrementOrCreate(key, 10, session)),
    withSession((session) => stockBalanceRepository.incrementOrCreate(key, 20, session)),
  ])

  assert.ok(
    results.every((r) => r.status === 'fulfilled'),
    'both increments must succeed',
  )

  const docs = await StockBalanceModel.find({
    organizationId: key.organizationId,
    locationId: key.locationId,
    variantId: key.variantId,
  })
  assert.equal(docs.length, 1, 'exactly one StockBalance document must exist')
  assert.equal(docs[0]?.quantityOnHand, 30, 'both increments must be reflected (no lost update)')
})

test('CONCURRENCY: two concurrent guarded decrements — exactly one succeeds, balance never goes negative', async () => {
  const key = { organizationId: oid(), locationId: oid(), variantId: oid() }
  await withSession((session) => stockBalanceRepository.incrementOrCreate(key, 10, session))

  const results = await Promise.allSettled([
    withSession((session) => stockBalanceRepository.decrementIfSufficient(key, 6, session)),
    withSession((session) => stockBalanceRepository.decrementIfSufficient(key, 6, session)),
  ])

  const succeeded = results.filter(
    (r) => r.status === 'fulfilled' && r.value !== null,
  ) as PromiseFulfilledResult<
    Awaited<ReturnType<typeof stockBalanceRepository.decrementIfSufficient>>
  >[]
  assert.equal(succeeded.length, 1, 'exactly one decrement should succeed')

  const finalDoc = await stockBalanceRepository.findByVariantAndLocation(
    key.organizationId,
    key.locationId,
    key.variantId,
  )
  assert.equal(finalDoc?.quantityOnHand, 4)
  assert.ok((finalDoc?.quantityOnHand ?? -1) >= 0, 'balance must never go negative')
})
