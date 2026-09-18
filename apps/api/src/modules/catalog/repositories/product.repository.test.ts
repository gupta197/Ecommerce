import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { ProductModel } from '../models/product.model.js'
import * as productRepository from './product.repository.js'
import { ValidationError } from '../../../lib/http-errors.js'

let mongod: MongoMemoryServer

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'cat_003_product_repo_test' })
  await ProductModel.init()
})

after(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await ProductModel.deleteMany({})
})

function oid(): Types.ObjectId {
  return new Types.ObjectId()
}

test('creates a product', async () => {
  const organizationId = oid()
  const product = await productRepository.create({
    organizationId,
    name: 'Blue Widget',
    slug: 'blue-widget',
    status: 'ACTIVE',
  })
  assert.equal(product.name, 'Blue Widget')
  assert.equal(product.status, 'ACTIVE')
  assert.equal(product.categoryId, undefined)
  assert.equal(product.brandId, undefined)
})

test('creates a product with categoryId, brandId, and media', async () => {
  const organizationId = oid()
  const categoryId = oid()
  const brandId = oid()
  const product = await productRepository.create({
    organizationId,
    name: 'Full Widget',
    slug: 'full-widget',
    categoryId,
    brandId,
    media: [{ url: 'https://example.com/a.jpg', altText: 'A' }],
    status: 'DRAFT',
  })
  assert.equal(product.categoryId?.toString(), categoryId.toString())
  assert.equal(product.brandId?.toString(), brandId.toString())
  assert.equal(product.media?.length, 1)
  assert.equal(product.media?.[0]?.url, 'https://example.com/a.jpg')
})

test('rejects more than 10 media items at the model level', async () => {
  const organizationId = oid()
  const media = Array.from({ length: 11 }, (_, i) => ({ url: `https://example.com/${i}.jpg` }))
  await assert.rejects(() =>
    productRepository.create({
      organizationId,
      name: 'Too Many Images',
      slug: 'too-many-images',
      media,
      status: 'DRAFT',
    }),
  )
})

test('organizations are isolated: findById scopes by organizationId', async () => {
  const orgA = oid()
  const orgB = oid()
  const product = await productRepository.create({
    organizationId: orgA,
    name: 'Org A Product',
    slug: 'org-a-product',
    status: 'ACTIVE',
  })
  const foundByOwner = await productRepository.findById(orgA, product._id)
  const foundByOther = await productRepository.findById(orgB, product._id)
  assert.ok(foundByOwner)
  assert.equal(foundByOther, null)
})

test('findBySlug does not return a product belonging to a different organization', async () => {
  const orgA = oid()
  const orgB = oid()
  await productRepository.create({
    organizationId: orgA,
    name: 'Scoped Product',
    slug: 'scoped-product',
    status: 'ACTIVE',
  })
  const foundByOwner = await productRepository.findBySlug(orgA, 'scoped-product')
  const foundByOther = await productRepository.findBySlug(orgB, 'scoped-product')
  assert.ok(foundByOwner)
  assert.equal(foundByOther, null)
})

test('list only returns products belonging to the caller organization', async () => {
  const orgA = oid()
  const orgB = oid()
  await productRepository.create({
    organizationId: orgA,
    name: 'A1',
    slug: 'a1',
    status: 'ACTIVE',
  })
  await productRepository.create({
    organizationId: orgB,
    name: 'B1',
    slug: 'b1',
    status: 'ACTIVE',
  })
  const result = await productRepository.list(orgA, {}, { page: 1, limit: 20 })
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0]?.name, 'A1')
})

test('list filters by categoryId', async () => {
  const organizationId = oid()
  const categoryA = oid()
  const categoryB = oid()
  await productRepository.create({
    organizationId,
    name: 'In Category A',
    slug: 'in-category-a',
    categoryId: categoryA,
    status: 'ACTIVE',
  })
  await productRepository.create({
    organizationId,
    name: 'In Category B',
    slug: 'in-category-b',
    categoryId: categoryB,
    status: 'ACTIVE',
  })
  const result = await productRepository.list(
    organizationId,
    { categoryId: categoryA },
    { page: 1, limit: 20 },
  )
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0]?.name, 'In Category A')
})

test('list filters by brandId', async () => {
  const organizationId = oid()
  const brandA = oid()
  await productRepository.create({
    organizationId,
    name: 'Branded',
    slug: 'branded',
    brandId: brandA,
    status: 'ACTIVE',
  })
  await productRepository.create({
    organizationId,
    name: 'Unbranded',
    slug: 'unbranded',
    status: 'ACTIVE',
  })
  const result = await productRepository.list(
    organizationId,
    { brandId: brandA },
    { page: 1, limit: 20 },
  )
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0]?.name, 'Branded')
})

