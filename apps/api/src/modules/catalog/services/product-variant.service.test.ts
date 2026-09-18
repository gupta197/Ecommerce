import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { ZodError } from 'zod'
import { ProductVariantModel } from '../models/product-variant.model.js'
import { ProductModel } from '../models/product.model.js'
import * as productRepository from '../repositories/product.repository.js'
import { createVariant, updateVariant, archiveVariant } from './product-variant.service.js'
import { NotFoundError, ValidationError } from '../../../lib/http-errors.js'

let mongod: MongoMemoryServer

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'cat_004_product_variant_service_test' })
  await Promise.all([ProductVariantModel.init(), ProductModel.init()])
})

after(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await Promise.all([ProductVariantModel.deleteMany({}), ProductModel.deleteMany({})])
})

function oid(): Types.ObjectId {
  return new Types.ObjectId()
}

async function createRealProduct(
  organizationId: Types.ObjectId,
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED' = 'ACTIVE',
) {
  return productRepository.create({
    organizationId,
    name: 'Real Product',
    slug: `real-product-${new Types.ObjectId().toString()}`,
    status,
  })
}

// ---------------------------------------------------------------------------
// Creation / Product reference validation
// ---------------------------------------------------------------------------

test('creates a valid variant under an ACTIVE product', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  const variant = await createVariant(organizationId, {
    productId: product._id.toString(),
    sku: 'sku-1',
    price: 1999,
  })
  assert.equal(variant.sku, 'SKU-1')
  assert.equal(variant.price, 1999)
  assert.equal(variant.status, 'DRAFT')
  assert.equal(variant.productId.toString(), product._id.toString())
})

test('creating with a productId from a different organization is rejected', async () => {
  const organizationId = oid()
  const otherOrganizationId = oid()
  const otherOrgProduct = await createRealProduct(otherOrganizationId)

  await assert.rejects(
    () =>
      createVariant(organizationId, {
        productId: otherOrgProduct._id.toString(),
        sku: 'CROSS-ORG',
        price: 100,
      }),
    ValidationError,
  )
})

test('creating with a nonexistent productId is rejected', async () => {
  const organizationId = oid()
  await assert.rejects(
    () =>
      createVariant(organizationId, {
        productId: oid().toString(),
        sku: 'GHOST-PRODUCT',
        price: 100,
      }),
    ValidationError,
  )
})

test('creating a variant under an ARCHIVED product is rejected', async () => {
  const organizationId = oid()
  const archivedProduct = await createRealProduct(organizationId, 'ARCHIVED')
  await assert.rejects(
    () =>
      createVariant(organizationId, {
        productId: archivedProduct._id.toString(),
        sku: 'ARCHIVED-PRODUCT-VARIANT',
        price: 100,
      }),
    ValidationError,
  )
})

test('a variant under a DRAFT product is allowed (no ACTIVE-only requirement)', async () => {
  const organizationId = oid()
  const draftProduct = await createRealProduct(organizationId, 'DRAFT')
  await assert.doesNotReject(() =>
    createVariant(organizationId, {
      productId: draftProduct._id.toString(),
      sku: 'DRAFT-PRODUCT-VARIANT',
      price: 100,
    }),
  )
})

test('creating with a malformed productId is rejected by validation before any DB lookup', async () => {
  const organizationId = oid()
  await assert.rejects(
    () =>
      createVariant(organizationId, { productId: 'not-an-object-id', sku: 'BAD-ID', price: 100 }),
    ZodError,
  )
})

test('a variant that outlives its Product being archived is not modified or invalidated (no cascade)', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  const variant = await createVariant(organizationId, {
    productId: product._id.toString(),
    sku: 'SURVIVES-ARCHIVE',
    price: 100,
  })

  await productRepository.archive(organizationId, product._id)

  // No cascade: the variant itself is untouched and remains fully readable/updatable.
  const stillThere = await updateVariant(organizationId, variant._id, { price: 150 })
  assert.equal(stillThere.productId.toString(), product._id.toString())
  assert.equal(stillThere.price, 150)
  assert.equal(stillThere.status, 'DRAFT')
})

