import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { OrderModel } from '../models/order.model.js'
import * as orderRepository from './order.repository.js'
import type { CreateOrderData } from './order.repository.js'

// A replica set is required — order.repository.ts's create() must support
// an optional session (checkout.service.ts creates an Order inside the same
// transaction that clears the Cart), which a standalone MongoMemoryServer
// cannot run.
let replSet: MongoMemoryReplSet

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  await mongoose.connect(replSet.getUri(), { dbName: 'com_003_order_repo_test' })
  await OrderModel.init()
})

after(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

beforeEach(async () => {
  await OrderModel.deleteMany({})
})

function oid(): Types.ObjectId {
  return new Types.ObjectId()
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

function baseOrderData(overrides: Partial<CreateOrderData> = {}): CreateOrderData {
  return {
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
  }
}

test('creates an order with the given snapshot data', async () => {
  const order = await orderRepository.create(baseOrderData())
  assert.equal(order.status, 'PENDING_PAYMENT')
  assert.equal(order.subtotal, 200)
  assert.equal(order.total, 200)
  assert.equal(order.items.length, 1)
  assert.equal(order.items[0]?.name, 'Widget')
  assert.equal(order.items[0]?.sku, 'SKU-1')
  assert.equal(order.items[0]?.price, 100)
  assert.equal(order.items[0]?.subtotal, 200)
  assert.equal(order.shippingAddress.recipientName, 'Ada Lovelace')
  assert.equal(order.billingAddress.city, 'London')
})

test('preserves distinct shipping and billing address snapshots', async () => {
  const order = await orderRepository.create(
    baseOrderData({
      shippingAddress: { ...baseAddress(), city: 'Shipping City' },
      billingAddress: { ...baseAddress(), city: 'Billing City' },
    }),
  )
  assert.equal(order.shippingAddress.city, 'Shipping City')
  assert.equal(order.billingAddress.city, 'Billing City')
})

test('rejects an order with zero items at the model level', async () => {
  await assert.rejects(() => orderRepository.create(baseOrderData({ items: [] })))
})

test('preserves multiple line items independently', async () => {
  const order = await orderRepository.create(
    baseOrderData({
      items: [
        {
          variantId: oid(),
          productId: oid(),
          name: 'Widget A',
          sku: 'SKU-A',
          price: 100,
          quantity: 1,
          subtotal: 100,
        },
        {
          variantId: oid(),
          productId: oid(),
          name: 'Widget B',
          sku: 'SKU-B',
          price: 250,
          quantity: 3,
          subtotal: 750,
        },
      ],
      subtotal: 850,
      total: 850,
    }),
  )
  assert.equal(order.items.length, 2)
  assert.equal(order.items[1]?.subtotal, 750)
})

test('toJSON output never includes __v', async () => {
  const order = await orderRepository.create(baseOrderData())
  const json = order.toJSON() as unknown as Record<string, unknown>
  assert.equal(json.__v, undefined)
})

// ---------------------------------------------------------------------------
// Session / transaction participation
// ---------------------------------------------------------------------------

test('create() commits when its session transaction commits', async () => {
  const session = await mongoose.startSession()
  try {
    let created: Awaited<ReturnType<typeof orderRepository.create>> | undefined
    await session.withTransaction(async () => {
      created = await orderRepository.create(baseOrderData(), session)
    })
    assert.ok(created)
    assert.equal(await OrderModel.countDocuments({ _id: created?._id }), 1)
  } finally {
    await session.endSession()
  }
})

test('create() leaves no document if its session transaction aborts', async () => {
  const session = await mongoose.startSession()
  try {
    await assert.rejects(
      session.withTransaction(async () => {
        await orderRepository.create(baseOrderData(), session)
        throw new Error('forced abort after create')
      }),
    )
  } finally {
    await session.endSession()
  }
  assert.equal(await OrderModel.countDocuments({}), 0)
})

// ---------------------------------------------------------------------------
// COM-004 additions (ADR-027)
// ---------------------------------------------------------------------------

test('findById scopes by customerId: a different customer cannot find it', async () => {
  const customerA = oid()
  const customerB = oid()
  const order = await orderRepository.create(baseOrderData({ customerId: customerA }))
  assert.ok(await orderRepository.findById(customerA, order._id))
  assert.equal(await orderRepository.findById(customerB, order._id), null)
})

test('findByIdInternal is unscoped (no customerId parameter)', async () => {
  const order = await orderRepository.create(baseOrderData())
  const found = await orderRepository.findByIdInternal(order._id)
  assert.equal(found?._id.toString(), order._id.toString())
})

test('updateStatus applies the transition when fromStatus matches', async () => {
  const order = await orderRepository.create(baseOrderData())
  const updated = await orderRepository.updateStatus(
    { id: order._id },
    'PENDING_PAYMENT',
    'CONFIRMED',
  )
  assert.equal(updated?.status, 'CONFIRMED')
})

test('updateStatus returns null (no write) when fromStatus no longer matches', async () => {
  const order = await orderRepository.create(baseOrderData())
  await orderRepository.updateStatus({ id: order._id }, 'PENDING_PAYMENT', 'CONFIRMED')
  const stale = await orderRepository.updateStatus(
    { id: order._id },
    'PENDING_PAYMENT',
    'CANCELLED',
  )
  assert.equal(stale, null)
  const current = await OrderModel.findById(order._id)
  assert.equal(current?.status, 'CONFIRMED')
})

test('updateStatus scoped by customerId: a different customer cannot transition it', async () => {
  const customerA = oid()
  const customerB = oid()
  const order = await orderRepository.create(baseOrderData({ customerId: customerA }))
  const result = await orderRepository.updateStatus(
    { id: order._id, customerId: customerB },
    'PENDING_PAYMENT',
    'CANCELLED',
  )
  assert.equal(result, null)
  const current = await OrderModel.findById(order._id)
  assert.equal(current?.status, 'PENDING_PAYMENT')
})

test('updateStatus applies the given patch fields (e.g. deliveredAt, cancellationReason)', async () => {
  const order = await orderRepository.create(baseOrderData())
  const now = new Date()
  const updated = await orderRepository.updateStatus(
    { id: order._id },
    'PENDING_PAYMENT',
    'CANCELLED',
    { cancellationReason: 'Changed my mind', cancelledAt: now },
  )
  assert.equal(updated?.cancellationReason, 'Changed my mind')
  assert.equal(updated?.cancelledAt?.getTime(), now.getTime())
})

test('CONCURRENCY: two simultaneous updateStatus calls from the same fromStatus — exactly one succeeds', async () => {
  const order = await orderRepository.create(baseOrderData())
  const attempt = () =>
    orderRepository.updateStatus({ id: order._id }, 'PENDING_PAYMENT', 'CANCELLED')
  const [resultA, resultB] = await Promise.all([attempt(), attempt()])
  const succeeded = [resultA, resultB].filter((r) => r !== null)
  assert.equal(succeeded.length, 1)
  const current = await OrderModel.findById(order._id)
  assert.equal(current?.status, 'CANCELLED')
})

test("listByCustomer only returns the given customer's own orders, sorted by recency", async () => {
  const customerA = oid()
  const customerB = oid()
  const olderOrder = await orderRepository.create(baseOrderData({ customerId: customerA }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  const newerOrder = await orderRepository.create(baseOrderData({ customerId: customerA }))
  await orderRepository.create(baseOrderData({ customerId: customerB }))

  const result = await orderRepository.listByCustomer(customerA, {}, { page: 1, limit: 20 })
  assert.equal(result.total, 2)
  assert.equal(result.items[0]?._id.toString(), newerOrder._id.toString())
  assert.equal(result.items[1]?._id.toString(), olderOrder._id.toString())
})

test('listByCustomer filters by status and organizationId', async () => {
  const customerId = oid()
  const organizationId = oid()
  const pending = await orderRepository.create(baseOrderData({ customerId, organizationId }))
  const cancelled = await orderRepository.create(baseOrderData({ customerId, organizationId }))
  await orderRepository.updateStatus({ id: cancelled._id }, 'PENDING_PAYMENT', 'CANCELLED')
  await orderRepository.create(baseOrderData({ customerId, organizationId: oid() }))

  const byStatus = await orderRepository.listByCustomer(
    customerId,
    { status: 'CANCELLED' },
    { page: 1, limit: 20 },
  )
  assert.equal(byStatus.total, 1)
  assert.equal(byStatus.items[0]?._id.toString(), cancelled._id.toString())

  const byOrg = await orderRepository.listByCustomer(
    customerId,
    { organizationId },
    { page: 1, limit: 20 },
  )
  assert.equal(byOrg.total, 2)
  assert.equal(
    byOrg.items.some((o) => o._id.toString() === pending._id.toString()),
    true,
  )
})

test('listByCustomer paginates correctly', async () => {
  const customerId = oid()
  for (let i = 0; i < 5; i += 1) {
    await orderRepository.create(baseOrderData({ customerId }))
  }
  const page1 = await orderRepository.listByCustomer(customerId, {}, { page: 1, limit: 2 })
  const page2 = await orderRepository.listByCustomer(customerId, {}, { page: 2, limit: 2 })
  assert.equal(page1.total, 5)
  assert.equal(page1.items.length, 2)
  assert.equal(page2.items.length, 2)
  assert.notEqual(page1.items[0]?._id.toString(), page2.items[0]?._id.toString())
})

test('the declared {customerId, createdAt} and {organizationId, status} indexes exist', async () => {
  const indexes = await OrderModel.collection.indexes()
  const customerIndex = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ customerId: 1, createdAt: -1 }),
  )
  assert.ok(customerIndex, 'expected a {customerId:1, createdAt:-1} index')
  const orgStatusIndex = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ organizationId: 1, status: 1 }),
  )
  assert.ok(orgStatusIndex, 'expected a {organizationId:1, status:1} index')
})