test('the organizationId+slug unique index rejects a duplicate at the database level', async () => {
  const organizationId = oid()
  await productRepository.create({
    organizationId,
    name: 'First',
    slug: 'dup-slug',
    status: 'ACTIVE',
  })
  await assert.rejects(
    () =>
      productRepository.create({
        organizationId,
        name: 'Second',
        slug: 'dup-slug',
        status: 'ACTIVE',
      }),
    ValidationError,
  )
})

test('the same slug is allowed across two different organizations', async () => {
  const orgA = oid()
  const orgB = oid()
  await productRepository.create({
    organizationId: orgA,
    name: 'A',
    slug: 'shared-slug',
    status: 'ACTIVE',
  })
  await assert.doesNotReject(() =>
    productRepository.create({
      organizationId: orgB,
      name: 'B',
      slug: 'shared-slug',
      status: 'ACTIVE',
    }),
  )
})

test('concurrent creates with the same slug: exactly one succeeds, the database index rejects the other', async () => {
  const organizationId = oid()
  const attempt = () =>
    productRepository.create({
      organizationId,
      name: 'Race',
      slug: 'race-slug',
      status: 'ACTIVE',
    })

  const results = await Promise.allSettled([attempt(), attempt()])
  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  const rejected = results.filter((r) => r.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof ValidationError)
})

test('update cannot set organizationId (not part of UpdateProductData)', async () => {
  const organizationId = oid()
  const product = await productRepository.create({
    organizationId,
    name: 'Immutable Org',
    slug: 'immutable-org',
    status: 'ACTIVE',
  })
  const updated = await productRepository.update(organizationId, product._id, { name: 'Renamed' })
  assert.equal(updated?.organizationId.toString(), organizationId.toString())
})

test('update can remove categoryId/brandId via explicit null', async () => {
  const organizationId = oid()
  const categoryId = oid()
  const brandId = oid()
  const product = await productRepository.create({
    organizationId,
    name: 'Referenced',
    slug: 'referenced',
    categoryId,
    brandId,
    status: 'ACTIVE',
  })
  const updated = await productRepository.update(organizationId, product._id, {
    categoryId: null,
    brandId: null,
  })
  assert.equal(updated?.categoryId, null)
  assert.equal(updated?.brandId, null)
})

test('cross-organization update does not affect the product', async () => {
  const orgA = oid()
  const orgB = oid()
  const product = await productRepository.create({
    organizationId: orgA,
    name: 'Protected',
    slug: 'protected',
    status: 'ACTIVE',
  })
  const result = await productRepository.update(orgB, product._id, { name: 'Hijacked' })
  assert.equal(result, null)
  const stillOriginal = await productRepository.findById(orgA, product._id)
  assert.equal(stillOriginal?.name, 'Protected')
})

test('archived products remain directly queryable', async () => {
  const organizationId = oid()
  const product = await productRepository.create({
    organizationId,
    name: 'To Archive',
    slug: 'to-archive',
    status: 'ACTIVE',
  })
  await productRepository.archive(organizationId, product._id)
  const found = await productRepository.findById(organizationId, product._id)
  assert.equal(found?.status, 'ARCHIVED')
})

test('cross-organization archive does not affect the product', async () => {
  const orgA = oid()
  const orgB = oid()
  const product = await productRepository.create({
    organizationId: orgA,
    name: 'Not Yours',
    slug: 'not-yours',
    status: 'ACTIVE',
  })
  const result = await productRepository.archive(orgB, product._id)
  assert.equal(result, null)
  const stillActive = await productRepository.findById(orgA, product._id)
  assert.equal(stillActive?.status, 'ACTIVE')
})

test('toJSON output never includes __v', async () => {
  const organizationId = oid()
  const product = await productRepository.create({
    organizationId,
    name: 'JSON Test',
    slug: 'json-test',
    status: 'ACTIVE',
  })
  const json = product.toJSON() as unknown as Record<string, unknown>
  assert.equal(json.__v, undefined)
})

test('the declared indexes exist on the Product collection, including uniqueness', async () => {
  const indexes = await ProductModel.collection.indexes()

  const slugIndex = indexes.find(
    (idx) => JSON.stringify(idx.key) === JSON.stringify({ organizationId: 1, slug: 1 }),
  )
  assert.ok(slugIndex, 'expected an {organizationId: 1, slug: 1} index')
  assert.equal(slugIndex?.unique, true)

  const categoryIndex = indexes.find(
    (idx) =>
      JSON.stringify(idx.key) === JSON.stringify({ organizationId: 1, categoryId: 1, status: 1 }),
  )
  assert.ok(categoryIndex, 'expected an {organizationId: 1, categoryId: 1, status: 1} index')

  const brandIndex = indexes.find(
    (idx) =>
      JSON.stringify(idx.key) === JSON.stringify({ organizationId: 1, brandId: 1, status: 1 }),
  )
  assert.ok(brandIndex, 'expected an {organizationId: 1, brandId: 1, status: 1} index')
})