// ---------------------------------------------------------------------------
// SKU
// ---------------------------------------------------------------------------

test('SKU is normalized to uppercase before persistence and duplicate checking', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  await createVariant(organizationId, {
    productId: product._id.toString(),
    sku: 'lower-case',
    price: 100,
  })
  await assert.rejects(
    () =>
      createVariant(organizationId, {
        productId: product._id.toString(),
        sku: 'LOWER-CASE',
        price: 100,
      }),
    ValidationError,
  )
})

test('an explicitly duplicate SKU is rejected, not silently mutated', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  await createVariant(organizationId, {
    productId: product._id.toString(),
    sku: 'TAKEN-SKU',
    price: 100,
  })
  await assert.rejects(
    () =>
      createVariant(organizationId, {
        productId: product._id.toString(),
        sku: 'TAKEN-SKU',
        price: 200,
      }),
    ValidationError,
  )
})

test('SKU is required and rejected when missing or empty', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  await assert.rejects(
    () => createVariant(organizationId, { productId: product._id.toString(), sku: '', price: 100 }),
    ZodError,
  )
})

test('a SKU with invalid characters is rejected', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  await assert.rejects(
    () =>
      createVariant(organizationId, {
        productId: product._id.toString(),
        sku: 'bad sku!',
        price: 100,
      }),
    ZodError,
  )
})

test('SKU is editable via update, with the same normalization and duplicate rules', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  const variant = await createVariant(organizationId, {
    productId: product._id.toString(),
    sku: 'ORIGINAL-SKU',
    price: 100,
  })
  const updated = await updateVariant(organizationId, variant._id, { sku: 'renamed-sku' })
  assert.equal(updated.sku, 'RENAMED-SKU')
})

// ---------------------------------------------------------------------------
// Barcode
// ---------------------------------------------------------------------------

test('barcode is optional', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  const variant = await createVariant(organizationId, {
    productId: product._id.toString(),
    sku: 'NO-BARCODE',
    price: 100,
  })
  assert.equal(variant.barcode, undefined)
})

test('barcode is not restricted to digits (letters/hyphens accepted, no checksum enforced)', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  const variant = await createVariant(organizationId, {
    productId: product._id.toString(),
    sku: 'ALPHA-BARCODE',
    barcode: 'NOT-A-VALID-EAN-13-abc',
    price: 100,
  })
  assert.equal(variant.barcode, 'NOT-A-VALID-EAN-13-abc')
})

test('an explicitly duplicate barcode is rejected', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  await createVariant(organizationId, {
    productId: product._id.toString(),
    sku: 'BC-A',
    barcode: '999999999999',
    price: 100,
  })
  await assert.rejects(
    () =>
      createVariant(organizationId, {
        productId: product._id.toString(),
        sku: 'BC-B',
        barcode: '999999999999',
        price: 100,
      }),
    ValidationError,
  )
})

test('an empty-string barcode is rejected by validation (bounded non-empty string)', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  await assert.rejects(
    () =>
      createVariant(organizationId, {
        productId: product._id.toString(),
        sku: 'EMPTY-BC',
        barcode: '',
        price: 100,
      }),
    ZodError,
  )
})

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

test('price is required', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  await assert.rejects(
    () => createVariant(organizationId, { productId: product._id.toString(), sku: 'NO-PRICE' }),
    ZodError,
  )
})

test('a zero price is accepted', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  const variant = await createVariant(organizationId, {
    productId: product._id.toString(),
    sku: 'FREE-ITEM',
    price: 0,
  })
  assert.equal(variant.price, 0)
})

