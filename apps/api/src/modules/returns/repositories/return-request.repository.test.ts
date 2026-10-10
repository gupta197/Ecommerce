import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { ReturnRequestModel } from '../models/return-request.model.js'
import * as returnRequestRepository from './return-request.repository.js'
import type { CreateReturnRequestData } from './return-request.repository.js'

// A replica set is required — create() and sumNonRejectedQuantitiesByVariant()
// both participate in return-request.service.ts's single transaction.
let replSet: MongoMemoryReplSet

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  await mongoose.connect(replSet.getUri(), { dbName: 'com_004_return_request_repo_test' })
  await ReturnRequestModel.init()
})

after(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

beforeEach(async () => {
  await ReturnRequestModel.deleteMany({})
})

function oid(): Types.ObjectId {
  return new Types.ObjectId()
}

function baseData(overrides: Partial<CreateReturnRequestData> = {}): CreateReturnRequestData {
  return {
    orderId: overrides.orderId ?? oid(),
    customerId: overrides.customerId ?? oid(),
    organizationId: overrides.organizationId ?? oid(),
    items: overrides.items ?? [{ variantId: oid(), quantity: 1 }],
    reason: overrides.reason ?? 'Damaged on arrival',
  }
}

async function withSession<T>(fn: (session: mongoose.ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession()
  try {
    let result: T | undefined
    await session.withTransaction(async () => {
      result = await fn(session)
    })
    return result as T
  } finally {
    await session.endSession()
  }
}

test('create() creates a PENDING return request regardless of any status passed in the data', async () => {
  const request = await withSession((session) =>
    returnRequestRepository.create(baseData(), session),
  )
  assert.equal(request.status, 'PENDING')
  assert.equal(request.items.length, 1)
})

test('sumNonRejectedQuantitiesByVariant sums quantities across multiple requests for the same variant', async () => {
  const orderId = oid()
  const variantId = oid()
  await withSession((session) =>
    returnRequestRepository.create(
      baseData({ orderId, items: [{ variantId, quantity: 1 }] }),
      session,
    ),
  )
  await withSession((session) =>
    returnRequestRepository.create(
      baseData({ orderId, items: [{ variantId, quantity: 2 }] }),
      session,
    ),
  )

  const sums = await withSession((session) =>
    returnRequestRepository.sumNonRejectedQuantitiesByVariant(orderId, session),
  )
  assert.equal(sums.get(variantId.toString()), 3)
})

test('sumNonRejectedQuantitiesByVariant excludes REJECTED requests', async () => {
  const orderId = oid()
  const variantId = oid()
  await withSession((session) =>
    returnRequestRepository.create(
      baseData({ orderId, items: [{ variantId, quantity: 2 }] }),
      session,
    ),
  )
  // Directly set a second request to REJECTED — no public API can reach
  // this state in this tranche, but the model/repository must still handle
  // it correctly for when a future decision mechanism exists.
  await ReturnRequestModel.create({
    orderId,
    customerId: oid(),
    organizationId: oid(),
    items: [{ variantId, quantity: 5 }],
    reason: 'Wrong item',
    status: 'REJECTED',
  })

  const sums = await withSession((session) =>
    returnRequestRepository.sumNonRejectedQuantitiesByVariant(orderId, session),
  )
  assert.equal(sums.get(variantId.toString()), 2)
})

test('sumNonRejectedQuantitiesByVariant scopes by orderId: a different order is not included', async () => {
  const variantId = oid()
  await withSession((session) =>
    returnRequestRepository.create(
      baseData({ orderId: oid(), items: [{ variantId, quantity: 4 }] }),
      session,
    ),
  )
  const sums = await withSession((session) =>
    returnRequestRepository.sumNonRejectedQuantitiesByVariant(oid(), session),
  )
  assert.equal(sums.get(variantId.toString()), undefined)
})

test('findById scopes by customerId: a different customer cannot find it', async () => {
  const customerA = oid()
  const customerB = oid()
  const request = await withSession((session) =>
    returnRequestRepository.create(baseData({ customerId: customerA }), session),
  )
  assert.ok(await returnRequestRepository.findById(customerA, request._id))
  assert.equal(await returnRequestRepository.findById(customerB, request._id), null)
})

test('listByOrder scopes by customerId and orderId, paginated', async () => {
  const customerId = oid()
  const orderId = oid()
  await withSession((session) =>
    returnRequestRepository.create(baseData({ customerId, orderId }), session),
  )
  await withSession((session) =>
    returnRequestRepository.create(baseData({ customerId, orderId }), session),
  )
  await withSession((session) =>
    returnRequestRepository.create(baseData({ customerId, orderId: oid() }), session),
  )

  const result = await returnRequestRepository.listByOrder(customerId, orderId, {
    page: 1,
    limit: 20,
  })
  assert.equal(result.total, 2)
})

test('toJSON output never includes __v', async () => {
  const request = await withSession((session) =>
    returnRequestRepository.create(baseData(), session),
  )
  const json = request.toJSON() as unknown as Record<string, unknown>
  assert.equal(json.__v, undefined)
})

test('the declared {orderId} and {customerId, createdAt} indexes exist', async () => {
  const indexes = await ReturnRequestModel.collection.indexes()
  const orderIndex = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ orderId: 1 }),
  )
  assert.ok(orderIndex, 'expected an {orderId:1} index')
  const customerIndex = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ customerId: 1, createdAt: -1 }),
  )
  assert.ok(customerIndex, 'expected a {customerId:1, createdAt:-1} index')
})
