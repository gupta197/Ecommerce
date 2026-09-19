import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { CustomerModel } from '../models/customer.model.js'
import * as customerRepository from './customer.repository.js'
import { ValidationError } from '../../../lib/http-errors.js'

let mongod: MongoMemoryServer

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'cust_001_customer_repo_test' })
  await CustomerModel.init()
})

after(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await CustomerModel.deleteMany({})
})

function oid(): Types.ObjectId {
  return new Types.ObjectId()
}

test('creates a customer profile', async () => {
  const userId = oid()
  const customer = await customerRepository.create({
    userId,
    firstName: 'Ada',
    lastName: 'Lovelace',
    status: 'ACTIVE',
  })
  assert.equal(customer.firstName, 'Ada')
  assert.equal(customer.status, 'ACTIVE')
  assert.equal(customer.displayName, undefined)
  assert.equal(customer.phone, undefined)
})

test('the userId unique index rejects a second profile for the same user', async () => {
  const userId = oid()
  await customerRepository.create({ userId, firstName: 'A', lastName: 'B', status: 'ACTIVE' })
  await assert.rejects(
    () => customerRepository.create({ userId, firstName: 'C', lastName: 'D', status: 'ACTIVE' }),
    ValidationError,
  )
})

test('concurrent creates for the same userId: exactly one succeeds, the database index rejects the other', async () => {
  const userId = oid()
  const attempt = () =>
    customerRepository.create({
      userId,
      firstName: 'Race',
      lastName: 'Condition',
      status: 'ACTIVE',
    })

  const results = await Promise.allSettled([attempt(), attempt()])
  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  const rejected = results.filter((r) => r.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof ValidationError)
})

test('findByUserId returns null for a user with no profile', async () => {
  const found = await customerRepository.findByUserId(oid())
  assert.equal(found, null)
})

test('findByUserId returns the matching profile', async () => {
  const userId = oid()
  const created = await customerRepository.create({
    userId,
    firstName: 'Ada',
    lastName: 'Lovelace',
    status: 'ACTIVE',
  })
  const found = await customerRepository.findByUserId(userId)
  assert.equal(found?._id.toString(), created._id.toString())
})

test("a different user cannot be found via another user's id", async () => {
  const userA = oid()
  const userB = oid()
  await customerRepository.create({
    userId: userA,
    firstName: 'A',
    lastName: 'A',
    status: 'ACTIVE',
  })
  const foundForB = await customerRepository.findByUserId(userB)
  assert.equal(foundForB, null)
})

test('update patches only the provided fields', async () => {
  const userId = oid()
  const customer = await customerRepository.create({
    userId,
    firstName: 'Ada',
    lastName: 'Lovelace',
    phone: '555-0100',
    status: 'ACTIVE',
  })
  const updated = await customerRepository.update(customer._id, { firstName: 'Augusta' })
  assert.equal(updated?.firstName, 'Augusta')
  assert.equal(updated?.lastName, 'Lovelace')
  assert.equal(updated?.phone, '555-0100')
})

test('update cannot set userId (not part of UpdateCustomerData)', async () => {
  const userId = oid()
  const customer = await customerRepository.create({
    userId,
    firstName: 'Ada',
    lastName: 'Lovelace',
    status: 'ACTIVE',
  })
  const updated = await customerRepository.update(customer._id, { firstName: 'Renamed' })
  assert.equal(updated?.userId.toString(), userId.toString())
})

test('archive sets status to ARCHIVED and never deletes the document', async () => {
  const userId = oid()
  const customer = await customerRepository.create({
    userId,
    firstName: 'Ada',
    lastName: 'Lovelace',
    status: 'ACTIVE',
  })
  const archived = await customerRepository.archive(customer._id)
  assert.equal(archived?.status, 'ARCHIVED')
  const stillExists = await CustomerModel.findById(customer._id)
  assert.ok(stillExists)
})

test('restore sets status back to ACTIVE', async () => {
  const userId = oid()
  const customer = await customerRepository.create({
    userId,
    firstName: 'Ada',
    lastName: 'Lovelace',
    status: 'ACTIVE',
  })
  await customerRepository.archive(customer._id)
  const restored = await customerRepository.restore(customer._id)
  assert.equal(restored?.status, 'ACTIVE')
})

test('archiving/restoring a non-existent customer returns null', async () => {
  await assert.equal(await customerRepository.archive(oid()), null)
  await assert.equal(await customerRepository.restore(oid()), null)
})

test('toJSON output never includes __v', async () => {
  const userId = oid()
  const customer = await customerRepository.create({
    userId,
    firstName: 'Ada',
    lastName: 'Lovelace',
    status: 'ACTIVE',
  })
  const json = customer.toJSON() as unknown as Record<string, unknown>
  assert.equal(json.__v, undefined)
})

test('the declared unique index exists on {userId}', async () => {
  const indexes = await CustomerModel.collection.indexes()
  const userIdIndex = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ userId: 1 }),
  )
  assert.ok(userIdIndex, 'expected a {userId: 1} index')
  assert.equal(userIdIndex?.unique, true)
})