test('a negative price is rejected', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  await assert.rejects(
    () =>
      createVariant(organizationId, {
        productId: product._id.toString(),
        sku: 'NEG-PRICE',
        price: -1,
      }),
    ZodError,
  )
})

test('a fractional price is rejected', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  await assert.rejects(
    () =>
      createVariant(organizationId, {
        productId: product._id.toString(),
        sku: 'FRACTIONAL-PRICE',
        price: 19.99,
      }),
    ZodError,
  )
})

test('NaN and Infinity prices are rejected', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  await assert.rejects(
    () =>
      createVariant(organizationId, {
        productId: product._id.toString(),
        sku: 'NAN-PRICE',
        price: Number.NaN,
      }),
    ZodError,
  )
  await assert.rejects(
    () =>
      createVariant(organizationId, {
        productId: product._id.toString(),
        sku: 'INF-PRICE',
        price: Number.POSITIVE_INFINITY,
      }),
    ZodError,
  )
  await assert.rejects(
    () =>
      createVariant(organizationId, {
        productId: product._id.toString(),
        sku: 'NEG-INF-PRICE',
        price: Number.NEGATIVE_INFINITY,
      }),
    ZodError,
  )
})

test('a compareAtPrice lower than price is currently accepted (relational rule deferred)', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  const variant = await createVariant(organizationId, {
    productId: product._id.toString(),
    sku: 'INVERTED-COMPARE',
    price: 1000,
    compareAtPrice: 500,
  })
  assert.equal(variant.price, 1000)
  assert.equal(variant.compareAtPrice, 500)
})

test('cost is optional and accepts a valid integer minor-unit value', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  const variant = await createVariant(organizationId, {
    productId: product._id.toString(),
    sku: 'WITH-COST',
    price: 1000,
    cost: 600,
  })
  assert.equal(variant.cost, 600)
})

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

test('valid attributes are accepted', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  const variant = await createVariant(organizationId, {
    productId: product._id.toString(),
    sku: 'ATTR-OK',
    price: 100,
    attributes: [
      { key: 'Color', value: 'Blue' },
      { key: 'Size', value: 'M' },
      { key: 'On Sale', value: true },
      { key: 'Weight Grams', value: 250 },
    ],
  })
  assert.equal(variant.attributes?.length, 4)
})

test('duplicate attribute keys (case-insensitive) are rejected', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  await assert.rejects(
    () =>
      createVariant(organizationId, {
        productId: product._id.toString(),
        sku: 'DUP-ATTR-KEY',
        price: 100,
        attributes: [
          { key: 'Color', value: 'Blue' },
          { key: 'color', value: 'Red' },
        ],
      }),
    ZodError,
  )
})

test('more than 30 attributes is rejected by validation', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  const attributes = Array.from({ length: 31 }, (_, i) => ({ key: `attr-${i}`, value: i }))
  await assert.rejects(
    () =>
      createVariant(organizationId, {
        productId: product._id.toString(),
        sku: 'TOO-MANY-ATTRS',
        price: 100,
        attributes,
      }),
    ZodError,
  )
})

test('__proto__/constructor/prototype attribute keys are rejected', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  for (const forbiddenKey of ['__proto__', 'constructor', 'prototype']) {
    await assert.rejects(
      () =>
        createVariant(organizationId, {
          productId: product._id.toString(),
          sku: `FORBIDDEN-${forbiddenKey}`,
          price: 100,
          attributes: [{ key: forbiddenKey, value: 'x' }],
        }),
      ZodError,
    )
  }
})

test('a crafted __proto__ attribute payload never pollutes Object.prototype', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  const maliciousInput = JSON.parse(
    '{"productId":"' +
      product._id.toString() +
      '","sku":"POLLUTE-TEST","price":100,"attributes":[{"key":"__proto__","value":"polluted"}]}',
  ) as unknown

  await assert.rejects(() => createVariant(organizationId, maliciousInput), ZodError)
  assert.equal((Object.prototype as unknown as Record<string, unknown>).polluted, undefined)
})

