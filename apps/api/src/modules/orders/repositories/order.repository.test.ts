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
