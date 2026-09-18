import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { ProductVariantModel } from '../models/product-variant.model.js'
import * as productVariantRepository from './product-variant.repository.js'
import { ValidationError } from '../../../lib/http-errors.js'

let mongod: MongoMemoryServer

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'cat_004_product_variant_repo_test' })
  await ProductVariantModel.init()
})

after(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await ProductVariantModel.deleteMany({})
})

function oid(): Types.ObjectId {
  return new Types.ObjectId()
}

test('creates a variant', async () => {
  const organizationId = oid()
  const productId = oid()
  const variant = await productVariantRepository.create({
    organizationId,
    productId,
    sku: 'SKU-1',
    price: 1999,
    status: 'ACTIVE',
  })
  assert.equal(variant.sku, 'SKU-1')
  assert.equal(variant.price, 1999)
  assert.equal(variant.status, 'ACTIVE')
  assert.equal(variant.barcode, undefined)
  assert.equal(variant.compareAtPrice, undefined)
  assert.equal(variant.cost, undefined)
})

test('creates a variant with barcode, compareAtPrice, cost, and attributes', async () => {
  const organizationId = oid()
  const productId = oid()
  const variant = await productVariantRepository.create({
    organizationId,
    productId,
    sku: 'SKU-FULL',
    barcode: '012345678905',
    price: 1500,
    compareAtPrice: 2000,
    cost: 900,
    attributes: [{ key: 'Color', value: 'Blue' }],
    status: 'DRAFT',
  })
  assert.equal(variant.barcode, '012345678905')
  assert.equal(variant.compareAtPrice, 2000)
  assert.equal(variant.cost, 900)
  assert.equal(variant.attributes?.length, 1)
  assert.equal(variant.attributes?.[0]?.key, 'Color')
  assert.equal(variant.attributes?.[0]?.value, 'Blue')
})

test('rejects more than 30 attributes at the model level', async () => {
  const organizationId = oid()
  const productId = oid()
  const attributes = Array.from({ length: 31 }, (_, i) => ({ key: `attr-${i}`, value: i }))
  await assert.rejects(() =>
    productVariantRepository.create({
      organizationId,
      productId,
      sku: 'TOO-MANY-ATTRS',
      price: 100,
      attributes,
      status: 'DRAFT',
    }),
  )
})

test('organizations are isolated: findById scopes by organizationId', async () => {
  const orgA = oid()
  const orgB = oid()
  const productId = oid()
  const variant = await productVariantRepository.create({
    organizationId: orgA,
    productId,
    sku: 'ORG-A-SKU',
    price: 100,
    status: 'ACTIVE',
  })
  const foundByOwner = await productVariantRepository.findById(orgA, variant._id)
  const foundByOther = await productVariantRepository.findById(orgB, variant._id)
  assert.ok(foundByOwner)
  assert.equal(foundByOther, null)
})

test('findBySku does not return a variant belonging to a different organization', async () => {
  const orgA = oid()
  const orgB = oid()
  const productId = oid()
  await productVariantRepository.create({
    organizationId: orgA,
    productId,
    sku: 'SCOPED-SKU',
    price: 100,
    status: 'ACTIVE',
  })
  const foundByOwner = await productVariantRepository.findBySku(orgA, 'SCOPED-SKU')
  const foundByOther = await productVariantRepository.findBySku(orgB, 'SCOPED-SKU')
  assert.ok(foundByOwner)
  assert.equal(foundByOther, null)
})

test('findByProductId returns only variants of that product, scoped by organization', async () => {
  const organizationId = oid()
  const productA = oid()
  const productB = oid()
  await productVariantRepository.create({
    organizationId,
    productId: productA,
    sku: 'PA-1',
    price: 100,
    status: 'ACTIVE',
  })
  await productVariantRepository.create({
    organizationId,
    productId: productB,
    sku: 'PB-1',
    price: 100,
    status: 'ACTIVE',
  })
  const results = await productVariantRepository.findByProductId(organizationId, productA)
  assert.equal(results.length, 1)
  assert.equal(results[0]?.sku, 'PA-1')
})