test('Mongo-operator-shaped attribute keys ($gt, $where, dotted paths) are rejected', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  for (const key of ['$gt', '$where', 'a.b']) {
    await assert.rejects(
      () =>
        createVariant(organizationId, {
          productId: product._id.toString(),
          sku: `MONGO-KEY-${Math.random()}`,
          price: 100,
          attributes: [{ key, value: 'x' }],
        }),
      ZodError,
    )
  }
})

test('null, array, and nested-object attribute values are all rejected', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  for (const value of [null, [1, 2, 3], { nested: true }]) {
    await assert.rejects(
      () =>
        createVariant(organizationId, {
          productId: product._id.toString(),
          sku: `BAD-VALUE-${Math.random()}`,
          price: 100,
          attributes: [{ key: 'k', value }],
        }),
      ZodError,
    )
  }
})

test('attributes on update fully replace the existing array', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  const variant = await createVariant(organizationId, {
    productId: product._id.toString(),
    sku: 'REPLACE-ATTRS',
    price: 100,
    attributes: [{ key: 'Color', value: 'Blue' }],
  })
  const updated = await updateVariant(organizationId, variant._id, {
    attributes: [{ key: 'Size', value: 'L' }],
  })
  assert.equal(updated.attributes?.length, 1)
  assert.equal(updated.attributes?.[0]?.key, 'Size')
})

// ---------------------------------------------------------------------------
// Security-focused: type confusion / Mongo operator injection / mass assignment
// ---------------------------------------------------------------------------

test('price, compareAtPrice, and cost reject non-numeric types (string, null, array, object)', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  for (const badValue of ['100', null, [100], { amount: 100 }]) {
    await assert.rejects(
      () =>
        createVariant(organizationId, {
          productId: product._id.toString(),
          sku: `BAD-PRICE-TYPE-${Math.random()}`,
          price: badValue,
        }),
      ZodError,
    )
  }
  const variant = await createVariant(organizationId, {
    productId: product._id.toString(),
    sku: 'GOOD-PRICE-TYPE',
    price: 100,
  })
  for (const badValue of ['100', null, [100], { amount: 100 }]) {
    await assert.rejects(
      () => updateVariant(organizationId, variant._id, { compareAtPrice: badValue }),
      ZodError,
    )
    await assert.rejects(
      () => updateVariant(organizationId, variant._id, { cost: badValue }),
      ZodError,
    )
  }
})

test('Mongo-operator-shaped objects are rejected for sku, barcode, productId, and status (type confusion before any DB query)', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  const operatorPayload = { $gt: '' }

  await assert.rejects(
    () =>
      createVariant(organizationId, {
        productId: product._id.toString(),
        sku: operatorPayload,
        price: 100,
      }),
    ZodError,
  )
  await assert.rejects(
    () =>
      createVariant(organizationId, {
        productId: product._id.toString(),
        sku: 'OPERATOR-BARCODE',
        barcode: operatorPayload,
        price: 100,
      }),
    ZodError,
  )
  await assert.rejects(
    () =>
      createVariant(organizationId, {
        productId: operatorPayload,
        sku: 'OPERATOR-PRODUCT-ID',
        price: 100,
      }),
    ZodError,
  )
  await assert.rejects(
    () =>
      createVariant(organizationId, {
        productId: product._id.toString(),
        sku: 'OPERATOR-STATUS',
        price: 100,
        status: operatorPayload,
      }),
    ZodError,
  )
})

test('create rejects attempts to inject organizationId, _id, createdAt, and updatedAt (mass assignment)', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  const forbiddenFields = {
    organizationId: oid().toString(),
    _id: oid().toString(),
    createdAt: new Date('2000-01-01'),
    updatedAt: new Date('2000-01-01'),
  }
  for (const [field, value] of Object.entries(forbiddenFields)) {
    await assert.rejects(
      () =>
        createVariant(organizationId, {
          productId: product._id.toString(),
          sku: `INJECT-${field}`,
          price: 100,
          [field]: value,
        }),
      ZodError,
    )
  }
})

