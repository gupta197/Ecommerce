import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { ZodError } from 'zod'
import { LocationModel } from '../models/location.model.js'
import { StockBalanceModel } from '../models/stock-balance.model.js'
import { InventoryTransactionModel } from '../models/inventory-transaction.model.js'
import { ProductModel } from '../../catalog/models/product.model.js'
import { ProductVariantModel } from '../../catalog/models/product-variant.model.js'
import * as productRepository from '../../catalog/repositories/product.repository.js'
import * as productVariantRepository from '../../catalog/repositories/product-variant.repository.js'
import * as locationRepository from '../repositories/location.repository.js'
import {
  recordTransaction,
  recordTransfer,
  getBalance,
  listTransactions,
} from './inventory.service.js'
import { ValidationError } from '../../../lib/http-errors.js'

// Requires a real replica set — recordTransaction()/recordTransfer() both
// use withTransaction(), which a standalone MongoMemoryServer cannot run.
let replSet: MongoMemoryReplSet

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  await mongoose.connect(replSet.getUri(), { dbName: 'inv_001_inventory_service_test' })
  await Promise.all([
    LocationModel.init(),
    StockBalanceModel.init(),
    InventoryTransactionModel.init(),
    ProductModel.init(),
    ProductVariantModel.init(),
  ])
})

