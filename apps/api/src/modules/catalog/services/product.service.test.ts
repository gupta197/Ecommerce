import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { ZodError } from 'zod'
import { ProductModel } from '../models/product.model.js'
import { CategoryModel } from '../models/category.model.js'
import { BrandModel } from '../models/brand.model.js'
import * as categoryRepository from '../repositories/category.repository.js'
import * as brandRepository from '../repositories/brand.repository.js'
import { createProduct, updateProduct, archiveProduct } from './product.service.js'
import { NotFoundError, ValidationError } from '../../../lib/http-errors.js'

let mongod: MongoMemoryServer

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'cat_003_product_service_test' })
  await Promise.all([ProductModel.init(), CategoryModel.init(), BrandModel.init()])
})

after(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await Promise.all([
    ProductModel.deleteMany({}),
    CategoryModel.deleteMany({}),
    BrandModel.deleteMany({}),
  ])
})

function oid(): Types.ObjectId {
  return new Types.ObjectId()
}

async function createRealCategory(
  organizationId: Types.ObjectId,
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED' = 'ACTIVE',
) {
  return categoryRepository.create({
    organizationId,
    name: 'Real Category',
    slug: `real-category-${new Types.ObjectId().toString()}`,
    status,
    sortOrder: 0,
  })
}