// ---------------------------------------------------------------------------
// Mass assignment / lifecycle / not-found
// ---------------------------------------------------------------------------

test('strict validation rejects unknown fields on create', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  await assert.rejects(
    () =>
      createVariant(organizationId, {
        productId: product._id.toString(),
        sku: 'EXTRA-FIELD',
        price: 100,
        inventoryQuantity: 50,
      }),
    ZodError,
  )
})

test('strict validation rejects unknown fields on update', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  const variant = await createVariant(organizationId, {
    productId: product._id.toString(),
    sku: 'TARGET',
    price: 100,
  })
  await assert.rejects(() => updateVariant(organizationId, variant._id, { name: 'Nope' }), ZodError)
})

test('productId cannot be changed via update (not part of the update schema)', async () => {
  const organizationId = oid()
  const productA = await createRealProduct(organizationId)
  const productB = await createRealProduct(organizationId)
  const variant = await createVariant(organizationId, {
    productId: productA._id.toString(),
    sku: 'IMMUTABLE-PRODUCT-ID',
    price: 100,
  })
  await assert.rejects(
    () => updateVariant(organizationId, variant._id, { productId: productB._id.toString() }),
    ZodError,
  )
})

test('only DRAFT, ACTIVE, ARCHIVED status values are accepted', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  await assert.rejects(
    () =>
      createVariant(organizationId, {
        productId: product._id.toString(),
        sku: 'BAD-STATUS',
        price: 100,
        status: 'DELETED',
      }),
    ZodError,
  )
})

test('archiving sets status to ARCHIVED and never deletes the document', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  const variant = await createVariant(organizationId, {
    productId: product._id.toString(),
    sku: 'TO-ARCHIVE',
    price: 100,
  })
  const archived = await archiveVariant(organizationId, variant._id)
  assert.equal(archived.status, 'ARCHIVED')

  const stillExists = await ProductVariantModel.findById(variant._id)
  assert.ok(stillExists)
})

test('an ARCHIVED variant can be reactivated via ordinary update (unrestricted transitions, consistent with Category/Brand/Product)', async () => {
  const organizationId = oid()
  const product = await createRealProduct(organizationId)
  const variant = await createVariant(organizationId, {
    productId: product._id.toString(),
    sku: 'RESURRECT',
    price: 100,
  })
  await archiveVariant(organizationId, variant._id)
  const reactivated = await updateVariant(organizationId, variant._id, { status: 'ACTIVE' })
  assert.equal(reactivated.status, 'ACTIVE')
})

test('updating a non-existent variant throws NotFoundError', async () => {
  const organizationId = oid()
  await assert.rejects(() => updateVariant(organizationId, oid(), { price: 100 }), NotFoundError)
})

test('updating a cross-organization variant throws NotFoundError', async () => {
  const organizationId = oid()
  const otherOrganizationId = oid()
  const product = await createRealProduct(organizationId)
  const variant = await createVariant(organizationId, {
    productId: product._id.toString(),
    sku: 'NOT-YOURS',
    price: 100,
  })
  await assert.rejects(
    () => updateVariant(otherOrganizationId, variant._id, { price: 999 }),
    NotFoundError,
  )
})

test('archiving a non-existent (or cross-organization) variant throws NotFoundError', async () => {
  const organizationId = oid()
  const otherOrganizationId = oid()
  const product = await createRealProduct(organizationId)
  const variant = await createVariant(organizationId, {
    productId: product._id.toString(),
    sku: 'PROTECTED',
    price: 100,
  })

  await assert.rejects(() => archiveVariant(organizationId, oid()), NotFoundError)
  await assert.rejects(() => archiveVariant(otherOrganizationId, variant._id), NotFoundError)
})
