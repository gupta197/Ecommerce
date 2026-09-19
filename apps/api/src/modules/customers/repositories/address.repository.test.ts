import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose, { Types, type ClientSession } from 'mongoose'
import { AddressModel } from '../models/address.model.js'
import * as addressRepository from './address.repository.js'

let mongod: MongoMemoryServer

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'cust_001_address_repo_test' })
  await AddressModel.init()
})

after(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await AddressModel.deleteMany({})
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

function baseAddress(customerId: Types.ObjectId) {
  return {
    customerId,
    recipientName: 'Ada Lovelace',
    line1: '1 Analytical Engine Way',
    city: 'London',
    state: 'London',
    postalCode: 'AB1 2CD',
    country: 'UK',
    status: 'ACTIVE' as const,
  }
}

test('creates an address', async () => {
  const customerId = oid()
  const address = await addressRepository.create(baseAddress(customerId))
  assert.equal(address.recipientName, 'Ada Lovelace')
  assert.equal(address.isDefaultBilling, false)
  assert.equal(address.isDefaultShipping, false)
  assert.equal(address.status, 'ACTIVE')
})

test('findById scopes by customerId: a different customer cannot find it', async () => {
  const customerA = oid()
  const customerB = oid()
  const address = await addressRepository.create(baseAddress(customerA))
  const foundByOwner = await addressRepository.findById(customerA, address._id)
  const foundByOther = await addressRepository.findById(customerB, address._id)
  assert.ok(foundByOwner)
  assert.equal(foundByOther, null)
})

test('findById works without an explicit session', async () => {
  const customerId = oid()
  const address = await addressRepository.create(baseAddress(customerId))
  const found = await addressRepository.findById(customerId, address._id)
  assert.ok(found)
})

test('findById works with an explicit session', async () => {
  const customerId = oid()
  const address = await addressRepository.create(baseAddress(customerId))
  const found = await withSession((session) =>
    addressRepository.findById(customerId, address._id, session),
  )
  assert.ok(found)
})

test('findByCustomerId only returns addresses belonging to that customer', async () => {
  const customerA = oid()
  const customerB = oid()
  await addressRepository.create(baseAddress(customerA))
  await addressRepository.create(baseAddress(customerB))
  const results = await addressRepository.findByCustomerId(customerA)
  assert.equal(results.length, 1)
})

test('update patches only the provided fields and cannot set customerId', async () => {
  const customerA = oid()
  const customerB = oid()
  const address = await addressRepository.create(baseAddress(customerA))
  const updated = await addressRepository.update(customerA, address._id, { city: 'Manchester' })
  assert.equal(updated?.city, 'Manchester')
  assert.equal(updated?.line1, '1 Analytical Engine Way')
  assert.equal(updated?.customerId.toString(), customerA.toString())

  const crossCustomerAttempt = await addressRepository.update(customerB, address._id, {
    city: 'Hijacked',
  })
  assert.equal(crossCustomerAttempt, null)
})

test('archive sets status to ARCHIVED and never deletes the document', async () => {
  const customerId = oid()
  const address = await addressRepository.create(baseAddress(customerId))
  const archived = await addressRepository.archive(customerId, address._id)
  assert.equal(archived?.status, 'ARCHIVED')
  const stillExists = await AddressModel.findById(address._id)
  assert.ok(stillExists)
})

test('cross-customer archive does not affect the address', async () => {
  const customerA = oid()
  const customerB = oid()
  const address = await addressRepository.create(baseAddress(customerA))
  const result = await addressRepository.archive(customerB, address._id)
  assert.equal(result, null)
  const stillActive = await addressRepository.findById(customerA, address._id)
  assert.equal(stillActive?.status, 'ACTIVE')
})

test('setDefaultFlag sets the requested flag and clearDefaultFlag unsets it', async () => {
  const customerId = oid()
  const address = await addressRepository.create(baseAddress(customerId))
  const updated = await withSession((session) =>
    addressRepository.setDefaultFlag(customerId, address._id, 'billing', session),
  )
  assert.equal(updated?.isDefaultBilling, true)

  await withSession((session) => addressRepository.clearDefaultFlag(customerId, 'billing', session))
  const cleared = await addressRepository.findById(customerId, address._id)
  assert.equal(cleared?.isDefaultBilling, false)
})

test('clearDefaultFlag only clears the requested type, not the other', async () => {
  const customerId = oid()
  const address = await addressRepository.create(baseAddress(customerId))
  await withSession((session) =>
    addressRepository.setDefaultFlag(customerId, address._id, 'billing', session),
  )
  await withSession((session) =>
    addressRepository.setDefaultFlag(customerId, address._id, 'shipping', session),
  )
  await withSession((session) => addressRepository.clearDefaultFlag(customerId, 'billing', session))
  const result = await addressRepository.findById(customerId, address._id)
  assert.equal(result?.isDefaultBilling, false)
  assert.equal(result?.isDefaultShipping, true)
})

test('clearDefaultFlag only affects the given customer', async () => {
  const customerA = oid()
  const customerB = oid()
  const addressA = await addressRepository.create(baseAddress(customerA))
  const addressB = await addressRepository.create(baseAddress(customerB))
  await withSession((session) =>
    addressRepository.setDefaultFlag(customerA, addressA._id, 'billing', session),
  )
  await withSession((session) =>
    addressRepository.setDefaultFlag(customerB, addressB._id, 'billing', session),
  )

  await withSession((session) => addressRepository.clearDefaultFlag(customerA, 'billing', session))

  const resultA = await addressRepository.findById(customerA, addressA._id)
  const resultB = await addressRepository.findById(customerB, addressB._id)
  assert.equal(resultA?.isDefaultBilling, false)
  assert.equal(resultB?.isDefaultBilling, true)
})

test('the {customerId, isDefaultBilling} partial unique index rejects a second simultaneous default billing address', async () => {
  const customerId = oid()
  const addressA = await addressRepository.create(baseAddress(customerId))
  const addressB = await addressRepository.create(baseAddress(customerId))
  await withSession((session) =>
    addressRepository.setDefaultFlag(customerId, addressA._id, 'billing', session),
  )
  // Directly attempting to set a second default (bypassing clearDefaultFlag)
  // must be rejected by the database index itself, not merely by service-layer logic.
  await assert.rejects(() =>
    withSession((session) =>
      addressRepository.setDefaultFlag(customerId, addressB._id, 'billing', session),
    ),
  )
})

test('the same address can be default billing and default shipping simultaneously', async () => {
  const customerId = oid()
  const address = await addressRepository.create(baseAddress(customerId))
  await withSession((session) =>
    addressRepository.setDefaultFlag(customerId, address._id, 'billing', session),
  )
  const updated = await withSession((session) =>
    addressRepository.setDefaultFlag(customerId, address._id, 'shipping', session),
  )
  assert.equal(updated?.isDefaultBilling, true)
  assert.equal(updated?.isDefaultShipping, true)
})

test('toJSON output never includes __v', async () => {
  const customerId = oid()
  const address = await addressRepository.create(baseAddress(customerId))
  const json = address.toJSON() as unknown as Record<string, unknown>
  assert.equal(json.__v, undefined)
})

test('the declared indexes exist, including both default partial unique indexes', async () => {
  const indexes = await AddressModel.collection.indexes()

  const listIndex = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ customerId: 1 }),
  )
  assert.ok(listIndex, 'expected a {customerId: 1} index')

  const billingIndex = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ customerId: 1, isDefaultBilling: 1 }),
  )
  assert.ok(billingIndex, 'expected a {customerId, isDefaultBilling} index')
  assert.equal(billingIndex?.unique, true)
  assert.deepEqual(billingIndex?.partialFilterExpression, { isDefaultBilling: true })

  const shippingIndex = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ customerId: 1, isDefaultShipping: 1 }),
  )
  assert.ok(shippingIndex, 'expected a {customerId, isDefaultShipping} index')
  assert.equal(shippingIndex?.unique, true)
  assert.deepEqual(shippingIndex?.partialFilterExpression, { isDefaultShipping: true })
})