async function createRealBrand(
  organizationId: Types.ObjectId,
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED' = 'ACTIVE',
) {
  return brandRepository.create({
    organizationId,
    name: 'Real Brand',
    slug: `real-brand-${new Types.ObjectId().toString()}`,
    status,
  })
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

test('creates a valid product with an auto-generated slug', async () => {
  const organizationId = oid()
  const product = await createProduct(organizationId, { name: 'Blue Widget' })
  assert.equal(product.name, 'Blue Widget')
  assert.equal(product.slug, 'blue-widget')
  assert.equal(product.status, 'DRAFT')
})

test('creates a product with a valid categoryId and brandId', async () => {
  const organizationId = oid()
  const category = await createRealCategory(organizationId)
  const brand = await createRealBrand(organizationId)

  const product = await createProduct(organizationId, {
    name: 'Referenced Product',
    categoryId: category._id.toString(),
    brandId: brand._id.toString(),
  })

  assert.equal(product.categoryId?.toString(), category._id.toString())
  assert.equal(product.brandId?.toString(), brand._id.toString())
})

test('creates a product without categoryId or brandId (both optional)', async () => {
  const organizationId = oid()
  const product = await createProduct(organizationId, { name: 'Unreferenced' })
  assert.equal(product.categoryId, undefined)
  assert.equal(product.brandId, undefined)
})

test('creating with a categoryId from a different organization is rejected', async () => {
  const organizationId = oid()
  const otherOrganizationId = oid()
  const otherOrgCategory = await createRealCategory(otherOrganizationId)

  await assert.rejects(
    () =>
      createProduct(organizationId, {
        name: 'Cross Org',
        categoryId: otherOrgCategory._id.toString(),
      }),
    ValidationError,
  )
})

test('creating with a brandId from a different organization is rejected', async () => {
  const organizationId = oid()
  const otherOrganizationId = oid()
  const otherOrgBrand = await createRealBrand(otherOrganizationId)

  await assert.rejects(
    () =>
      createProduct(organizationId, {
        name: 'Cross Org Brand',
        brandId: otherOrgBrand._id.toString(),
      }),
    ValidationError,
  )
})

test('creating with a nonexistent categoryId is rejected', async () => {
  const organizationId = oid()
  await assert.rejects(
    () => createProduct(organizationId, { name: 'Ghost Category', categoryId: oid().toString() }),
    ValidationError,
  )
})

test('creating with a nonexistent brandId is rejected', async () => {
  const organizationId = oid()
  await assert.rejects(
    () => createProduct(organizationId, { name: 'Ghost Brand', brandId: oid().toString() }),
    ValidationError,
  )
})

test('creating with an ARCHIVED categoryId is rejected', async () => {
  const organizationId = oid()
  const archivedCategory = await createRealCategory(organizationId, 'ARCHIVED')
  await assert.rejects(
    () =>
      createProduct(organizationId, {
        name: 'Archived Category Product',
        categoryId: archivedCategory._id.toString(),
      }),
    ValidationError,
  )
})

test('creating with an ARCHIVED brandId is rejected', async () => {
  const organizationId = oid()
  const archivedBrand = await createRealBrand(organizationId, 'ARCHIVED')
  await assert.rejects(
    () =>
      createProduct(organizationId, {
        name: 'Archived Brand Product',
        brandId: archivedBrand._id.toString(),
      }),
    ValidationError,
  )
})

test('creating with a malformed categoryId is rejected by validation before any DB lookup', async () => {
  const organizationId = oid()
  await assert.rejects(
    () => createProduct(organizationId, { name: 'Bad Id', categoryId: 'not-an-object-id' }),
    ZodError,
  )
})

test('auto-generated slug gets a numeric suffix on collision', async () => {
  const organizationId = oid()
  await createProduct(organizationId, { name: 'Widget' })
  const second = await createProduct(organizationId, { name: 'Widget' })
  assert.equal(second.slug, 'widget-2')
})

test('an explicitly supplied duplicate slug is rejected, not silently mutated', async () => {
  const organizationId = oid()
  await createProduct(organizationId, { name: 'First', slug: 'taken-slug' })
  await assert.rejects(
    () => createProduct(organizationId, { name: 'Second', slug: 'taken-slug' }),
    ValidationError,
  )
})

test('strict validation rejects unknown fields on create', async () => {
  const organizationId = oid()
  await assert.rejects(
    () =>
      createProduct(organizationId, {
        name: 'Extra Field',
        price: 999,
      }),
    ZodError,
  )
})

test('media is accepted with valid URLs and rejected with malformed URLs', async () => {
  const organizationId = oid()
  const product = await createProduct(organizationId, {
    name: 'Media Product',
    media: [{ url: 'https://example.com/photo.jpg', altText: 'Photo' }],
  })
  assert.equal(product.media?.length, 1)

  await assert.rejects(
    () =>
      createProduct(organizationId, {
        name: 'Bad Media',
        media: [{ url: 'not-a-url' }],
      }),
    ZodError,
  )
})

test('media array is capped at 10 items by validation', async () => {
  const organizationId = oid()
  const media = Array.from({ length: 11 }, (_, i) => ({ url: `https://example.com/${i}.jpg` }))
  await assert.rejects(() => createProduct(organizationId, { name: 'Too Many', media }), ZodError)
})

test('a product can be created with zero media items', async () => {
  const organizationId = oid()
  const product = await createProduct(organizationId, { name: 'No Media' })
  assert.equal(product.media, undefined)
})

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

test('a valid category/brand update succeeds', async () => {
  const organizationId = oid()
  const product = await createProduct(organizationId, { name: 'Updatable' })
  const category = await createRealCategory(organizationId)
  const brand = await createRealBrand(organizationId)

  const updated = await updateProduct(organizationId, product._id, {
    categoryId: category._id.toString(),
    brandId: brand._id.toString(),
  })

  assert.equal(updated.categoryId?.toString(), category._id.toString())
  assert.equal(updated.brandId?.toString(), brand._id.toString())
})

test('updating to a cross-organization categoryId is rejected', async () => {
  const organizationId = oid()
  const otherOrganizationId = oid()
  const product = await createProduct(organizationId, { name: 'Target' })
  const otherOrgCategory = await createRealCategory(otherOrganizationId)

  await assert.rejects(
    () =>
      updateProduct(organizationId, product._id, {
        categoryId: otherOrgCategory._id.toString(),
      }),
    ValidationError,
  )
})

test('updating to an archived categoryId is rejected', async () => {
  const organizationId = oid()
  const product = await createProduct(organizationId, { name: 'Target' })
  const archivedCategory = await createRealCategory(organizationId, 'ARCHIVED')

  await assert.rejects(
    () =>
      updateProduct(organizationId, product._id, {
        categoryId: archivedCategory._id.toString(),
      }),
    ValidationError,
  )
})

test('removing categoryId/brandId via explicit null succeeds', async () => {
  const organizationId = oid()
  const category = await createRealCategory(organizationId)
  const product = await createProduct(organizationId, {
    name: 'Has Category',
    categoryId: category._id.toString(),
  })

  const updated = await updateProduct(organizationId, product._id, { categoryId: null })
  assert.equal(updated.categoryId, null)
})

test('a Product referencing a category that is LATER archived is not modified or invalidated', async () => {
  const organizationId = oid()
  const category = await createRealCategory(organizationId)
  const product = await createProduct(organizationId, {
    name: 'Still Fine',
    categoryId: category._id.toString(),
  })

  await categoryRepository.archive(organizationId, category._id)

  // No cascade: the product itself is untouched and remains fully readable.
  const stillThere = await updateProduct(organizationId, product._id, {
    name: 'Still Fine Renamed',
  })
  assert.equal(stillThere.categoryId?.toString(), category._id.toString())
  assert.equal(stillThere.status, 'DRAFT')
})

test('update patch only persists allowlisted fields', async () => {
  const organizationId = oid()
  const product = await createProduct(organizationId, { name: 'Original', description: 'Keep me' })

  const updated = await updateProduct(organizationId, product._id, { name: 'Renamed' })
  assert.equal(updated.name, 'Renamed')
  assert.equal(updated.description, 'Keep me')
})

test('strict validation rejects unknown fields on update', async () => {
  const organizationId = oid()
  const product = await createProduct(organizationId, { name: 'Target' })
  await assert.rejects(
    () => updateProduct(organizationId, product._id, { sku: 'ABC-123' }),
    ZodError,
  )
})

test('updating a non-existent product throws NotFoundError', async () => {
  const organizationId = oid()
  await assert.rejects(() => updateProduct(organizationId, oid(), { name: 'Ghost' }), NotFoundError)
})

test('updating a cross-organization product throws NotFoundError', async () => {
  const organizationId = oid()
  const otherOrganizationId = oid()
  const product = await createProduct(organizationId, { name: 'Not Yours' })
  await assert.rejects(
    () => updateProduct(otherOrganizationId, product._id, { name: 'Hijacked' }),
    NotFoundError,
  )
})

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

test('archiving sets status to ARCHIVED and never deletes the document', async () => {
  const organizationId = oid()
  const product = await createProduct(organizationId, { name: 'To Archive' })
  const archived = await archiveProduct(organizationId, product._id)
  assert.equal(archived.status, 'ARCHIVED')

  const stillExists = await ProductModel.findById(product._id)
  assert.ok(stillExists)
})

test('archiving a non-existent (or cross-organization) product throws NotFoundError', async () => {
  const organizationId = oid()
  const otherOrganizationId = oid()
  const product = await createProduct(organizationId, { name: 'Protected' })

  await assert.rejects(() => archiveProduct(organizationId, oid()), NotFoundError)
  await assert.rejects(() => archiveProduct(otherOrganizationId, product._id), NotFoundError)
})