test('list only returns variants belonging to the caller organization', async () => {
  const orgA = oid()
  const orgB = oid()
  const productId = oid()
  await productVariantRepository.create({
    organizationId: orgA,
    productId,
    sku: 'A1',
    price: 100,
    status: 'ACTIVE',
  })
  await productVariantRepository.create({
    organizationId: orgB,
    productId,
    sku: 'B1',
    price: 100,
    status: 'ACTIVE',
  })
  const result = await productVariantRepository.list(orgA, {}, { page: 1, limit: 20 })
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0]?.sku, 'A1')
})

test('list filters by productId and status', async () => {
  const organizationId = oid()
  const productA = oid()
  const productB = oid()
  await productVariantRepository.create({
    organizationId,
    productId: productA,
    sku: 'FILTER-A-ACTIVE',
    price: 100,
    status: 'ACTIVE',
  })
  await productVariantRepository.create({
    organizationId,
    productId: productA,
    sku: 'FILTER-A-DRAFT',
    price: 100,
    status: 'DRAFT',
  })
  await productVariantRepository.create({
    organizationId,
    productId: productB,
    sku: 'FILTER-B-ACTIVE',
    price: 100,
    status: 'ACTIVE',
  })
  const result = await productVariantRepository.list(
    organizationId,
    { productId: productA, status: 'ACTIVE' },
    { page: 1, limit: 20 },
  )
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0]?.sku, 'FILTER-A-ACTIVE')
})

test('the organizationId+sku unique index rejects a duplicate at the database level', async () => {
  const organizationId = oid()
  const productId = oid()
  await productVariantRepository.create({
    organizationId,
    productId,
    sku: 'DUP-SKU',
    price: 100,
    status: 'ACTIVE',
  })
  await assert.rejects(
    () =>
      productVariantRepository.create({
        organizationId,
        productId,
        sku: 'DUP-SKU',
        price: 200,
        status: 'ACTIVE',
      }),
    ValidationError,
  )
})

test('the same SKU is allowed across two different organizations', async () => {
  const orgA = oid()
  const orgB = oid()
  const productId = oid()
  await productVariantRepository.create({
    organizationId: orgA,
    productId,
    sku: 'SHARED-SKU',
    price: 100,
    status: 'ACTIVE',
  })
  await assert.doesNotReject(() =>
    productVariantRepository.create({
      organizationId: orgB,
      productId,
      sku: 'SHARED-SKU',
      price: 100,
      status: 'ACTIVE',
    }),
  )
})

test('concurrent creates with the same SKU: exactly one succeeds, the database index rejects the other', async () => {
  const organizationId = oid()
  const productId = oid()
  const attempt = () =>
    productVariantRepository.create({
      organizationId,
      productId,
      sku: 'RACE-SKU',
      price: 100,
      status: 'ACTIVE',
    })

  const results = await Promise.allSettled([attempt(), attempt()])
  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  const rejected = results.filter((r) => r.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof ValidationError)
})

test('the organizationId+barcode unique index rejects a duplicate at the database level', async () => {
  const organizationId = oid()
  const productId = oid()
  await productVariantRepository.create({
    organizationId,
    productId,
    sku: 'BC-1',
    barcode: '111111111111',
    price: 100,
    status: 'ACTIVE',
  })
  await assert.rejects(
    () =>
      productVariantRepository.create({
        organizationId,
        productId,
        sku: 'BC-2',
        barcode: '111111111111',
        price: 100,
        status: 'ACTIVE',
      }),
    ValidationError,
  )
})

