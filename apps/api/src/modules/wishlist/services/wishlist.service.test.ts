import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { ZodError } from 'zod'
import { WishlistItemModel } from '../models/wishlist-item.model.js'
import { OrganizationModel } from '../../organizations/models/organization.model.js'
import { CustomerModel } from '../../customers/models/customer.model.js'
import { ProductModel } from '../../catalog/models/product.model.js'
import { ProductVariantModel } from '../../catalog/models/product-variant.model.js'
import * as organizationRepository from '../../organizations/repositories/organization.repository.js'
import * as customerRepository from '../../customers/repositories/customer.repository.js'
import * as productRepository from '../../catalog/repositories/product.repository.js'
import * as productVariantRepository from '../../catalog/repositories/product-variant.repository.js'
import { createWishlistItem, listWishlistItems, archiveWishlistItem } from './wishlist.service.js'
import { NotFoundError, ValidationError } from '../../../lib/http-errors.js'

let mongod: MongoMemoryServer

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'com_001_wishlist_service_test' })
  await Promise.all([
    WishlistItemModel.init(),
    OrganizationModel.init(),
    CustomerModel.init(),
    ProductModel.init(),
    ProductVariantModel.init(),
  ])
})

after(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await Promise.all([
    WishlistItemModel.deleteMany({}),
    OrganizationModel.deleteMany({}),
    CustomerModel.deleteMany({}),
    ProductModel.deleteMany({}),
    ProductVariantModel.deleteMany({}),
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

// ---------------------------------------------------------------------------
// Create / validation
// ---------------------------------------------------------------------------

test('creates a valid wishlist item', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)

  const item = await createWishlistItem(customer._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
  })
  assert.equal(item.status, 'ACTIVE')
  assert.equal(item.customerId.toString(), customer._id.toString())
  assert.equal(item.organizationId.toString(), organization._id.toString())
  assert.equal(item.variantId.toString(), variant._id.toString())
})

