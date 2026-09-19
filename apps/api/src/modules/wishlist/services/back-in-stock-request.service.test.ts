import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose, { Types, type ClientSession } from 'mongoose'
import { ZodError } from 'zod'
import { BackInStockRequestModel } from '../models/back-in-stock-request.model.js'
import { OrganizationModel } from '../../organizations/models/organization.model.js'
import { CustomerModel } from '../../customers/models/customer.model.js'
import { ProductModel } from '../../catalog/models/product.model.js'
import { ProductVariantModel } from '../../catalog/models/product-variant.model.js'
import { LocationModel } from '../../inventory/models/location.model.js'
import { StockBalanceModel } from '../../inventory/models/stock-balance.model.js'
import * as organizationRepository from '../../organizations/repositories/organization.repository.js'
import * as customerRepository from '../../customers/repositories/customer.repository.js'
import * as productRepository from '../../catalog/repositories/product.repository.js'
import * as productVariantRepository from '../../catalog/repositories/product-variant.repository.js'
import * as locationRepository from '../../inventory/repositories/location.repository.js'
import * as stockBalanceRepository from '../../inventory/repositories/stock-balance.repository.js'
import {
  createBackInStockRequest,
  listBackInStockRequests,
  cancelBackInStockRequest,
} from './back-in-stock-request.service.js'
import { NotFoundError, ValidationError } from '../../../lib/http-errors.js'

let mongod: MongoMemoryServer

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'com_001_back_in_stock_service_test' })
  await Promise.all([
    BackInStockRequestModel.init(),
    OrganizationModel.init(),
    CustomerModel.init(),
    ProductModel.init(),
    ProductVariantModel.init(),
    LocationModel.init(),
    StockBalanceModel.init(),
  ])
})

after(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await Promise.all([
    BackInStockRequestModel.deleteMany({}),
    OrganizationModel.deleteMany({}),
    CustomerModel.deleteMany({}),
    ProductModel.deleteMany({}),
    ProductVariantModel.deleteMany({}),
    LocationModel.deleteMany({}),
    StockBalanceModel.deleteMany({}),
  ])
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

async function createRealCustomer(status: 'ACTIVE' | 'ARCHIVED' = 'ACTIVE') {
  return customerRepository.create({
    userId: oid(),
    firstName: 'Ada',
    lastName: 'Lovelace',
    status,
  })
}

async function createRealOrganization(status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE') {
  return organizationRepository.create({ name: 'Acme Inc', status, activeOwnerCount: 1 })
}

async function createRealVariant(
  organizationId: Types.ObjectId,
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED' = 'ACTIVE',
) {
  const product = await productRepository.create({
    organizationId,
    name: 'Real Product',
    slug: `real-product-${oid().toString()}`,
    status: 'ACTIVE',
  })
  return productVariantRepository.create({
    organizationId,
    productId: product._id,
    sku: `SKU-${oid().toString()}`,
    price: 100,
    status,
  })
}

async function setStock(
  organizationId: Types.ObjectId,
  variantId: Types.ObjectId,
  locationId: Types.ObjectId,
  quantity: number,
) {
  if (quantity <= 0) return
  await withSession((session) =>
    stockBalanceRepository.incrementOrCreate(
      { organizationId, locationId, variantId },
      quantity,
      session,
    ),
  )
}

// ---------------------------------------------------------------------------
// Create / validation
// ---------------------------------------------------------------------------

test('creates a valid request when the variant has zero aggregate stock', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)

  const request = await createBackInStockRequest(customer._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
  })
  assert.equal(request.status, 'PENDING')
})

test('strict validation rejects unknown fields', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  await assert.rejects(
    () =>
      createBackInStockRequest(customer._id, {
        organizationId: organization._id.toString(),
        variantId: variant._id.toString(),
        status: 'PENDING',
      }),
    ZodError,
  )
})

