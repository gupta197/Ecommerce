import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { ZodError } from 'zod'
import { OrderModel } from '../../orders/models/order.model.js'
import { ReturnRequestModel } from '../models/return-request.model.js'
import { ReturnRequestLockModel } from '../models/return-request-lock.model.js'
import { CustomerModel } from '../../customers/models/customer.model.js'
import { AuditEventModel } from '../../audit/models/audit-event.model.js'
import * as customerRepository from '../../customers/repositories/customer.repository.js'
import * as orderRepository from '../../orders/repositories/order.repository.js'
import type { CreateOrderData } from '../../orders/repositories/order.repository.js'
import { requestReturn, listReturnsForOrder } from './return-request.service.js'
import { NotFoundError, ValidationError } from '../../../lib/http-errors.js'

let replSet: MongoMemoryReplSet

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  await mongoose.connect(replSet.getUri(), { dbName: 'com_004_return_request_service_test' })
  await Promise.all([
    OrderModel.init(),
    ReturnRequestModel.init(),
    ReturnRequestLockModel.init(),
    CustomerModel.init(),
    AuditEventModel.init(),
  ])
})

after(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

beforeEach(async () => {
  await Promise.all([
    OrderModel.deleteMany({}),
    ReturnRequestModel.deleteMany({}),
    ReturnRequestLockModel.deleteMany({}),
    CustomerModel.deleteMany({}),
    AuditEventModel.deleteMany({}),
  ])
})

function oid(): Types.ObjectId {
  return new Types.ObjectId()
}

async function createRealCustomer(status: 'ACTIVE' | 'ARCHIVED' = 'ACTIVE') {
  return customerRepository.create({
    userId: oid(),
    firstName: 'Ada',
    lastName: 'Lovelace',
    status,
  })
}

function baseAddress() {
  return {
    recipientName: 'Ada Lovelace',
    line1: '1 Analytical Engine Way',
    city: 'London',
    state: 'London',
    postalCode: 'AB1 2CD',
    country: 'UK',
  }
}

async function createRealOrder(
  overrides: Partial<CreateOrderData> & { variantId?: Types.ObjectId; quantity?: number } = {},
) {
  const variantId = overrides.variantId ?? oid()
  return orderRepository.create({
    customerId: overrides.customerId ?? oid(),
    organizationId: overrides.organizationId ?? oid(),
    items: overrides.items ?? [
      {
        variantId,
        productId: oid(),
        name: 'Widget',
        sku: 'SKU-1',
        price: 100,
        quantity: overrides.quantity ?? 3,
        subtotal: 300,
      },
    ],
    subtotal: 300,
    total: 300,
    status: overrides.status ?? 'DELIVERED',
    shippingAddress: overrides.shippingAddress ?? baseAddress(),
    billingAddress: overrides.billingAddress ?? baseAddress(),
  })
}

function returnInput(variantId: Types.ObjectId, quantity: number, reason = 'Damaged on arrival') {
  return { items: [{ variantId: variantId.toString(), quantity }], reason }
}

// ---------------------------------------------------------------------------
// Basic creation / ownership
// ---------------------------------------------------------------------------

test('creates a PENDING return request for a delivered order', async () => {
  const customer = await createRealCustomer()
  const variantId = oid()
  const order = await createRealOrder({ customerId: customer._id, variantId, quantity: 3 })

  const request = await requestReturn(customer._id, order._id, returnInput(variantId, 1))
  assert.equal(request.status, 'PENDING')
  assert.equal(request.items[0]?.quantity, 1)
  assert.equal(request.orderId.toString(), order._id.toString())
  assert.equal(request.organizationId.toString(), order.organizationId.toString())
})

test('rejects a return request for a nonexistent order', async () => {
  const customer = await createRealCustomer()
  await assert.rejects(
    () => requestReturn(customer._id, oid(), returnInput(oid(), 1)),
    NotFoundError,
  )
})

test("a different customer cannot request a return against another customer's order (IDOR)", async () => {
  const customerA = await createRealCustomer()
  const customerB = await createRealCustomer()
  const variantId = oid()
  const order = await createRealOrder({ customerId: customerA._id, variantId })
  await assert.rejects(
    () => requestReturn(customerB._id, order._id, returnInput(variantId, 1)),
    NotFoundError,
  )
})

test('an archived customer cannot request a return', async () => {
  const customer = await createRealCustomer('ARCHIVED')
  const variantId = oid()
  const order = await createRealOrder({ customerId: customer._id, variantId })
  await assert.rejects(
    () => requestReturn(customer._id, order._id, returnInput(variantId, 1)),
    ValidationError,
  )
})

// ---------------------------------------------------------------------------
// DELIVERED-only
// ---------------------------------------------------------------------------

for (const status of ['PENDING_PAYMENT', 'CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED'] as const) {
  test(`rejects a return request for an order that is not DELIVERED (status=${status})`, async () => {
    const customer = await createRealCustomer()
    const variantId = oid()
    const order = await createRealOrder({ customerId: customer._id, variantId, status })
    await assert.rejects(
      () => requestReturn(customer._id, order._id, returnInput(variantId, 1)),
      ValidationError,
    )
  })
}

test('rejects a return request for a CANCELLED order', async () => {
  const customer = await createRealCustomer()
  const variantId = oid()
  const order = await createRealOrder({ customerId: customer._id, variantId, status: 'CANCELLED' })
  await assert.rejects(
    () => requestReturn(customer._id, order._id, returnInput(variantId, 1)),
    ValidationError,
  )
})

// ---------------------------------------------------------------------------
// Quantity integrity — snapshot and cumulative
// ---------------------------------------------------------------------------

test('rejects a return quantity exceeding the purchased quantity', async () => {
  const customer = await createRealCustomer()
  const variantId = oid()
  const order = await createRealOrder({ customerId: customer._id, variantId, quantity: 3 })
  await assert.rejects(
    () => requestReturn(customer._id, order._id, returnInput(variantId, 4)),
    ValidationError,
  )
})

test('rejects a return request naming a variant that was not part of the order', async () => {
  const customer = await createRealCustomer()
  const variantId = oid()
  const order = await createRealOrder({ customerId: customer._id, variantId })
  await assert.rejects(
    () => requestReturn(customer._id, order._id, returnInput(oid(), 1)),
    ValidationError,
  )
})

test('allows returning the exact full purchased quantity', async () => {
  const customer = await createRealCustomer()
  const variantId = oid()
  const order = await createRealOrder({ customerId: customer._id, variantId, quantity: 3 })
  const request = await requestReturn(customer._id, order._id, returnInput(variantId, 3))
  assert.equal(request.items[0]?.quantity, 3)
})

test('a second return request is rejected once the cumulative non-rejected total would exceed the purchased quantity', async () => {
  const customer = await createRealCustomer()
  const variantId = oid()
  const order = await createRealOrder({ customerId: customer._id, variantId, quantity: 3 })

  await requestReturn(customer._id, order._id, returnInput(variantId, 2))
  await assert.rejects(
    () => requestReturn(customer._id, order._id, returnInput(variantId, 2)),
    ValidationError,
  )

  // Confirm nothing partial was written for the rejected attempt.
  const totalRequested = await ReturnRequestModel.aggregate([
    { $match: { orderId: order._id } },
    { $unwind: '$items' },
    { $group: { _id: null, total: { $sum: '$items.quantity' } } },
  ])
  assert.equal(totalRequested[0]?.total, 2)
})

test('a second return request succeeds when the cumulative non-rejected total stays within the purchased quantity', async () => {
  const customer = await createRealCustomer()
  const variantId = oid()
  const order = await createRealOrder({ customerId: customer._id, variantId, quantity: 3 })

  await requestReturn(customer._id, order._id, returnInput(variantId, 1))
  const second = await requestReturn(customer._id, order._id, returnInput(variantId, 2))
  assert.equal(second.items[0]?.quantity, 2)
  assert.equal(await ReturnRequestModel.countDocuments({ orderId: order._id }), 2)
})

test('a REJECTED return request no longer counts toward the returnable quantity', async () => {
  const customer = await createRealCustomer()
  const variantId = oid()
  const order = await createRealOrder({ customerId: customer._id, variantId, quantity: 3 })

  // Simulate a prior rejection directly via the model — no public API can
  // reach REJECTED in this tranche (that is an explicitly deferred
  // Tranche B / staff-decision capability), but the rejection-exclusion
  // behavior must still be correct right now, by construction (a live
  // query, not a cached counter — see return-request-lock.model.ts).
  await ReturnRequestModel.create({
    orderId: order._id,
    customerId: customer._id,
    organizationId: order.organizationId,
    items: [{ variantId, quantity: 3 }],
    reason: 'Previously rejected',
    status: 'REJECTED',
  })

  // Despite 3 already "requested" (but rejected), the full original
  // quantity should still be returnable.
  const request = await requestReturn(customer._id, order._id, returnInput(variantId, 3))
  assert.equal(request.items[0]?.quantity, 3)
})

test('multiple items in one request are each validated against their own purchased quantity', async () => {
  const customer = await createRealCustomer()
  const variantA = oid()
  const variantB = oid()
  const order = await orderRepository.create({
    customerId: customer._id,
    organizationId: oid(),
    items: [
      {
        variantId: variantA,
        productId: oid(),
        name: 'A',
        sku: 'A',
        price: 10,
        quantity: 2,
        subtotal: 20,
      },
      {
        variantId: variantB,
        productId: oid(),
        name: 'B',
        sku: 'B',
        price: 10,
        quantity: 1,
        subtotal: 10,
      },
    ],
    subtotal: 30,
    total: 30,
    status: 'DELIVERED',
    shippingAddress: baseAddress(),
    billingAddress: baseAddress(),
  })

  await assert.rejects(
    () =>
      requestReturn(customer._id, order._id, {
        items: [
          { variantId: variantA.toString(), quantity: 1 },
          { variantId: variantB.toString(), quantity: 2 }, // exceeds purchased quantity of 1
        ],
        reason: 'Partial issue',
      }),
    ValidationError,
  )
  // All-or-nothing: no request should have been created for either item.
  assert.equal(await ReturnRequestModel.countDocuments({ orderId: order._id }), 0)
})

// ---------------------------------------------------------------------------
// CONCURRENCY — the central required guarantee
// ---------------------------------------------------------------------------

test('CONCURRENCY: two simultaneous overlapping return requests cannot together exceed the purchased quantity', async () => {
  const customer = await createRealCustomer()
  const variantId = oid()
  const order = await createRealOrder({ customerId: customer._id, variantId, quantity: 3 })

  // Each individually fits (2 <= 3), but together they would total 4 > 3.
  const attempt = () => requestReturn(customer._id, order._id, returnInput(variantId, 2))
  const results = await Promise.allSettled([attempt(), attempt()])

  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  const rejected = results.filter((r) => r.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof ValidationError)

  assert.equal(await ReturnRequestModel.countDocuments({ orderId: order._id }), 1)
  const totalRequested = await ReturnRequestModel.aggregate([
    { $match: { orderId: order._id } },
    { $unwind: '$items' },
    { $group: { _id: null, total: { $sum: '$items.quantity' } } },
  ])
  assert.equal(totalRequested[0]?.total, 2)
})

test('CONCURRENCY: two simultaneous non-overlapping return requests both succeed', async () => {
  const customer = await createRealCustomer()
  const variantId = oid()
  const order = await createRealOrder({ customerId: customer._id, variantId, quantity: 3 })

  const results = await Promise.allSettled([
    requestReturn(customer._id, order._id, returnInput(variantId, 1)),
    requestReturn(customer._id, order._id, returnInput(variantId, 2)),
  ])
  assert.ok(results.every((r) => r.status === 'fulfilled'))
  assert.equal(await ReturnRequestModel.countDocuments({ orderId: order._id }), 2)
})

// ---------------------------------------------------------------------------
// Order immutability
// ---------------------------------------------------------------------------

test('requesting a return never modifies the Order itself', async () => {
  const customer = await createRealCustomer()
  const variantId = oid()
  const order = await createRealOrder({ customerId: customer._id, variantId, quantity: 3 })
  const before = await OrderModel.findById(order._id)

  await requestReturn(customer._id, order._id, returnInput(variantId, 1))

  const after = await OrderModel.findById(order._id)
  assert.deepEqual(before?.items, after?.items)
  assert.equal(before?.subtotal, after?.subtotal)
  assert.equal(before?.total, after?.total)
  assert.deepEqual(before?.shippingAddress, after?.shippingAddress)
  assert.deepEqual(before?.billingAddress, after?.billingAddress)
  assert.equal(after?.status, 'DELIVERED')
})

// ---------------------------------------------------------------------------
// Validation / mass-assignment / injection
// ---------------------------------------------------------------------------

test('rejects mass-assignment of customerId/organizationId/status/orderId', async () => {
  const customer = await createRealCustomer()
  const variantId = oid()
  const order = await createRealOrder({ customerId: customer._id, variantId })
  const forbiddenFields: Record<string, unknown> = {
    customerId: oid().toString(),
    organizationId: oid().toString(),
    status: 'APPROVED',
    orderId: oid().toString(),
    _id: oid().toString(),
  }
  for (const [field, value] of Object.entries(forbiddenFields)) {
    await assert.rejects(
      () =>
        requestReturn(customer._id, order._id, {
          ...returnInput(variantId, 1),
          [field]: value,
        }),
      ZodError,
    )
  }
})

test('rejects a Mongo-operator-shaped variantId', async () => {
  const customer = await createRealCustomer()
  const order = await createRealOrder({ customerId: customer._id })
  await assert.rejects(
    () =>
      requestReturn(customer._id, order._id, {
        items: [{ variantId: { $ne: null }, quantity: 1 }],
        reason: 'Test',
      }),
    ZodError,
  )
})

test('rejects quantity 0, negative, fractional, NaN, Infinity', async () => {
  const customer = await createRealCustomer()
  const variantId = oid()
  const order = await createRealOrder({ customerId: customer._id, variantId })
  for (const quantity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      () => requestReturn(customer._id, order._id, returnInput(variantId, quantity)),
      ZodError,
    )
  }
})

