import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { CartItemModel, CART_ITEM_MAX_QUANTITY } from '../models/cart-item.model.js'
import * as cartItemRepository from './cart-item.repository.js'

let mongod: MongoMemoryServer

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'com_002_cart_item_repo_test' })
  await CartItemModel.init()
})

after(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await CartItemModel.deleteMany({})
})

function oid(): Types.ObjectId {
  return new Types.ObjectId()
}

function key(
  overrides: Partial<{
    cartId: Types.ObjectId
    organizationId: Types.ObjectId
    variantId: Types.ObjectId
  }> = {},
) {
  return {
    cartId: overrides.cartId ?? oid(),
    organizationId: overrides.organizationId ?? oid(),
    variantId: overrides.variantId ?? oid(),
  }
}

// ---------------------------------------------------------------------------
// incrementOrCreate: create / increment
// ---------------------------------------------------------------------------

test('incrementOrCreate creates a new item when none exists', async () => {
  const k = key()
  const result = await cartItemRepository.incrementOrCreate(k, 3)
  assert.equal(result.limitExceeded, false)
  assert.equal(result.item?.quantity, 3)
  assert.equal(result.item?.cartId.toString(), k.cartId.toString())
  assert.equal(result.item?.organizationId.toString(), k.organizationId.toString())
  assert.equal(result.item?.variantId.toString(), k.variantId.toString())
})

test('incrementOrCreate increments an existing item instead of creating a duplicate', async () => {
  const k = key()
  await cartItemRepository.incrementOrCreate(k, 3)
  const result = await cartItemRepository.incrementOrCreate(k, 4)
  assert.equal(result.limitExceeded, false)
  assert.equal(result.item?.quantity, 7)
  assert.equal(await CartItemModel.countDocuments({ cartId: k.cartId, variantId: k.variantId }), 1)
})

test('adding the same variant to different carts creates independent rows', async () => {
  const variantId = oid()
  const organizationId = oid()
  const a = await cartItemRepository.incrementOrCreate(
    { cartId: oid(), organizationId, variantId },
    1,
  )
  const b = await cartItemRepository.incrementOrCreate(
    { cartId: oid(), organizationId, variantId },
    1,
  )
  assert.notEqual(a.item?._id.toString(), b.item?._id.toString())
})

// ---------------------------------------------------------------------------
// 9999 ceiling
// ---------------------------------------------------------------------------

test('9990 + 9 succeeds and quantity becomes 9999', async () => {
  const k = key()
  await cartItemRepository.incrementOrCreate(k, 9990)
  const result = await cartItemRepository.incrementOrCreate(k, 9)
  assert.equal(result.limitExceeded, false)
  assert.equal(result.item?.quantity, CART_ITEM_MAX_QUANTITY)
})

test('9990 + 20 is rejected and quantity remains 9990', async () => {
  const k = key()
  await cartItemRepository.incrementOrCreate(k, 9990)
  const result = await cartItemRepository.incrementOrCreate(k, 20)
  assert.equal(result.limitExceeded, true)
  assert.equal(result.item, null)

  const stored = await CartItemModel.findOne({ cartId: k.cartId, variantId: k.variantId })
  assert.equal(stored?.quantity, 9990)
})

test('incrementing an item already at the ceiling by any positive amount is rejected', async () => {
  const k = key()
  await cartItemRepository.incrementOrCreate(k, CART_ITEM_MAX_QUANTITY)
  const result = await cartItemRepository.incrementOrCreate(k, 1)
  assert.equal(result.limitExceeded, true)
  const stored = await CartItemModel.findOne({ cartId: k.cartId, variantId: k.variantId })
  assert.equal(stored?.quantity, CART_ITEM_MAX_QUANTITY)
})

test('CONCURRENCY: two simultaneous increments for a new variant never exceed the ceiling and never create a duplicate row', async () => {
  const k = key()
  const results = await Promise.all([
    cartItemRepository.incrementOrCreate(k, 5000),
    cartItemRepository.incrementOrCreate(k, 5000),
  ])
  // 5000 + 5000 = 10000 > 9999: exactly one of the two must succeed.
  const succeeded = results.filter((r) => !r.limitExceeded)
  const rejected = results.filter((r) => r.limitExceeded)
  assert.equal(succeeded.length, 1)
  assert.equal(rejected.length, 1)
  assert.equal(await CartItemModel.countDocuments({ cartId: k.cartId, variantId: k.variantId }), 1)
  const stored = await CartItemModel.findOne({ cartId: k.cartId, variantId: k.variantId })
  assert.equal(stored?.quantity, 5000)
})