test('two variants with no barcode can coexist (partial unique index)', async () => {
  const organizationId = oid()
  const productId = oid()
  await assert.doesNotReject(async () => {
    await productVariantRepository.create({
      organizationId,
      productId,
      sku: 'NO-BC-1',
      price: 100,
      status: 'ACTIVE',
    })
    await productVariantRepository.create({
      organizationId,
      productId,
      sku: 'NO-BC-2',
      price: 100,
      status: 'ACTIVE',
    })
  })
})

test('update cannot set organizationId or productId (not part of UpdateProductVariantData)', async () => {
  const organizationId = oid()
  const productId = oid()
  const variant = await productVariantRepository.create({
    organizationId,
    productId,
    sku: 'IMMUTABLE-REL',
    price: 100,
    status: 'ACTIVE',
  })
  const updated = await productVariantRepository.update(organizationId, variant._id, {
    price: 150,
  })
  assert.equal(updated?.organizationId.toString(), organizationId.toString())
  assert.equal(updated?.productId.toString(), productId.toString())
  assert.equal(updated?.price, 150)
})

test('cross-organization update does not affect the variant', async () => {
  const orgA = oid()
  const orgB = oid()
  const productId = oid()
  const variant = await productVariantRepository.create({
    organizationId: orgA,
    productId,
    sku: 'PROTECTED-SKU',
    price: 100,
    status: 'ACTIVE',
  })
  const result = await productVariantRepository.update(orgB, variant._id, { price: 999 })
  assert.equal(result, null)
  const stillOriginal = await productVariantRepository.findById(orgA, variant._id)
  assert.equal(stillOriginal?.price, 100)
})

test('archived variants remain directly queryable', async () => {
  const organizationId = oid()
  const productId = oid()
  const variant = await productVariantRepository.create({
    organizationId,
    productId,
    sku: 'TO-ARCHIVE',
    price: 100,
    status: 'ACTIVE',
  })
  await productVariantRepository.archive(organizationId, variant._id)
  const found = await productVariantRepository.findById(organizationId, variant._id)
  assert.equal(found?.status, 'ARCHIVED')
})

test('cross-organization archive does not affect the variant', async () => {
  const orgA = oid()
  const orgB = oid()
  const productId = oid()
  const variant = await productVariantRepository.create({
    organizationId: orgA,
    productId,
    sku: 'NOT-YOURS',
    price: 100,
    status: 'ACTIVE',
  })
  const result = await productVariantRepository.archive(orgB, variant._id)
  assert.equal(result, null)
  const stillActive = await productVariantRepository.findById(orgA, variant._id)
  assert.equal(stillActive?.status, 'ACTIVE')
})

test('toJSON output never includes __v', async () => {
  const organizationId = oid()
  const productId = oid()
  const variant = await productVariantRepository.create({
    organizationId,
    productId,
    sku: 'JSON-TEST',
    price: 100,
    status: 'ACTIVE',
  })
  const json = variant.toJSON() as unknown as Record<string, unknown>
  assert.equal(json.__v, undefined)
})

test('the declared indexes exist on the ProductVariant collection, including uniqueness and the barcode partial filter', async () => {
  const indexes = await ProductVariantModel.collection.indexes()

  const skuIndex = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ organizationId: 1, sku: 1 }),
  )
  assert.ok(skuIndex, 'expected an {organizationId: 1, sku: 1} index')
  assert.equal(skuIndex?.unique, true)

  const barcodeIndex = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ organizationId: 1, barcode: 1 }),
  )
  assert.ok(barcodeIndex, 'expected an {organizationId: 1, barcode: 1} index')
  assert.equal(barcodeIndex?.unique, true)
  assert.deepEqual(barcodeIndex?.partialFilterExpression, { barcode: { $exists: true } })

  const productIndex = indexes.find(
    (idx) =>
      JSON.stringify(idx.key) === JSON.stringify({ organizationId: 1, productId: 1, status: 1 }),
  )
  assert.ok(productIndex, 'expected an {organizationId: 1, productId: 1, status: 1} index')
})
