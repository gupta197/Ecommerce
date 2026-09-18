import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose, { Types, type ClientSession } from 'mongoose'
import { InventoryTransactionModel } from '../models/inventory-transaction.model.js'
import * as inventoryTransactionRepository from './inventory-transaction.repository.js'

let mongod: MongoMemoryServer

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'inv_001_inventory_transaction_repo_test' })
  await InventoryTransactionModel.init()
})

after(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await InventoryTransactionModel.deleteMany({})
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

test('creates a PURCHASE transaction', async () => {
  const organizationId = oid()
  const locationId = oid()
  const variantId = oid()
  const tx = await withSession((session) =>
    inventoryTransactionRepository.create(
      { organizationId, locationId, variantId, type: 'PURCHASE', quantity: 10 },
      session,
    ),
  )
  assert.equal(tx.type, 'PURCHASE')
  assert.equal(tx.quantity, 10)
  assert.equal(tx.adjustmentDirection, undefined)
})

test('creates an ADJUSTMENT transaction with a direction', async () => {
  const organizationId = oid()
  const locationId = oid()
  const variantId = oid()
  const tx = await withSession((session) =>
    inventoryTransactionRepository.create(
      {
        organizationId,
        locationId,
        variantId,
        type: 'ADJUSTMENT',
        quantity: 3,
        adjustmentDirection: 'DECREASE',
      },
      session,
    ),
  )
  assert.equal(tx.adjustmentDirection, 'DECREASE')
})

test('model-level defense-in-depth rejects adjustmentDirection on a non-ADJUSTMENT type', async () => {
  const organizationId = oid()
  const locationId = oid()
  const variantId = oid()
  await assert.rejects(() =>
    withSession((session) =>
      inventoryTransactionRepository.create(
        {
          organizationId,
          locationId,
          variantId,
          type: 'PURCHASE',
          quantity: 10,
          adjustmentDirection: 'INCREASE',
        },
        session,
      ),
    ),
  )
})

test('model-level defense-in-depth rejects an ADJUSTMENT with no direction', async () => {
  const organizationId = oid()
  const locationId = oid()
  const variantId = oid()
  await assert.rejects(() =>
    withSession((session) =>
      inventoryTransactionRepository.create(
        { organizationId, locationId, variantId, type: 'ADJUSTMENT', quantity: 10 },
        session,
      ),
    ),
  )
})

test('rejects a non-positive quantity at the model level', async () => {
  const organizationId = oid()
  const locationId = oid()
  const variantId = oid()
  await assert.rejects(() =>
    withSession((session) =>
      inventoryTransactionRepository.create(
        { organizationId, locationId, variantId, type: 'PURCHASE', quantity: 0 },
        session,
      ),
    ),
  )
})

test('organizations are isolated: findById scopes by organizationId', async () => {
  const orgA = oid()
  const orgB = oid()
  const tx = await withSession((session) =>
    inventoryTransactionRepository.create(
      { organizationId: orgA, locationId: oid(), variantId: oid(), type: 'PURCHASE', quantity: 10 },
      session,
    ),
  )
  const foundByOwner = await inventoryTransactionRepository.findById(orgA, tx._id)
  const foundByOther = await inventoryTransactionRepository.findById(orgB, tx._id)
  assert.ok(foundByOwner)
  assert.equal(foundByOther, null)
})

test('list only returns transactions belonging to the caller organization', async () => {
  const orgA = oid()
  const orgB = oid()
  await withSession((session) =>
    inventoryTransactionRepository.create(
      { organizationId: orgA, locationId: oid(), variantId: oid(), type: 'PURCHASE', quantity: 10 },
      session,
    ),
  )
  await withSession((session) =>
    inventoryTransactionRepository.create(
      { organizationId: orgB, locationId: oid(), variantId: oid(), type: 'PURCHASE', quantity: 10 },
      session,
    ),
  )
  const result = await inventoryTransactionRepository.list(orgA, {}, { page: 1, limit: 20 })
  assert.equal(result.items.length, 1)
})

test('list filters by locationId, variantId, and type', async () => {
  const organizationId = oid()
  const locationId = oid()
  const variantId = oid()
  await withSession((session) =>
    inventoryTransactionRepository.create(
      { organizationId, locationId, variantId, type: 'PURCHASE', quantity: 10 },
      session,
    ),
  )
  await withSession((session) =>
    inventoryTransactionRepository.create(
      { organizationId, locationId, variantId, type: 'SALE', quantity: 3 },
      session,
    ),
  )
  await withSession((session) =>
    inventoryTransactionRepository.create(
      { organizationId, locationId: oid(), variantId: oid(), type: 'PURCHASE', quantity: 5 },
      session,
    ),
  )
  const result = await inventoryTransactionRepository.list(
    organizationId,
    { locationId, variantId, type: 'SALE' },
    { page: 1, limit: 20 },
  )
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0]?.type, 'SALE')
})

test('immutability: repository exposes no update or delete method for InventoryTransaction', () => {
  const repoAsRecord = inventoryTransactionRepository as unknown as Record<string, unknown>
  assert.equal(repoAsRecord.update, undefined)
  assert.equal(repoAsRecord.delete, undefined)
  assert.equal(repoAsRecord.remove, undefined)
})

test('the declared indexes exist on the InventoryTransaction collection', async () => {
  const indexes = await InventoryTransactionModel.collection.indexes()
  const byVariantLocation = indexes.find(
    (idx) =>
      JSON.stringify(idx.key) ===
      JSON.stringify({ organizationId: 1, variantId: 1, locationId: 1, createdAt: -1 }),
  )
  assert.ok(
    byVariantLocation,
    'expected an {organizationId, variantId, locationId, createdAt} index',
  )

  const byOrgOnly = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ organizationId: 1, createdAt: -1 }),
  )
  assert.ok(byOrgOnly, 'expected an {organizationId, createdAt} index')
})

test('toJSON output never includes __v', async () => {
  const organizationId = oid()
  const tx = await withSession((session) =>
    inventoryTransactionRepository.create(
      { organizationId, locationId: oid(), variantId: oid(), type: 'PURCHASE', quantity: 10 },
      session,
    ),
  )
  const json = tx.toJSON() as unknown as Record<string, unknown>
  assert.equal(json.__v, undefined)
})