test('CONCURRENCY: two simultaneous increments that together stay within the ceiling both apply, exactly once each', async () => {
  const k = key()
  const results = await Promise.all([
    cartItemRepository.incrementOrCreate(k, 3000),
    cartItemRepository.incrementOrCreate(k, 3000),
  ])
  assert.ok(results.every((r) => !r.limitExceeded))
  assert.equal(await CartItemModel.countDocuments({ cartId: k.cartId, variantId: k.variantId }), 1)
  const stored = await CartItemModel.findOne({ cartId: k.cartId, variantId: k.variantId })
  assert.equal(stored?.quantity, 6000)
})

// ---------------------------------------------------------------------------
// replaceQuantity
// ---------------------------------------------------------------------------

test('replaceQuantity sets the exact quantity', async () => {
  const k = key()
  const created = await cartItemRepository.incrementOrCreate(k, 3)
  const updated = await cartItemRepository.replaceQuantity(k.cartId, created.item!._id, 50)
  assert.equal(updated?.quantity, 50)
})

test('replaceQuantity scoped by cartId: a different cartId cannot update it', async () => {
  const k = key()
  const created = await cartItemRepository.incrementOrCreate(k, 3)
  const result = await cartItemRepository.replaceQuantity(oid(), created.item!._id, 50)
  assert.equal(result, null)
})

test('replaceQuantity on a nonexistent item returns null', async () => {
  const result = await cartItemRepository.replaceQuantity(oid(), oid(), 5)
  assert.equal(result, null)
})

// ---------------------------------------------------------------------------
// remove (hard delete)
// ---------------------------------------------------------------------------

test('remove hard-deletes the document', async () => {
  const k = key()
  const created = await cartItemRepository.incrementOrCreate(k, 3)
  const removed = await cartItemRepository.remove(k.cartId, created.item!._id)
  assert.ok(removed)
  assert.equal(await CartItemModel.findById(created.item!._id), null)
})

test('after removal, the same variant can be re-added to the same cart (plain unique index, hard delete)', async () => {
  const k = key()
  const created = await cartItemRepository.incrementOrCreate(k, 3)
  await cartItemRepository.remove(k.cartId, created.item!._id)

  const readded = await cartItemRepository.incrementOrCreate(k, 7)
  assert.equal(readded.limitExceeded, false)
  assert.equal(readded.item?.quantity, 7)
  assert.notEqual(readded.item?._id.toString(), created.item!._id.toString())
})

test('remove scoped by cartId: a different cartId cannot remove it', async () => {
  const k = key()
  const created = await cartItemRepository.incrementOrCreate(k, 3)
  const result = await cartItemRepository.remove(oid(), created.item!._id)
  assert.equal(result, null)
  assert.ok(await CartItemModel.findById(created.item!._id))
})

test('removing an already-removed item returns null (not a silent no-op success)', async () => {
  const k = key()
  const created = await cartItemRepository.incrementOrCreate(k, 3)
  await cartItemRepository.remove(k.cartId, created.item!._id)
  const second = await cartItemRepository.remove(k.cartId, created.item!._id)
  assert.equal(second, null)
})

// ---------------------------------------------------------------------------
// listByCart / removeAllByCart
// ---------------------------------------------------------------------------

test('listByCart only returns items for that cart', async () => {
  const cartA = oid()
  const cartB = oid()
  await cartItemRepository.incrementOrCreate(key({ cartId: cartA }), 1)
  await cartItemRepository.incrementOrCreate(key({ cartId: cartA }), 1)
  await cartItemRepository.incrementOrCreate(key({ cartId: cartB }), 1)

  const itemsA = await cartItemRepository.listByCart(cartA)
  assert.equal(itemsA.length, 2)
})

test('removeAllByCart clears every item for that cart only', async () => {
  const cartA = oid()
  const cartB = oid()
  await cartItemRepository.incrementOrCreate(key({ cartId: cartA }), 1)
  await cartItemRepository.incrementOrCreate(key({ cartId: cartA }), 1)
  await cartItemRepository.incrementOrCreate(key({ cartId: cartB }), 1)

  await cartItemRepository.removeAllByCart(cartA)

  assert.equal(await CartItemModel.countDocuments({ cartId: cartA }), 0)
  assert.equal(await CartItemModel.countDocuments({ cartId: cartB }), 1)
})

test('removeAllByCart on a cart with no items is a safe no-op', async () => {
  await assert.doesNotReject(() => cartItemRepository.removeAllByCart(oid()))
})

// ---------------------------------------------------------------------------
// Model / indexes
// ---------------------------------------------------------------------------

test('toJSON output never includes __v', async () => {
  const created = await cartItemRepository.incrementOrCreate(key(), 1)
  const json = created.item!.toJSON() as unknown as Record<string, unknown>
  assert.equal(json.__v, undefined)
})

test('the declared {cartId, variantId} unique index exists and is a plain (non-partial) unique index', async () => {
  const indexes = await CartItemModel.collection.indexes()
  const index = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ cartId: 1, variantId: 1 }),
  )
  assert.ok(index, 'expected a {cartId, variantId} index')
  assert.equal(index?.unique, true)
  assert.equal(index?.partialFilterExpression, undefined)
})