test('rejects an empty items array and a missing reason', async () => {
  const customer = await createRealCustomer()
  const order = await createRealOrder({ customerId: customer._id })
  await assert.rejects(
    () => requestReturn(customer._id, order._id, { items: [], reason: 'Test' }),
    ZodError,
  )
  await assert.rejects(
    () =>
      requestReturn(customer._id, order._id, {
        items: [{ variantId: oid().toString(), quantity: 1 }],
      }),
    ZodError,
  )
})

// ---------------------------------------------------------------------------
// Inventory — negative-space proof
// ---------------------------------------------------------------------------

test('requesting a return never touches StockBalance or InventoryTransaction', async () => {
  const { StockBalanceModel } = await import('../../inventory/models/stock-balance.model.js')
  const { InventoryTransactionModel } =
    await import('../../inventory/models/inventory-transaction.model.js')
  const customer = await createRealCustomer()
  const variantId = oid()
  const order = await createRealOrder({ customerId: customer._id, variantId, quantity: 3 })

  await requestReturn(customer._id, order._id, returnInput(variantId, 1))

  assert.equal(await StockBalanceModel.countDocuments({}), 0)
  assert.equal(await InventoryTransactionModel.countDocuments({}), 0)
})

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

test('a successful return request produces a return.requested audit event', async () => {
  const customer = await createRealCustomer()
  const variantId = oid()
  const order = await createRealOrder({ customerId: customer._id, variantId })
  const request = await requestReturn(customer._id, order._id, returnInput(variantId, 1))

  const events = await AuditEventModel.find({ action: 'return.requested' })
  assert.equal(events.length, 1)
  assert.equal(events[0]?.entityType, 'ReturnRequest')
  assert.equal(events[0]?.entityId?.toString(), request._id.toString())
  assert.equal(events[0]?.actorUserId?.toString(), customer._id.toString())
  assert.equal(events[0]?.organizationId?.toString(), order.organizationId.toString())
})

test('a rejected return request produces no audit event', async () => {
  const customer = await createRealCustomer()
  const variantId = oid()
  const order = await createRealOrder({ customerId: customer._id, variantId, quantity: 2 })
  await assert.rejects(() => requestReturn(customer._id, order._id, returnInput(variantId, 5)))
  assert.equal(await AuditEventModel.countDocuments({}), 0)
})

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

test('listReturnsForOrder returns only requests for that order, scoped by customer', async () => {
  const customer = await createRealCustomer()
  const variantId = oid()
  const order = await createRealOrder({ customerId: customer._id, variantId, quantity: 3 })
  await requestReturn(customer._id, order._id, returnInput(variantId, 1))

  const result = await listReturnsForOrder(customer._id, order._id, {})
  assert.equal(result.total, 1)
})

test("listReturnsForOrder throws NotFoundError for another customer's order", async () => {
  const customerA = await createRealCustomer()
  const customerB = await createRealCustomer()
  const order = await createRealOrder({ customerId: customerA._id })
  await assert.rejects(() => listReturnsForOrder(customerB._id, order._id, {}), NotFoundError)
})