test('rejects attempts to inject customerId/_id/status/createdAt/updatedAt', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  const forbiddenFields = {
    customerId: oid().toString(),
    _id: oid().toString(),
    status: 'PENDING',
    createdAt: new Date('2000-01-01'),
    updatedAt: new Date('2000-01-01'),
  }
  for (const [field, value] of Object.entries(forbiddenFields)) {
    await assert.rejects(
      () =>
        createBackInStockRequest(customer._id, {
          organizationId: organization._id.toString(),
          variantId: variant._id.toString(),
          [field]: value,
        }),
      ZodError,
    )
  }
})

test('Mongo-operator-shaped payloads are rejected', async () => {
  const customer = await createRealCustomer()
  const operatorPayload = { $gt: '' }
  await assert.rejects(
    () =>
      createBackInStockRequest(customer._id, {
        organizationId: operatorPayload,
        variantId: oid().toString(),
      }),
    ZodError,
  )
})

// ---------------------------------------------------------------------------
// Organization / variant reference validation
// ---------------------------------------------------------------------------

test('rejects a nonexistent organizationId', async () => {
  const customer = await createRealCustomer()
  await assert.rejects(
    () =>
      createBackInStockRequest(customer._id, {
        organizationId: oid().toString(),
        variantId: oid().toString(),
      }),
    ValidationError,
  )
})

test('rejects a SUSPENDED organization', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization('SUSPENDED')
  await assert.rejects(
    () =>
      createBackInStockRequest(customer._id, {
        organizationId: organization._id.toString(),
        variantId: oid().toString(),
      }),
    ValidationError,
  )
})

test('rejects a variant belonging to a different organization', async () => {
  const customer = await createRealCustomer()
  const organizationA = await createRealOrganization()
  const organizationB = await createRealOrganization()
  const variant = await createRealVariant(organizationB._id)
  await assert.rejects(
    () =>
      createBackInStockRequest(customer._id, {
        organizationId: organizationA._id.toString(),
        variantId: variant._id.toString(),
      }),
    ValidationError,
  )
})

test('rejects an ARCHIVED variant', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id, 'ARCHIVED')
  await assert.rejects(
    () =>
      createBackInStockRequest(customer._id, {
        organizationId: organization._id.toString(),
        variantId: variant._id.toString(),
      }),
    ValidationError,
  )
})

// ---------------------------------------------------------------------------
// Archived customer write-blocking
// ---------------------------------------------------------------------------

test('an archived customer cannot create a back-in-stock request', async () => {
  const customer = await createRealCustomer('ARCHIVED')
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  await assert.rejects(
    () =>
      createBackInStockRequest(customer._id, {
        organizationId: organization._id.toString(),
        variantId: variant._id.toString(),
      }),
    ValidationError,
  )
})

test('an archived customer cannot cancel a request', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  const request = await createBackInStockRequest(customer._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
  })
  await customerRepository.archive(customer._id)
  await assert.rejects(() => cancelBackInStockRequest(customer._id, request._id), ValidationError)
})

// ---------------------------------------------------------------------------
// Stock semantics — multi-location aggregation
// ---------------------------------------------------------------------------

test('STOCK: both locations at 0 => request allowed', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  const locationA = await locationRepository.create({
    organizationId: organization._id,
    name: 'A',
    status: 'ACTIVE',
  })
  const locationB = await locationRepository.create({
    organizationId: organization._id,
    name: 'B',
    status: 'ACTIVE',
  })
  await setStock(organization._id, variant._id, locationA._id, 0)
  await setStock(organization._id, variant._id, locationB._id, 0)

  await assert.doesNotReject(() =>
    createBackInStockRequest(customer._id, {
      organizationId: organization._id.toString(),
      variantId: variant._id.toString(),
    }),
  )
})

test('STOCK: location A has 5, location B has 0 => request rejected', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  const locationA = await locationRepository.create({
    organizationId: organization._id,
    name: 'A',
    status: 'ACTIVE',
  })
  const locationB = await locationRepository.create({
    organizationId: organization._id,
    name: 'B',
    status: 'ACTIVE',
  })
  await setStock(organization._id, variant._id, locationA._id, 5)
  await setStock(organization._id, variant._id, locationB._id, 0)

  await assert.rejects(
    () =>
      createBackInStockRequest(customer._id, {
        organizationId: organization._id.toString(),
        variantId: variant._id.toString(),
      }),
    ValidationError,
  )
})

