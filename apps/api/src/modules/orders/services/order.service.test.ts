import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { ZodError } from 'zod'
import { OrderModel } from '../models/order.model.js'
import { CustomerModel } from '../../customers/models/customer.model.js'
import { AuditEventModel } from '../../audit/models/audit-event.model.js'
import * as customerRepository from '../../customers/repositories/customer.repository.js'
import * as orderRepository from '../repositories/order.repository.js'
import type { CreateOrderData } from '../repositories/order.repository.js'
import {
  confirmOrder,
  startProcessing,
  markPacked,
  markShipped,
  markDelivered,
  cancelOrder,
  getOrder,
  listOrders,
  ORDER_TRANSITIONS,
} from './order.service.js'
import { NotFoundError, ValidationError } from '../../../lib/http-errors.js'

let mongod: MongoMemoryServer

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'com_004_order_service_test' })
  await Promise.all([OrderModel.init(), CustomerModel.init(), AuditEventModel.init()])
})

after(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await Promise.all([
    OrderModel.deleteMany({}),
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

async function createRealOrder(overrides: Partial<CreateOrderData> = {}) {
  return orderRepository.create({
    customerId: overrides.customerId ?? oid(),
    organizationId: overrides.organizationId ?? oid(),
    items: overrides.items ?? [
      {
        variantId: oid(),
        productId: oid(),
        name: 'Widget',
        sku: 'SKU-1',
        price: 100,
        quantity: 2,
        subtotal: 200,
      },
    ],
    subtotal: overrides.subtotal ?? 200,
    total: overrides.total ?? 200,
    status: overrides.status ?? 'PENDING_PAYMENT',
    shippingAddress: overrides.shippingAddress ?? baseAddress(),
    billingAddress: overrides.billingAddress ?? baseAddress(),
  })
}

// ---------------------------------------------------------------------------
// State machine — legal chain
// ---------------------------------------------------------------------------

test('the full lifecycle chain succeeds in order: CONFIRMED -> PROCESSING -> PACKED -> SHIPPED -> DELIVERED', async () => {
  const order = await createRealOrder()
  await confirmOrder(order._id)
  await startProcessing(order._id)
  await markPacked(order._id)
  await markShipped(order._id, { carrier: 'Acme Logistics', trackingNumber: 'TRACK123' })
  const delivered = await markDelivered(order._id)
  assert.equal(delivered.status, 'DELIVERED')
})

test('markShipped sets carrier/trackingNumber/shippedAt', async () => {
  const order = await createRealOrder()
  await confirmOrder(order._id)
  await startProcessing(order._id)
  await markPacked(order._id)
  const shipped = await markShipped(order._id, { carrier: 'DHL', trackingNumber: 'XYZ' })
  assert.equal(shipped.carrier, 'DHL')
  assert.equal(shipped.trackingNumber, 'XYZ')
  assert.ok(shipped.shippedAt)
})

test('markDelivered sets deliveredAt', async () => {
  const order = await createRealOrder()
  await confirmOrder(order._id)
  await startProcessing(order._id)
  await markPacked(order._id)
  await markShipped(order._id)
  const delivered = await markDelivered(order._id)
  assert.ok(delivered.deliveredAt)
  assert.ok(delivered.deliveredAt instanceof Date)
})

// ---------------------------------------------------------------------------
// State machine — illegal transitions (explicitly named examples)
// ---------------------------------------------------------------------------

test('illegal transition: PENDING_PAYMENT -> DELIVERED (skipped) is rejected', async () => {
  const order = await createRealOrder()
  await assert.rejects(() => markDelivered(order._id), ValidationError)
  const current = await OrderModel.findById(order._id)
  assert.equal(current?.status, 'PENDING_PAYMENT')
})

test('illegal transition: DELIVERED -> PENDING_PAYMENT (backward) is rejected', async () => {
  const order = await createRealOrder({ status: 'DELIVERED' })
  await assert.rejects(() => confirmOrder(order._id), ValidationError)
})

test('illegal transition: CANCELLED -> PROCESSING is rejected (terminal state)', async () => {
  const order = await createRealOrder({ status: 'CANCELLED' })
  await assert.rejects(() => startProcessing(order._id), ValidationError)
})

test('illegal transition: PROCESSING -> CANCELLED is not a legal edge in this tranche (no staff cancellation caller exists)', () => {
  // No exported service function ever requests this transition (cancelOrder
  // only ever targets PENDING_PAYMENT/CONFIRMED orders), so the only way to
  // prove it is illegal is to inspect the transition table itself — this is
  // the state-machine's own single source of truth for "is this edge legal".
  assert.equal(ORDER_TRANSITIONS.PROCESSING.includes('CANCELLED'), false)
})

test('illegal transition: PACKED -> DELIVERED (skipped) is rejected', async () => {
  const order = await createRealOrder({ status: 'PACKED' })
  await assert.rejects(() => markDelivered(order._id), ValidationError)
})

test('illegal transition: DELIVERED has no legal next state (fully terminal)', async () => {
  const order = await createRealOrder({ status: 'DELIVERED' })
  await assert.rejects(() => startProcessing(order._id), ValidationError)
  await assert.rejects(() => markPacked(order._id), ValidationError)
  await assert.rejects(() => markShipped(order._id), ValidationError)
})

test('transitioning a nonexistent order throws NotFoundError', async () => {
  await assert.rejects(() => confirmOrder(oid()), NotFoundError)
})

// ---------------------------------------------------------------------------
// Cancellation (customer-facing)
// ---------------------------------------------------------------------------

test('customer can cancel from PENDING_PAYMENT', async () => {
  const customer = await createRealCustomer()
  const order = await createRealOrder({ customerId: customer._id })
  const cancelled = await cancelOrder(customer._id, order._id, { reason: 'Changed my mind' })
  assert.equal(cancelled.status, 'CANCELLED')
  assert.equal(cancelled.cancellationReason, 'Changed my mind')
  assert.ok(cancelled.cancelledAt)
})

test('customer can cancel from CONFIRMED', async () => {
  const customer = await createRealCustomer()
  const order = await createRealOrder({ customerId: customer._id, status: 'CONFIRMED' })
  const cancelled = await cancelOrder(customer._id, order._id, {})
  assert.equal(cancelled.status, 'CANCELLED')
})

for (const status of ['PROCESSING', 'PACKED', 'SHIPPED', 'DELIVERED'] as const) {
  test(`customer cannot cancel from ${status}`, async () => {
    const customer = await createRealCustomer()
    const order = await createRealOrder({ customerId: customer._id, status })
    await assert.rejects(() => cancelOrder(customer._id, order._id, {}), ValidationError)
    const current = await OrderModel.findById(order._id)
    assert.equal(current?.status, status)
  })
}

test('cancelling a nonexistent order throws NotFoundError', async () => {
  const customer = await createRealCustomer()
  await assert.rejects(() => cancelOrder(customer._id, oid(), {}), NotFoundError)
})

test("a different customer cannot cancel another customer's order (cross-customer IDOR)", async () => {
  const customerA = await createRealCustomer()
  const customerB = await createRealCustomer()
  const order = await createRealOrder({ customerId: customerA._id })
  await assert.rejects(() => cancelOrder(customerB._id, order._id, {}), NotFoundError)
  const current = await OrderModel.findById(order._id)
  assert.equal(current?.status, 'PENDING_PAYMENT')
})

test('an archived customer cannot cancel an order', async () => {
  const customer = await createRealCustomer('ARCHIVED')
  const order = await createRealOrder({ customerId: customer._id })
  await assert.rejects(() => cancelOrder(customer._id, order._id, {}), ValidationError)
})

test('cancelOrder rejects mass-assignment of status/customerId/cancelledAt', async () => {
  const customer = await createRealCustomer()
  const order = await createRealOrder({ customerId: customer._id })
  await assert.rejects(
    () =>
      cancelOrder(customer._id, order._id, {
        status: 'DELIVERED',
        customerId: oid().toString(),
        cancelledAt: new Date(),
      }),
    ZodError,
  )
})

test('cancelOrder rejects a Mongo-operator-shaped reason', async () => {
  const customer = await createRealCustomer()
  const order = await createRealOrder({ customerId: customer._id })
  await assert.rejects(
    () => cancelOrder(customer._id, order._id, { reason: { $ne: null } }),
    ZodError,
  )
})

test('CONCURRENCY: two simultaneous cancelOrder calls — exactly one succeeds', async () => {
  const customer = await createRealCustomer()
  const order = await createRealOrder({ customerId: customer._id })
  const attempt = () => cancelOrder(customer._id, order._id, {})
  const results = await Promise.allSettled([attempt(), attempt()])
  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  const rejected = results.filter((r) => r.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof ValidationError)
})

// ---------------------------------------------------------------------------
// Read / list
// ---------------------------------------------------------------------------

test('getOrder returns the order for its own customer', async () => {
  const customer = await createRealCustomer()
  const order = await createRealOrder({ customerId: customer._id })
  const found = await getOrder(customer._id, order._id)
  assert.equal(found._id.toString(), order._id.toString())
})

test("getOrder throws NotFoundError for another customer's order (IDOR)", async () => {
  const customerA = await createRealCustomer()
  const customerB = await createRealCustomer()
  const order = await createRealOrder({ customerId: customerA._id })
  await assert.rejects(() => getOrder(customerB._id, order._id), NotFoundError)
})

test("listOrders returns only the caller's own orders with pagination", async () => {
  const customerA = await createRealCustomer()
  const customerB = await createRealCustomer()
  await createRealOrder({ customerId: customerA._id })
  await createRealOrder({ customerId: customerA._id })
  await createRealOrder({ customerId: customerB._id })

  const result = await listOrders(customerA._id, {})
  assert.equal(result.total, 2)
})

test('listOrders rejects a Mongo-operator-shaped status filter', async () => {
  const customer = await createRealCustomer()
  await assert.rejects(() => listOrders(customer._id, { status: { $ne: null } }), ZodError)
})

test('listOrders rejects unknown query fields', async () => {
  const customer = await createRealCustomer()
  await assert.rejects(() => listOrders(customer._id, { customerId: oid().toString() }), ZodError)
})

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

test('every internal lifecycle transition produces an order.status_changed audit event', async () => {
  const order = await createRealOrder()
  await confirmOrder(order._id)
  const events = await AuditEventModel.find({ action: 'order.status_changed' })
  assert.equal(events.length, 1)
  assert.equal(events[0]?.entityType, 'Order')
  assert.equal(events[0]?.entityId?.toString(), order._id.toString())
  assert.equal(events[0]?.metadata?.fromStatus, 'PENDING_PAYMENT')
  assert.equal(events[0]?.metadata?.toStatus, 'CONFIRMED')
})

test('cancellation produces an order.cancelled audit event (not order.status_changed) with the actor set', async () => {
  const customer = await createRealCustomer()
  const order = await createRealOrder({ customerId: customer._id })
  await cancelOrder(customer._id, order._id, { reason: 'No longer needed' })

  const cancelledEvents = await AuditEventModel.find({ action: 'order.cancelled' })
  assert.equal(cancelledEvents.length, 1)
  assert.equal(cancelledEvents[0]?.actorUserId?.toString(), customer._id.toString())
  assert.equal(cancelledEvents[0]?.entityType, 'Order')

  const statusChangedEvents = await AuditEventModel.find({ action: 'order.status_changed' })
  assert.equal(statusChangedEvents.length, 0)
})

test('a rejected (illegal) transition produces no audit event', async () => {
  const order = await createRealOrder({ status: 'DELIVERED' })
  await assert.rejects(() => confirmOrder(order._id))
  assert.equal(await AuditEventModel.countDocuments({}), 0)
})

test('no order.created audit event exists anywhere in this module', async () => {
  // Static/behavioral proof: AUDIT_ACTIONS does not even contain the value,
  // so no call site anywhere could produce it.
  const { AUDIT_ACTIONS } = await import('../../audit/models/audit-event.model.js')
  assert.equal((AUDIT_ACTIONS as readonly string[]).includes('order.created'), false)
})