test('strict validation rejects unknown fields', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  await assert.rejects(
    () =>
      createWishlistItem(customer._id, {
        organizationId: organization._id.toString(),
        variantId: variant._id.toString(),
        status: 'ARCHIVED',
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
    status: 'ARCHIVED',
    createdAt: new Date('2000-01-01'),
    updatedAt: new Date('2000-01-01'),
  }
  for (const [field, value] of Object.entries(forbiddenFields)) {
    await assert.rejects(
      () =>
        createWishlistItem(customer._id, {
          organizationId: organization._id.toString(),
          variantId: variant._id.toString(),
          [field]: value,
        }),
      ZodError,
    )
  }
})

test('an invalid ObjectId is rejected before any DB lookup', async () => {
  const customer = await createRealCustomer()
  await assert.rejects(
    () =>
      createWishlistItem(customer._id, {
        organizationId: 'not-an-object-id',
        variantId: oid().toString(),
      }),
    ZodError,
  )
})

test('Mongo-operator-shaped payloads are rejected for organizationId/variantId', async () => {
  const customer = await createRealCustomer()
  const operatorPayload = { $gt: '' }
  await assert.rejects(
    () =>
      createWishlistItem(customer._id, {
        organizationId: operatorPayload,
        variantId: oid().toString(),
      }),
    ZodError,
  )
  await assert.rejects(
    () =>
      createWishlistItem(customer._id, {
        organizationId: oid().toString(),
        variantId: operatorPayload,
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
      createWishlistItem(customer._id, {
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
      createWishlistItem(customer._id, {
        organizationId: organization._id.toString(),
        variantId: oid().toString(),
      }),
    ValidationError,
  )
})

test('rejects a nonexistent variantId', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  await assert.rejects(
    () =>
      createWishlistItem(customer._id, {
        organizationId: organization._id.toString(),
        variantId: oid().toString(),
      }),
    ValidationError,
  )
})

test('rejects a variant belonging to a different organization (cross-org rejection)', async () => {
  const customer = await createRealCustomer()
  const organizationA = await createRealOrganization()
  const organizationB = await createRealOrganization()
  const variant = await createRealVariant(organizationB._id)
  await assert.rejects(
    () =>
      createWishlistItem(customer._id, {
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
      createWishlistItem(customer._id, {
        organizationId: organization._id.toString(),
        variantId: variant._id.toString(),
      }),
    ValidationError,
  )
})

test('an existing item is preserved (not cascaded) after its variant is later archived', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  const item = await createWishlistItem(customer._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
  })

  await productVariantRepository.update(organization._id, variant._id, { status: 'ARCHIVED' })

  const stillThere = await WishlistItemModel.findById(item._id)
  assert.equal(stillThere?.status, 'ACTIVE')
  assert.equal(stillThere?.variantId.toString(), variant._id.toString())
})

// ---------------------------------------------------------------------------
// Archived customer write-blocking
// ---------------------------------------------------------------------------

test('an archived customer cannot create a wishlist item', async () => {
  const customer = await createRealCustomer('ARCHIVED')
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  await assert.rejects(
    () =>
      createWishlistItem(customer._id, {
        organizationId: organization._id.toString(),
        variantId: variant._id.toString(),
      }),
    ValidationError,
  )
})

test('an archived customer cannot archive/remove a wishlist item', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  const item = await createWishlistItem(customer._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
  })
  await customerRepository.archive(customer._id)

  await assert.rejects(() => archiveWishlistItem(customer._id, item._id), ValidationError)
})

// ---------------------------------------------------------------------------
// List / cross-customer IDOR
// ---------------------------------------------------------------------------

test("listWishlistItems only returns the caller's own items", async () => {
  const customerA = await createRealCustomer()
  const customerB = await createRealCustomer()
  const organization = await createRealOrganization()
  const variantA = await createRealVariant(organization._id)
  const variantB = await createRealVariant(organization._id)

  await createWishlistItem(customerA._id, {
    organizationId: organization._id.toString(),
    variantId: variantA._id.toString(),
  })
  await createWishlistItem(customerB._id, {
    organizationId: organization._id.toString(),
    variantId: variantB._id.toString(),
  })

  const results = await listWishlistItems(customerA._id)
  assert.equal(results.length, 1)
  assert.equal(results[0]?.variantId.toString(), variantA._id.toString())
})

test("a different customer cannot archive another customer's wishlist item (cross-customer IDOR)", async () => {
  const customerA = await createRealCustomer()
  const customerB = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  const item = await createWishlistItem(customerA._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
  })

  await assert.rejects(() => archiveWishlistItem(customerB._id, item._id), NotFoundError)

  const stillActive = await listWishlistItems(customerA._id)
  assert.equal(stillActive.length, 1)
})

test('archiving a nonexistent item throws NotFoundError', async () => {
  const customer = await createRealCustomer()
  await assert.rejects(() => archiveWishlistItem(customer._id, oid()), NotFoundError)
})

// ---------------------------------------------------------------------------
// Lifecycle: archive then re-add the same variant
// ---------------------------------------------------------------------------

test('archive then re-add the same variant succeeds', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)

  const first = await createWishlistItem(customer._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
  })
  await archiveWishlistItem(customer._id, first._id)

  const second = await createWishlistItem(customer._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
  })
  assert.equal(second.status, 'ACTIVE')

  const activeList = await listWishlistItems(customer._id)
  assert.equal(activeList.length, 1)
  assert.equal(activeList[0]?._id.toString(), second._id.toString())
})

test('creating a duplicate ACTIVE item for the same variant is rejected', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  await createWishlistItem(customer._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
  })
  await assert.rejects(
    () =>
      createWishlistItem(customer._id, {
        organizationId: organization._id.toString(),
        variantId: variant._id.toString(),
      }),
    ValidationError,
  )
})
