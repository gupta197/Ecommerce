import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { BackInStockRequestModel } from '../models/back-in-stock-request.model.js'
import * as backInStockRequestRepository from './back-in-stock-request.repository.js'
import { ValidationError } from '../../../lib/http-errors.js'

let mongod: MongoMemoryServer

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'com_001_back_in_stock_repo_test' })
  await BackInStockRequestModel.init()
})

after(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await BackInStockRequestModel.deleteMany({})
})

function oid(): Types.ObjectId {
  return new Types.ObjectId()
}

function baseRequest(
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
    status: 'PENDING' as const,
  }
}

test('creates a back-in-stock request', async () => {
  const request = await backInStockRequestRepository.create(baseRequest())
  assert.equal(request.status, 'PENDING')
})

test('findById scopes by customerId: a different customer cannot find it', async () => {
  const customerA = oid()
  const customerB = oid()
  const request = await backInStockRequestRepository.create(baseRequest({ customerId: customerA }))
  assert.ok(await backInStockRequestRepository.findById(customerA, request._id))
  assert.equal(await backInStockRequestRepository.findById(customerB, request._id), null)
})

test('findByCustomerId returns both PENDING and CANCELLED requests for that customer', async () => {
  const customerId = oid()
  const pending = await backInStockRequestRepository.create(baseRequest({ customerId }))
  const toCancel = await backInStockRequestRepository.create(baseRequest({ customerId }))
  await backInStockRequestRepository.cancel(customerId, toCancel._id)

  const results = await backInStockRequestRepository.findByCustomerId(customerId)
  assert.equal(results.length, 2)
  const statuses = results.map((r) => r.status).sort()
  assert.deepEqual(statuses, ['CANCELLED', 'PENDING'])
  assert.ok(results.some((r) => r._id.toString() === pending._id.toString()))
})

test('findByCustomerId only returns requests belonging to that customer', async () => {
  const customerA = oid()
  const customerB = oid()
  await backInStockRequestRepository.create(baseRequest({ customerId: customerA }))
  await backInStockRequestRepository.create(baseRequest({ customerId: customerB }))
  const results = await backInStockRequestRepository.findByCustomerId(customerA)
  assert.equal(results.length, 1)
})

test('cancel sets status to CANCELLED and never deletes the document', async () => {
  const customerId = oid()
  const request = await backInStockRequestRepository.create(baseRequest({ customerId }))
  const cancelled = await backInStockRequestRepository.cancel(customerId, request._id)
  assert.equal(cancelled?.status, 'CANCELLED')
  const stillExists = await BackInStockRequestModel.findById(request._id)
  assert.ok(stillExists)
})

test('cancelling an already-cancelled request returns null (not a silent no-op success)', async () => {
  const customerId = oid()
  const request = await backInStockRequestRepository.create(baseRequest({ customerId }))
  await backInStockRequestRepository.cancel(customerId, request._id)
  const secondAttempt = await backInStockRequestRepository.cancel(customerId, request._id)
  assert.equal(secondAttempt, null)
})

test('cross-customer cancel does not affect the request', async () => {
  const customerA = oid()
  const customerB = oid()
  const request = await backInStockRequestRepository.create(baseRequest({ customerId: customerA }))
  const result = await backInStockRequestRepository.cancel(customerB, request._id)
  assert.equal(result, null)
  const stillPending = await backInStockRequestRepository.findById(customerA, request._id)
  assert.equal(stillPending?.status, 'PENDING')
})

// ---------------------------------------------------------------------------
// Partial unique index: {customerId, variantId, status} unique WHERE status:'PENDING'
// ---------------------------------------------------------------------------

test('the database rejects a second PENDING request for the same customer+variant', async () => {
  const customerId = oid()
  const variantId = oid()
  await backInStockRequestRepository.create(baseRequest({ customerId, variantId }))
  await assert.rejects(
    () => backInStockRequestRepository.create(baseRequest({ customerId, variantId })),
    ValidationError,
  )
})

test('after cancelling, a new PENDING request for the same customer+variant is allowed', async () => {
  const customerId = oid()
  const variantId = oid()
  const first = await backInStockRequestRepository.create(baseRequest({ customerId, variantId }))
  await backInStockRequestRepository.cancel(customerId, first._id)

  const second = await backInStockRequestRepository.create(baseRequest({ customerId, variantId }))
  assert.equal(second.status, 'PENDING')
  assert.notEqual(second._id.toString(), first._id.toString())
})

test('different customers can request the same variant', async () => {
  const customerA = oid()
  const customerB = oid()
  const variantId = oid()
  await assert.doesNotReject(async () => {
    await backInStockRequestRepository.create(baseRequest({ customerId: customerA, variantId }))
    await backInStockRequestRepository.create(baseRequest({ customerId: customerB, variantId }))
  })
})

test('CONCURRENCY: two simultaneous PENDING creates for the same customer+variant — exactly one succeeds', async () => {
  const customerId = oid()
  const variantId = oid()
  const attempt = () => backInStockRequestRepository.create(baseRequest({ customerId, variantId }))

  const results = await Promise.allSettled([attempt(), attempt()])
  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  const rejected = results.filter((r) => r.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof ValidationError)
})

test('toJSON output never includes __v', async () => {
  const request = await backInStockRequestRepository.create(baseRequest())
  const json = request.toJSON() as unknown as Record<string, unknown>
  assert.equal(json.__v, undefined)
})

test('the declared indexes exist, including the PENDING-scoped partial unique index', async () => {
  const indexes = await BackInStockRequestModel.collection.indexes()

  const partialIndex = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ customerId: 1, variantId: 1, status: 1 }),
  )
  assert.ok(partialIndex, 'expected a {customerId, variantId, status} index')
  assert.equal(partialIndex?.unique, true)
  assert.deepEqual(partialIndex?.partialFilterExpression, { status: 'PENDING' })

  const listIndex = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ customerId: 1 }),
  )
  assert.ok(listIndex, 'expected a {customerId: 1} index')

  const dispatchIndex = indexes.find(
    (idx) =>
      JSON.stringify(idx.key) === JSON.stringify({ organizationId: 1, variantId: 1, status: 1 }),
  )
  assert.ok(dispatchIndex, 'expected an {organizationId, variantId, status} index')
})
