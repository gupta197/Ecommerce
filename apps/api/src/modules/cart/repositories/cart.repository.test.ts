import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { CartModel } from '../models/cart.model.js'
import * as cartRepository from './cart.repository.js'

let mongod: MongoMemoryServer

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'com_002_cart_repo_test' })
  await CartModel.init()
})

after(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await CartModel.deleteMany({})
})

function oid(): Types.ObjectId {
  return new Types.ObjectId()
}

test('findByCustomerAndOrganization returns null and creates nothing when no Cart exists', async () => {
  const customerId = oid()
  const organizationId = oid()
  const result = await cartRepository.findByCustomerAndOrganization({ customerId, organizationId })
  assert.equal(result, null)
  assert.equal(await CartModel.countDocuments({}), 0)
})

test('findOrCreate creates a Cart when none exists', async () => {
  const customerId = oid()
  const organizationId = oid()
  const cart = await cartRepository.findOrCreate({ customerId, organizationId })
  assert.equal(cart.customerId.toString(), customerId.toString())
  assert.equal(cart.organizationId.toString(), organizationId.toString())
  assert.equal(await CartModel.countDocuments({}), 1)
})

test('findOrCreate returns the existing Cart on a second call (no duplicate)', async () => {
  const customerId = oid()
  const organizationId = oid()
  const first = await cartRepository.findOrCreate({ customerId, organizationId })
  const second = await cartRepository.findOrCreate({ customerId, organizationId })
  assert.equal(first._id.toString(), second._id.toString())
  assert.equal(await CartModel.countDocuments({}), 1)
})

test('a customer can have separate carts for different organizations', async () => {
  const customerId = oid()
  const cartA = await cartRepository.findOrCreate({ customerId, organizationId: oid() })
  const cartB = await cartRepository.findOrCreate({ customerId, organizationId: oid() })
  assert.notEqual(cartA._id.toString(), cartB._id.toString())
})

test('different customers each get their own cart for the same organization', async () => {
  const organizationId = oid()
  const cartA = await cartRepository.findOrCreate({ customerId: oid(), organizationId })
  const cartB = await cartRepository.findOrCreate({ customerId: oid(), organizationId })
  assert.notEqual(cartA._id.toString(), cartB._id.toString())
})

test('findById scopes by customerId: a different customer cannot find it', async () => {
  const customerA = oid()
  const customerB = oid()
  const cart = await cartRepository.findOrCreate({ customerId: customerA, organizationId: oid() })
  assert.ok(await cartRepository.findById(customerA, cart._id))
  assert.equal(await cartRepository.findById(customerB, cart._id), null)
})

test('toJSON output never includes __v', async () => {
  const cart = await cartRepository.findOrCreate({ customerId: oid(), organizationId: oid() })
  const json = cart.toJSON() as unknown as Record<string, unknown>
  assert.equal(json.__v, undefined)
})

test('the declared {customerId, organizationId} unique index exists', async () => {
  const indexes = await CartModel.collection.indexes()
  const index = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ customerId: 1, organizationId: 1 }),
  )
  assert.ok(index, 'expected a {customerId, organizationId} index')
  assert.equal(index?.unique, true)
})

test('CONCURRENCY: two simultaneous findOrCreate calls for the same customer+organization — exactly one Cart is created', async () => {
  const customerId = oid()
  const organizationId = oid()

  const [cartA, cartB] = await Promise.all([
    cartRepository.findOrCreate({ customerId, organizationId }),
    cartRepository.findOrCreate({ customerId, organizationId }),
  ])

  assert.equal(cartA._id.toString(), cartB._id.toString())
  assert.equal(await CartModel.countDocuments({ customerId, organizationId }), 1)
})
