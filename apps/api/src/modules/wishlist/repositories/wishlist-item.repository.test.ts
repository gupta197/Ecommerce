import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { WishlistItemModel } from '../models/wishlist-item.model.js'
import * as wishlistItemRepository from './wishlist-item.repository.js'
import { ValidationError } from '../../../lib/http-errors.js'

let mongod: MongoMemoryServer

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'com_001_wishlist_item_repo_test' })
  await WishlistItemModel.init()
})

after(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await WishlistItemModel.deleteMany({})
})

function oid(): Types.ObjectId {
  return new Types.ObjectId()
}

function baseItem(
  overrides: Partial<{
    customerId: Types.ObjectId
    organizationId: Types.ObjectId
    variantId: Types.ObjectId
  }> = {},
) {
  return {
    customerId: overrides.customerId ?? oid(),
    organizationId: overrides.organizationId ?? oid(),
    variantId: overrides.variantId ?? oid(),
    status: 'ACTIVE' as const,
  }
}

test('creates a wishlist item', async () => {
  const item = await wishlistItemRepository.create(baseItem())
  assert.equal(item.status, 'ACTIVE')
})

test('findById scopes by customerId: a different customer cannot find it', async () => {
  const customerA = oid()
  const customerB = oid()
  const item = await wishlistItemRepository.create(baseItem({ customerId: customerA }))
  assert.ok(await wishlistItemRepository.findById(customerA, item._id))
  assert.equal(await wishlistItemRepository.findById(customerB, item._id), null)
})

test('findActiveByCustomerId only returns ACTIVE items for that customer', async () => {
  const customerId = oid()
  const active = await wishlistItemRepository.create(baseItem({ customerId }))
  const toArchive = await wishlistItemRepository.create(baseItem({ customerId }))
  await wishlistItemRepository.archive(customerId, toArchive._id)

  const results = await wishlistItemRepository.findActiveByCustomerId(customerId)
  assert.equal(results.length, 1)
  assert.equal(results[0]?._id.toString(), active._id.toString())
})

test('findActiveByCustomerId only returns items belonging to that customer', async () => {
  const customerA = oid()
  const customerB = oid()
  await wishlistItemRepository.create(baseItem({ customerId: customerA }))
  await wishlistItemRepository.create(baseItem({ customerId: customerB }))
  const results = await wishlistItemRepository.findActiveByCustomerId(customerA)
  assert.equal(results.length, 1)
})

test('archive sets status to ARCHIVED and never deletes the document', async () => {
  const customerId = oid()
  const item = await wishlistItemRepository.create(baseItem({ customerId }))
  const archived = await wishlistItemRepository.archive(customerId, item._id)
  assert.equal(archived?.status, 'ARCHIVED')
  const stillExists = await WishlistItemModel.findById(item._id)
  assert.ok(stillExists)
})

test('archiving an already-archived item returns null (not a silent no-op success)', async () => {
  const customerId = oid()
  const item = await wishlistItemRepository.create(baseItem({ customerId }))
  await wishlistItemRepository.archive(customerId, item._id)
  const secondAttempt = await wishlistItemRepository.archive(customerId, item._id)
  assert.equal(secondAttempt, null)
})

test('cross-customer archive does not affect the item', async () => {
  const customerA = oid()
  const customerB = oid()
  const item = await wishlistItemRepository.create(baseItem({ customerId: customerA }))
  const result = await wishlistItemRepository.archive(customerB, item._id)
  assert.equal(result, null)
  const stillActive = await wishlistItemRepository.findById(customerA, item._id)
  assert.equal(stillActive?.status, 'ACTIVE')
})

// ---------------------------------------------------------------------------
// Partial unique index: {customerId, variantId} unique WHERE status:'ACTIVE'
// ---------------------------------------------------------------------------

test('the database rejects a second ACTIVE item for the same customer+variant', async () => {
  const customerId = oid()
  const variantId = oid()
  await wishlistItemRepository.create(baseItem({ customerId, variantId }))
  await assert.rejects(
    () => wishlistItemRepository.create(baseItem({ customerId, variantId })),
    ValidationError,
  )
})

test('after archiving, the same customer can add the same variant again (partial index scoping proof)', async () => {
  const customerId = oid()
  const variantId = oid()
  const first = await wishlistItemRepository.create(baseItem({ customerId, variantId }))
  await wishlistItemRepository.archive(customerId, first._id)

  const second = await wishlistItemRepository.create(baseItem({ customerId, variantId }))
  assert.equal(second.status, 'ACTIVE')
  assert.notEqual(second._id.toString(), first._id.toString())

  const activeItems = await wishlistItemRepository.findActiveByCustomerId(customerId)
  assert.equal(activeItems.length, 1)
  assert.equal(activeItems[0]?._id.toString(), second._id.toString())
})

test('different customers can wishlist the same variant', async () => {
  const customerA = oid()
  const customerB = oid()
  const variantId = oid()
  await assert.doesNotReject(async () => {
    await wishlistItemRepository.create(baseItem({ customerId: customerA, variantId }))
    await wishlistItemRepository.create(baseItem({ customerId: customerB, variantId }))
  })
})

test('the same customer can wishlist variants from different organizations', async () => {
  const customerId = oid()
  await assert.doesNotReject(async () => {
    await wishlistItemRepository.create(
      baseItem({ customerId, organizationId: oid(), variantId: oid() }),
    )
    await wishlistItemRepository.create(
      baseItem({ customerId, organizationId: oid(), variantId: oid() }),
    )
  })
})

test('CONCURRENCY: two simultaneous ACTIVE creates for the same customer+variant — exactly one succeeds', async () => {
  const customerId = oid()
  const variantId = oid()
  const attempt = () => wishlistItemRepository.create(baseItem({ customerId, variantId }))

  const results = await Promise.allSettled([attempt(), attempt()])
  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  const rejected = results.filter((r) => r.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof ValidationError)
})

test('toJSON output never includes __v', async () => {
  const item = await wishlistItemRepository.create(baseItem())
  const json = item.toJSON() as unknown as Record<string, unknown>
  assert.equal(json.__v, undefined)
})

test('the declared indexes exist, including the ACTIVE-scoped partial unique index', async () => {
  const indexes = await WishlistItemModel.collection.indexes()

  const partialIndex = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ customerId: 1, variantId: 1 }),
  )
  assert.ok(partialIndex, 'expected a {customerId, variantId} index')
  assert.equal(partialIndex?.unique, true)
  assert.deepEqual(partialIndex?.partialFilterExpression, { status: 'ACTIVE' })

  const listIndex = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ customerId: 1 }),
  )
  assert.ok(listIndex, 'expected a {customerId: 1} index')
})