test('STOCK: location A has 0, location B has 10 => request rejected', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  const locationA = await locationRepository.create({
    organizationId: organization._id,
    name: 'A',
    status: 'ACTIVE',
  })
  const locationB = await locationRepository.create({
    organizationId: organization._id,
    name: 'B',
    status: 'ACTIVE',
  })
  await setStock(organization._id, variant._id, locationA._id, 0)
  await setStock(organization._id, variant._id, locationB._id, 10)

  await assert.rejects(
    () =>
      createBackInStockRequest(customer._id, {
        organizationId: organization._id.toString(),
        variantId: variant._id.toString(),
      }),
    ValidationError,
  )
})

test('STOCK: no StockBalance document at all (never stocked) => request allowed', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)

  await assert.doesNotReject(() =>
    createBackInStockRequest(customer._id, {
      organizationId: organization._id.toString(),
      variantId: variant._id.toString(),
    }),
  )
})

test('STOCK: does not use INV-001 transaction/write behavior for the check (plain read only)', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  const locationA = await locationRepository.create({
    organizationId: organization._id,
    name: 'A',
    status: 'ACTIVE',
  })
  await setStock(organization._id, variant._id, locationA._id, 3)

  await assert.rejects(
    () =>
      createBackInStockRequest(customer._id, {
        organizationId: organization._id.toString(),
        variantId: variant._id.toString(),
      }),
    ValidationError,
  )

  // The stock balance itself must be completely unaffected by a rejected request.
  const balance = await stockBalanceRepository.findByVariantAndLocation(
    organization._id,
    locationA._id,
    variant._id,
  )
  assert.equal(balance?.quantityOnHand, 3)
})

// ---------------------------------------------------------------------------
// List / cancel / cross-customer IDOR
// ---------------------------------------------------------------------------

test("listBackInStockRequests only returns the caller's own requests", async () => {
  const customerA = await createRealCustomer()
  const customerB = await createRealCustomer()
  const organization = await createRealOrganization()
  const variantA = await createRealVariant(organization._id)
  const variantB = await createRealVariant(organization._id)

  await createBackInStockRequest(customerA._id, {
    organizationId: organization._id.toString(),
    variantId: variantA._id.toString(),
  })
  await createBackInStockRequest(customerB._id, {
    organizationId: organization._id.toString(),
    variantId: variantB._id.toString(),
  })

  const results = await listBackInStockRequests(customerA._id)
  assert.equal(results.length, 1)
})

test("a different customer cannot cancel another customer's request (cross-customer IDOR)", async () => {
  const customerA = await createRealCustomer()
  const customerB = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  const request = await createBackInStockRequest(customerA._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
  })

  await assert.rejects(() => cancelBackInStockRequest(customerB._id, request._id), NotFoundError)

  const stillPending = await listBackInStockRequests(customerA._id)
  assert.equal(stillPending[0]?.status, 'PENDING')
})

test('cancelling a nonexistent request throws NotFoundError', async () => {
  const customer = await createRealCustomer()
  await assert.rejects(() => cancelBackInStockRequest(customer._id, oid()), NotFoundError)
})

// ---------------------------------------------------------------------------
// Lifecycle: cancel then recreate
// ---------------------------------------------------------------------------

test('a cancelled request can be recreated', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)

  const first = await createBackInStockRequest(customer._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
  })
  await cancelBackInStockRequest(customer._id, first._id)

  const second = await createBackInStockRequest(customer._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
  })
  assert.equal(second.status, 'PENDING')

  const all = await listBackInStockRequests(customer._id)
  assert.equal(all.length, 2)
})

test('a duplicate PENDING request for the same variant is rejected', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  await createBackInStockRequest(customer._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
  })
  await assert.rejects(
    () =>
      createBackInStockRequest(customer._id, {
        organizationId: organization._id.toString(),
        variantId: variant._id.toString(),
      }),
    ValidationError,
  )
})