after(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

beforeEach(async () => {
  await Promise.all([
    LocationModel.deleteMany({}),
    StockBalanceModel.deleteMany({}),
    InventoryTransactionModel.deleteMany({}),
    ProductModel.deleteMany({}),
    ProductVariantModel.deleteMany({}),
  ])
})

function oid(): Types.ObjectId {
  return new Types.ObjectId()
}

async function createRealVariant(
  organizationId: Types.ObjectId,
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED' = 'ACTIVE',
) {
  const product = await productRepository.create({
    organizationId,
    name: 'Real Product',
    slug: `real-product-${new Types.ObjectId().toString()}`,
    status: 'ACTIVE',
  })
  return productVariantRepository.create({
    organizationId,
    productId: product._id,
    sku: `SKU-${new Types.ObjectId().toString()}`,
    price: 100,
    status,
  })
}

async function createRealLocation(
  organizationId: Types.ObjectId,
  status: 'ACTIVE' | 'ARCHIVED' = 'ACTIVE',
) {
  return locationRepository.create({ organizationId, name: 'Real Location', status })
}

// ---------------------------------------------------------------------------
// recordTransaction: reference validation
// ---------------------------------------------------------------------------

test('recordTransaction: PURCHASE creates a balance and a ledger entry', async () => {
  const organizationId = oid()
  const variant = await createRealVariant(organizationId)
  const location = await createRealLocation(organizationId)

  const tx = await recordTransaction(organizationId, {
    variantId: variant._id.toString(),
    locationId: location._id.toString(),
    type: 'PURCHASE',
    quantity: 10,
  })
  assert.equal(tx.type, 'PURCHASE')
  assert.equal(tx.quantity, 10)

  const balance = await getBalance(organizationId, location._id, variant._id)
  assert.equal(balance?.quantityOnHand, 10)
})

test('recordTransaction: rejects a cross-organization variantId', async () => {
  const organizationId = oid()
  const otherOrganizationId = oid()
  const variant = await createRealVariant(otherOrganizationId)
  const location = await createRealLocation(organizationId)

  await assert.rejects(
    () =>
      recordTransaction(organizationId, {
        variantId: variant._id.toString(),
        locationId: location._id.toString(),
        type: 'PURCHASE',
        quantity: 10,
      }),
    ValidationError,
  )
})

test('recordTransaction: rejects a nonexistent variantId', async () => {
  const organizationId = oid()
  const location = await createRealLocation(organizationId)
  await assert.rejects(
    () =>
      recordTransaction(organizationId, {
        variantId: oid().toString(),
        locationId: location._id.toString(),
        type: 'PURCHASE',
        quantity: 10,
      }),
    ValidationError,
  )
})

test('recordTransaction: rejects an ARCHIVED variant', async () => {
  const organizationId = oid()
  const variant = await createRealVariant(organizationId, 'ARCHIVED')
  const location = await createRealLocation(organizationId)
  await assert.rejects(
    () =>
      recordTransaction(organizationId, {
        variantId: variant._id.toString(),
        locationId: location._id.toString(),
        type: 'PURCHASE',
        quantity: 10,
      }),
    ValidationError,
  )
})

test('recordTransaction: rejects a cross-organization locationId', async () => {
  const organizationId = oid()
  const otherOrganizationId = oid()
  const variant = await createRealVariant(organizationId)
  const location = await createRealLocation(otherOrganizationId)
  await assert.rejects(
    () =>
      recordTransaction(organizationId, {
        variantId: variant._id.toString(),
        locationId: location._id.toString(),
        type: 'PURCHASE',
        quantity: 10,
      }),
    ValidationError,
  )
})

test('recordTransaction: rejects a nonexistent locationId', async () => {
  const organizationId = oid()
  const variant = await createRealVariant(organizationId)
  await assert.rejects(
    () =>
      recordTransaction(organizationId, {
        variantId: variant._id.toString(),
        locationId: oid().toString(),
        type: 'PURCHASE',
        quantity: 10,
      }),
    ValidationError,
  )
})

test('recordTransaction: rejects an ARCHIVED location', async () => {
  const organizationId = oid()
  const variant = await createRealVariant(organizationId)
  const location = await createRealLocation(organizationId, 'ARCHIVED')
  await assert.rejects(
    () =>
      recordTransaction(organizationId, {
        variantId: variant._id.toString(),
        locationId: location._id.toString(),
        type: 'PURCHASE',
        quantity: 10,
      }),
    ValidationError,
  )
})

test('recordTransaction: a malformed variantId/locationId is rejected before any DB lookup', async () => {
  const organizationId = oid()
  await assert.rejects(
    () =>
      recordTransaction(organizationId, {
        variantId: 'not-an-object-id',
        locationId: oid().toString(),
        type: 'PURCHASE',
        quantity: 10,
      }),
    ZodError,
  )
})

// ---------------------------------------------------------------------------
// recordTransaction: quantity and direction rules
// ---------------------------------------------------------------------------

test('recordTransaction: TRANSFER_IN and TRANSFER_OUT are rejected as direct input', async () => {
  const organizationId = oid()
  const variant = await createRealVariant(organizationId)
  const location = await createRealLocation(organizationId)
  for (const type of ['TRANSFER_IN', 'TRANSFER_OUT']) {
    await assert.rejects(
      () =>
        recordTransaction(organizationId, {
          variantId: variant._id.toString(),
          locationId: location._id.toString(),
          type,
          quantity: 10,
        }),
      ZodError,
    )
  }
})

test('recordTransaction: quantity rejects zero, negative, fractional, NaN, Infinity, -Infinity, strings, null, arrays, objects', async () => {
  const organizationId = oid()
  const variant = await createRealVariant(organizationId)
  const location = await createRealLocation(organizationId)
  const badValues: unknown[] = [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    '10',
    null,
    [10],
    { amount: 10 },
  ]
  for (const quantity of badValues) {
    await assert.rejects(
      () =>
        recordTransaction(organizationId, {
          variantId: variant._id.toString(),
          locationId: location._id.toString(),
          type: 'PURCHASE',
          quantity,
        }),
      ZodError,
    )
  }
})

test('recordTransaction: ADJUSTMENT requires adjustmentDirection', async () => {
  const organizationId = oid()
  const variant = await createRealVariant(organizationId)
  const location = await createRealLocation(organizationId)
  await assert.rejects(
    () =>
      recordTransaction(organizationId, {
        variantId: variant._id.toString(),
        locationId: location._id.toString(),
        type: 'ADJUSTMENT',
        quantity: 5,
      }),
    ZodError,
  )
})

test('recordTransaction: adjustmentDirection is rejected on every non-ADJUSTMENT type', async () => {
  const organizationId = oid()
  const variant = await createRealVariant(organizationId)
  const location = await createRealLocation(organizationId)
  for (const type of ['PURCHASE', 'SALE', 'RETURN', 'DAMAGE', 'OPENING_BALANCE']) {
    await assert.rejects(
      () =>
        recordTransaction(organizationId, {
          variantId: variant._id.toString(),
          locationId: location._id.toString(),
          type,
          quantity: 5,
          adjustmentDirection: 'INCREASE',
        }),
      ZodError,
    )
  }
})

test('recordTransaction: direction mapping is correct for every type', async () => {
  const organizationId = oid()
  const variant = await createRealVariant(organizationId)
  const location = await createRealLocation(organizationId)

  await recordTransaction(organizationId, {
    variantId: variant._id.toString(),
    locationId: location._id.toString(),
    type: 'OPENING_BALANCE',
    quantity: 100,
  })
  let balance = await getBalance(organizationId, location._id, variant._id)
  assert.equal(balance?.quantityOnHand, 100)

  await recordTransaction(organizationId, {
    variantId: variant._id.toString(),
    locationId: location._id.toString(),
    type: 'PURCHASE',
    quantity: 10,
  })
  await recordTransaction(organizationId, {
    variantId: variant._id.toString(),
    locationId: location._id.toString(),
    type: 'RETURN',
    quantity: 5,
  })
  balance = await getBalance(organizationId, location._id, variant._id)
  assert.equal(balance?.quantityOnHand, 115)

  await recordTransaction(organizationId, {
    variantId: variant._id.toString(),
    locationId: location._id.toString(),
    type: 'SALE',
    quantity: 20,
  })
  await recordTransaction(organizationId, {
    variantId: variant._id.toString(),
    locationId: location._id.toString(),
    type: 'DAMAGE',
    quantity: 5,
  })
  balance = await getBalance(organizationId, location._id, variant._id)
  assert.equal(balance?.quantityOnHand, 90)

  await recordTransaction(organizationId, {
    variantId: variant._id.toString(),
    locationId: location._id.toString(),
    type: 'ADJUSTMENT',
    quantity: 10,
    adjustmentDirection: 'INCREASE',
  })
  balance = await getBalance(organizationId, location._id, variant._id)
  assert.equal(balance?.quantityOnHand, 100)

  await recordTransaction(organizationId, {
    variantId: variant._id.toString(),
    locationId: location._id.toString(),
    type: 'ADJUSTMENT',
    quantity: 30,
    adjustmentDirection: 'DECREASE',
  })
  balance = await getBalance(organizationId, location._id, variant._id)
  assert.equal(balance?.quantityOnHand, 70)
})

// ---------------------------------------------------------------------------
// recordTransaction: negative-stock protection and rollback
// ---------------------------------------------------------------------------

test('recordTransaction: rejects a SALE that would drive the balance negative, and rolls back completely', async () => {
  const organizationId = oid()
  const variant = await createRealVariant(organizationId)
  const location = await createRealLocation(organizationId)

  await recordTransaction(organizationId, {
    variantId: variant._id.toString(),
    locationId: location._id.toString(),
    type: 'PURCHASE',
    quantity: 5,
  })

  await assert.rejects(
    () =>
      recordTransaction(organizationId, {
        variantId: variant._id.toString(),
        locationId: location._id.toString(),
        type: 'SALE',
        quantity: 10,
      }),
    ValidationError,
  )

  const balance = await getBalance(organizationId, location._id, variant._id)
  assert.equal(balance?.quantityOnHand, 5, 'balance must be unchanged after the rejected SALE')

  const txCount = await InventoryTransactionModel.countDocuments({ organizationId, type: 'SALE' })
  assert.equal(txCount, 0, 'no SALE ledger entry may exist for a rejected transaction')
})

test('recordTransaction: a SALE against a variant/location with no existing balance is rejected (implicit zero stock)', async () => {
  const organizationId = oid()
  const variant = await createRealVariant(organizationId)
  const location = await createRealLocation(organizationId)
  await assert.rejects(
    () =>
      recordTransaction(organizationId, {
        variantId: variant._id.toString(),
        locationId: location._id.toString(),
        type: 'SALE',
        quantity: 1,
      }),
    ValidationError,
  )
})

// ---------------------------------------------------------------------------
// recordTransaction: mass assignment / Mongo operator injection
// ---------------------------------------------------------------------------

test('recordTransaction: strict validation rejects unknown fields, including organizationId/_id/createdAt injection attempts', async () => {
  const organizationId = oid()
  const variant = await createRealVariant(organizationId)
  const location = await createRealLocation(organizationId)
  const forbiddenFields = {
    organizationId: oid().toString(),
    _id: oid().toString(),
    createdAt: new Date('2000-01-01'),
  }
  for (const [field, value] of Object.entries(forbiddenFields)) {
    await assert.rejects(
      () =>
        recordTransaction(organizationId, {
          variantId: variant._id.toString(),
          locationId: location._id.toString(),
          type: 'PURCHASE',
          quantity: 10,
          [field]: value,
        }),
      ZodError,
    )
  }
})

test('recordTransaction: Mongo-operator-shaped objects are rejected for variantId, locationId, and type', async () => {
  const organizationId = oid()
  const variant = await createRealVariant(organizationId)
  const location = await createRealLocation(organizationId)
  const operatorPayload = { $gt: '' }

  await assert.rejects(
    () =>
      recordTransaction(organizationId, {
        variantId: operatorPayload,
        locationId: location._id.toString(),
        type: 'PURCHASE',
        quantity: 10,
      }),
    ZodError,
  )
  await assert.rejects(
    () =>
      recordTransaction(organizationId, {
        variantId: variant._id.toString(),
        locationId: operatorPayload,
        type: 'PURCHASE',
        quantity: 10,
      }),
    ZodError,
  )
  await assert.rejects(
    () =>
      recordTransaction(organizationId, {
        variantId: variant._id.toString(),
        locationId: location._id.toString(),
        type: operatorPayload,
        quantity: 10,
      }),
    ZodError,
  )
})

// ---------------------------------------------------------------------------
// recordTransfer
// ---------------------------------------------------------------------------

test('recordTransfer: success case moves stock and creates matching ledger entries', async () => {
  const organizationId = oid()
  const variant = await createRealVariant(organizationId)
  const locationA = await createRealLocation(organizationId)
  const locationB = await createRealLocation(organizationId)

  await recordTransaction(organizationId, {
    variantId: variant._id.toString(),
    locationId: locationA._id.toString(),
    type: 'OPENING_BALANCE',
    quantity: 100,
  })
  await recordTransaction(organizationId, {
    variantId: variant._id.toString(),
    locationId: locationB._id.toString(),
    type: 'OPENING_BALANCE',
    quantity: 20,
  })

  const result = await recordTransfer(organizationId, {
    variantId: variant._id.toString(),
    fromLocationId: locationA._id.toString(),
    toLocationId: locationB._id.toString(),
    quantity: 30,
  })

  assert.equal(result.transferOut.type, 'TRANSFER_OUT')
  assert.equal(result.transferIn.type, 'TRANSFER_IN')
  assert.equal(result.transferOut.quantity, 30)
  assert.equal(result.transferIn.quantity, 30)

  const balanceA = await getBalance(organizationId, locationA._id, variant._id)
  const balanceB = await getBalance(organizationId, locationB._id, variant._id)
  assert.equal(balanceA?.quantityOnHand, 70)
  assert.equal(balanceB?.quantityOnHand, 50)

  const outCount = await InventoryTransactionModel.countDocuments({
    organizationId,
    type: 'TRANSFER_OUT',
  })
  const inCount = await InventoryTransactionModel.countDocuments({
    organizationId,
    type: 'TRANSFER_IN',
  })
  assert.equal(outCount, 1)
  assert.equal(inCount, 1)
})

test('recordTransfer: insufficient stock rolls back completely (no partial balance change, no ledger entries)', async () => {
  const organizationId = oid()
  const variant = await createRealVariant(organizationId)
  const locationA = await createRealLocation(organizationId)
  const locationB = await createRealLocation(organizationId)

  await recordTransaction(organizationId, {
    variantId: variant._id.toString(),
    locationId: locationA._id.toString(),
    type: 'OPENING_BALANCE',
    quantity: 10,
  })
  await recordTransaction(organizationId, {
    variantId: variant._id.toString(),
    locationId: locationB._id.toString(),
    type: 'OPENING_BALANCE',
    quantity: 20,
  })

  await assert.rejects(
    () =>
      recordTransfer(organizationId, {
        variantId: variant._id.toString(),
        fromLocationId: locationA._id.toString(),
        toLocationId: locationB._id.toString(),
        quantity: 20,
      }),
    ValidationError,
  )

  const balanceA = await getBalance(organizationId, locationA._id, variant._id)
  const balanceB = await getBalance(organizationId, locationB._id, variant._id)
  assert.equal(balanceA?.quantityOnHand, 10, 'source balance must be unchanged')
  assert.equal(balanceB?.quantityOnHand, 20, 'destination balance must be unchanged')

  const outCount = await InventoryTransactionModel.countDocuments({
    organizationId,
    type: 'TRANSFER_OUT',
  })
  const inCount = await InventoryTransactionModel.countDocuments({
    organizationId,
    type: 'TRANSFER_IN',
  })
  assert.equal(outCount, 0, 'no TRANSFER_OUT entry may exist for a rejected transfer')
  assert.equal(inCount, 0, 'no TRANSFER_IN entry may exist for a rejected transfer')
})

test('recordTransfer: rejects when source and destination locations are the same', async () => {
  const organizationId = oid()
  const variant = await createRealVariant(organizationId)
  const location = await createRealLocation(organizationId)
  await assert.rejects(
    () =>
      recordTransfer(organizationId, {
        variantId: variant._id.toString(),
        fromLocationId: location._id.toString(),
        toLocationId: location._id.toString(),
        quantity: 5,
      }),
    ValidationError,
  )
})

test('recordTransfer: rejects a cross-organization or archived variant/location', async () => {
  const organizationId = oid()
  const otherOrganizationId = oid()
  const variant = await createRealVariant(organizationId)
  const archivedVariant = await createRealVariant(organizationId, 'ARCHIVED')
  const locationA = await createRealLocation(organizationId)
  const locationB = await createRealLocation(organizationId)
  const archivedLocation = await createRealLocation(organizationId, 'ARCHIVED')
  const otherOrgLocation = await createRealLocation(otherOrganizationId)

  await assert.rejects(
    () =>
      recordTransfer(organizationId, {
        variantId: archivedVariant._id.toString(),
        fromLocationId: locationA._id.toString(),
        toLocationId: locationB._id.toString(),
        quantity: 5,
      }),
    ValidationError,
  )
  await assert.rejects(
    () =>
      recordTransfer(organizationId, {
        variantId: variant._id.toString(),
        fromLocationId: archivedLocation._id.toString(),
        toLocationId: locationB._id.toString(),
        quantity: 5,
      }),
    ValidationError,
  )
  await assert.rejects(
    () =>
      recordTransfer(organizationId, {
        variantId: variant._id.toString(),
        fromLocationId: locationA._id.toString(),
        toLocationId: otherOrgLocation._id.toString(),
        quantity: 5,
      }),
    ValidationError,
  )
})

// ---------------------------------------------------------------------------
// Concurrency (mandatory scenarios)
// ---------------------------------------------------------------------------

test('CONCURRENCY (initial balance): two concurrent PURCHASE transactions with no existing balance both succeed, exactly one balance document, correct total, no lost update', async () => {
  const organizationId = oid()
  const variant = await createRealVariant(organizationId)
  const location = await createRealLocation(organizationId)

  const [resultA, resultB] = await Promise.all([
    recordTransaction(organizationId, {
      variantId: variant._id.toString(),
      locationId: location._id.toString(),
      type: 'PURCHASE',
      quantity: 10,
    }),
    recordTransaction(organizationId, {
      variantId: variant._id.toString(),
      locationId: location._id.toString(),
      type: 'PURCHASE',
      quantity: 20,
    }),
  ])

  assert.ok(resultA)
  assert.ok(resultB)

  const balanceDocs = await StockBalanceModel.find({
    organizationId,
    locationId: location._id,
    variantId: variant._id,
  })
  assert.equal(balanceDocs.length, 1, 'exactly one StockBalance document must exist')
  assert.equal(balanceDocs[0]?.quantityOnHand, 30)

  const txCount = await InventoryTransactionModel.countDocuments({
    organizationId,
    type: 'PURCHASE',
  })
  assert.equal(txCount, 2, 'both PURCHASE ledger entries must exist')
})

test('CONCURRENCY (outbound): initial balance 10, two concurrent SALE 6 — exactly one succeeds, final balance 4, exactly one SALE ledger entry, never negative', async () => {
  const organizationId = oid()
  const variant = await createRealVariant(organizationId)
  const location = await createRealLocation(organizationId)

  await recordTransaction(organizationId, {
    variantId: variant._id.toString(),
    locationId: location._id.toString(),
    type: 'OPENING_BALANCE',
    quantity: 10,
  })

  const results = await Promise.allSettled([
    recordTransaction(organizationId, {
      variantId: variant._id.toString(),
      locationId: location._id.toString(),
      type: 'SALE',
      quantity: 6,
    }),
    recordTransaction(organizationId, {
      variantId: variant._id.toString(),
      locationId: location._id.toString(),
      type: 'SALE',
      quantity: 6,
    }),
  ])

  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  const rejected = results.filter((r) => r.status === 'rejected')
  assert.equal(fulfilled.length, 1, 'exactly one SALE should succeed')
  assert.equal(rejected.length, 1, 'exactly one SALE should fail')

  const balance = await getBalance(organizationId, location._id, variant._id)
  assert.equal(balance?.quantityOnHand, 4)
  assert.ok((balance?.quantityOnHand ?? -1) >= 0, 'balance must never go negative')

  const saleCount = await InventoryTransactionModel.countDocuments({ organizationId, type: 'SALE' })
  assert.equal(saleCount, 1, 'exactly one successful SALE ledger entry must exist')
})

// ---------------------------------------------------------------------------
// getBalance / listTransactions
// ---------------------------------------------------------------------------

test('getBalance returns null when no balance exists yet', async () => {
  const organizationId = oid()
  const result = await getBalance(organizationId, oid(), oid())
  assert.equal(result, null)
})

test('listTransactions only returns transactions belonging to the caller organization', async () => {
  const organizationId = oid()
  const otherOrganizationId = oid()
  const variant = await createRealVariant(organizationId)
  const location = await createRealLocation(organizationId)
  const otherVariant = await createRealVariant(otherOrganizationId)
  const otherLocation = await createRealLocation(otherOrganizationId)

  await recordTransaction(organizationId, {
    variantId: variant._id.toString(),
    locationId: location._id.toString(),
    type: 'PURCHASE',
    quantity: 10,
  })
  await recordTransaction(otherOrganizationId, {
    variantId: otherVariant._id.toString(),
    locationId: otherLocation._id.toString(),
    type: 'PURCHASE',
    quantity: 10,
  })

  const result = await listTransactions(organizationId, {}, { page: 1, limit: 20 })
  assert.equal(result.items.length, 1)
})
