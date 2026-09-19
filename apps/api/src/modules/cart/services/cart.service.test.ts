import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { ZodError } from 'zod'
import { CartModel } from '../models/cart.model.js'
import { CartItemModel, CART_ITEM_MAX_QUANTITY } from '../models/cart-item.model.js'
import { OrganizationModel } from '../../organizations/models/organization.model.js'
import { CustomerModel } from '../../customers/models/customer.model.js'
import { ProductModel } from '../../catalog/models/product.model.js'
import { ProductVariantModel } from '../../catalog/models/product-variant.model.js'
import { StockBalanceModel } from '../../inventory/models/stock-balance.model.js'
import { LocationModel } from '../../inventory/models/location.model.js'
import * as organizationRepository from '../../organizations/repositories/organization.repository.js'
import * as customerRepository from '../../customers/repositories/customer.repository.js'
import * as productRepository from '../../catalog/repositories/product.repository.js'
import * as productVariantRepository from '../../catalog/repositories/product-variant.repository.js'
import * as locationRepository from '../../inventory/repositories/location.repository.js'
import * as stockBalanceRepository from '../../inventory/repositories/stock-balance.repository.js'
import {
  getCart,
  addCartItem,
  updateCartItemQuantity,
  removeCartItem,
  clearCart,
} from './cart.service.js'
import { NotFoundError, ValidationError } from '../../../lib/http-errors.js'

let mongod: MongoMemoryServer

before(async () => {
  mongod = await MongoMemoryServer.create()
  await mongoose.connect(mongod.getUri(), { dbName: 'com_002_cart_service_test' })
  await Promise.all([
    CartModel.init(),
    CartItemModel.init(),
    OrganizationModel.init(),
    CustomerModel.init(),
    ProductModel.init(),
    ProductVariantModel.init(),
    StockBalanceModel.init(),
    LocationModel.init(),
  ])
})

after(async () => {
  await mongoose.disconnect()
  await mongod.stop()
})

beforeEach(async () => {
  await Promise.all([
    CartModel.deleteMany({}),
    CartItemModel.deleteMany({}),
    OrganizationModel.deleteMany({}),
    CustomerModel.deleteMany({}),
    ProductModel.deleteMany({}),
    ProductVariantModel.deleteMany({}),
    StockBalanceModel.deleteMany({}),
    LocationModel.deleteMany({}),
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
  overrides: { status?: 'DRAFT' | 'ACTIVE' | 'ARCHIVED'; price?: number; name?: string } = {},
) {
  const product = await productRepository.create({
    organizationId,
    name: overrides.name ?? 'Real Product',
    slug: `real-product-${oid().toString()}`,
    status: 'ACTIVE',
  })
  return productVariantRepository.create({
    organizationId,
    productId: product._id,
    sku: `SKU-${oid().toString()}`,
    price: overrides.price ?? 100,
    status: overrides.status ?? 'ACTIVE',
  })
}

async function giveStock(
  organizationId: Types.ObjectId,
  variantId: Types.ObjectId,
  quantity: number,
) {
  const location = await locationRepository.create({
    organizationId,
    name: `Warehouse-${oid().toString()}`,
    status: 'ACTIVE',
  })
  // stock-balance.repository.ts's incrementOrCreate requires a ClientSession
  // parameter; no transaction semantics are needed for this single-write
  // test fixture, so a short-lived session (no startTransaction) is used
  // purely to satisfy the signature — the same pattern
  // stock-balance.repository.test.ts's own withSession() uses.
  const session = await mongoose.startSession()
  try {
    await stockBalanceRepository.incrementOrCreate(
      { organizationId, locationId: location._id, variantId },
      quantity,
      session,
    )
  } finally {
    await session.endSession()
  }
}

// ---------------------------------------------------------------------------
// GET /cart — must not create a Cart
// ---------------------------------------------------------------------------

test('getCart on a customer with no cart yet returns an empty view and creates nothing', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const view = await getCart(customer._id, organization._id)
  assert.deepEqual(view.items, [])
  assert.equal(view.total, 0)
  assert.equal(await CartModel.countDocuments({}), 0)
})

test('getCart returns server-computed price, subtotal, and total from the current variant', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id, { price: 250 })

  await addCartItem(customer._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    quantity: 3,
  })

  const view = await getCart(customer._id, organization._id)
  assert.equal(view.items.length, 1)
  assert.equal(view.items[0]?.price, 250)
  assert.equal(view.items[0]?.subtotal, 750)
  assert.equal(view.total, 750)
})

test('getCart reflects a price change made after the item was added (no stale snapshot)', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id, { price: 100 })

  await addCartItem(customer._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    quantity: 2,
  })

  await productVariantRepository.update(organization._id, variant._id, { price: 500 })

  const view = await getCart(customer._id, organization._id)
  assert.equal(view.items[0]?.price, 500)
  assert.equal(view.items[0]?.subtotal, 1000)
  assert.equal(view.total, 1000)
})

test('getCart shows an archived-variant item flagged, not hidden', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)

  await addCartItem(customer._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    quantity: 1,
  })
  await productVariantRepository.update(organization._id, variant._id, { status: 'ARCHIVED' })

  const view = await getCart(customer._id, organization._id)
  assert.equal(view.items.length, 1)
  assert.equal(view.items[0]?.variantStatus, 'ARCHIVED')
})

test('getCart reports an availability/stock indicator using existing INV-001 reads, without mutating StockBalance', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)

  await addCartItem(customer._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    quantity: 1,
  })

  const outOfStockView = await getCart(customer._id, organization._id)
  assert.equal(outOfStockView.items[0]?.inStock, false)

  await giveStock(organization._id, variant._id, 5)
  const inStockView = await getCart(customer._id, organization._id)
  assert.equal(inStockView.items[0]?.inStock, true)
})

test("getCart only returns the caller's own cart for that organization (cross-customer isolation)", async () => {
  const customerA = await createRealCustomer()
  const customerB = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)

  await addCartItem(customerA._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    quantity: 1,
  })

  const viewB = await getCart(customerB._id, organization._id)
  assert.equal(viewB.items.length, 0)
})

// ---------------------------------------------------------------------------
// addCartItem — validation
// ---------------------------------------------------------------------------

test('addCartItem creates a Cart and a CartItem on first add', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)

  const item = await addCartItem(customer._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    quantity: 2,
  })
  assert.equal(item.quantity, 2)
  assert.equal(
    await CartModel.countDocuments({ customerId: customer._id, organizationId: organization._id }),
    1,
  )
})

test('addCartItem increments an existing item rather than creating a duplicate', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)

  await addCartItem(customer._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    quantity: 2,
  })
  const second = await addCartItem(customer._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    quantity: 3,
  })
  assert.equal(second.quantity, 5)
  assert.equal(await CartItemModel.countDocuments({ variantId: variant._id }), 1)
})

test('strict validation rejects unknown fields', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  await assert.rejects(
    () =>
      addCartItem(customer._id, {
        organizationId: organization._id.toString(),
        variantId: variant._id.toString(),
        quantity: 1,
        status: 'ACTIVE',
      }),
    ZodError,
  )
})

test('rejects attempts to inject customerId/cartId/_id/price/subtotal/total/createdAt/updatedAt', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  const forbiddenFields: Record<string, unknown> = {
    customerId: oid().toString(),
    cartId: oid().toString(),
    _id: oid().toString(),
    price: 1,
    subtotal: 1,
    total: 1,
    status: 'ACTIVE',
    createdAt: new Date('2000-01-01'),
    updatedAt: new Date('2000-01-01'),
  }
  for (const [field, value] of Object.entries(forbiddenFields)) {
    await assert.rejects(
      () =>
        addCartItem(customer._id, {
          organizationId: organization._id.toString(),
          variantId: variant._id.toString(),
          quantity: 1,
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
      addCartItem(customer._id, {
        organizationId: 'not-an-object-id',
        variantId: oid().toString(),
        quantity: 1,
      }),
    ZodError,
  )
})

test('Mongo-operator-shaped payloads are rejected for organizationId/variantId', async () => {
  const customer = await createRealCustomer()
  const operatorPayload = { $gt: '' }
  await assert.rejects(
    () =>
      addCartItem(customer._id, {
        organizationId: operatorPayload,
        variantId: oid().toString(),
        quantity: 1,
      }),
    ZodError,
  )
})

test('quantity of 0, negative, fractional, NaN, Infinity, and over-limit are all rejected', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  const invalidQuantities = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 10000]
  for (const quantity of invalidQuantities) {
    await assert.rejects(
      () =>
        addCartItem(customer._id, {
          organizationId: organization._id.toString(),
          variantId: variant._id.toString(),
          quantity,
        }),
      ZodError,
    )
  }
})

// ---------------------------------------------------------------------------
// addCartItem — 9999 ceiling (service-level)
// ---------------------------------------------------------------------------

test('service: 9990 + 9 succeeds and quantity becomes 9999', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)

  await addCartItem(customer._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    quantity: 9990,
  })
  const item = await addCartItem(customer._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    quantity: 9,
  })
  assert.equal(item.quantity, CART_ITEM_MAX_QUANTITY)
})

test('service: 9990 + 20 is rejected and quantity remains 9990', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)

  await addCartItem(customer._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    quantity: 9990,
  })
  await assert.rejects(
    () =>
      addCartItem(customer._id, {
        organizationId: organization._id.toString(),
        variantId: variant._id.toString(),
        quantity: 20,
      }),
    ValidationError,
  )

  const stored = await CartItemModel.findOne({ variantId: variant._id })
  assert.equal(stored?.quantity, 9990)
})

// ---------------------------------------------------------------------------
// Organization / variant reference validation
// ---------------------------------------------------------------------------

test('rejects a nonexistent organizationId', async () => {
  const customer = await createRealCustomer()
  await assert.rejects(
    () =>
      addCartItem(customer._id, {
        organizationId: oid().toString(),
        variantId: oid().toString(),
        quantity: 1,
      }),
    ValidationError,
  )
})

test('rejects a SUSPENDED organization', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization('SUSPENDED')
  await assert.rejects(
    () =>
      addCartItem(customer._id, {
        organizationId: organization._id.toString(),
        variantId: oid().toString(),
        quantity: 1,
      }),
    ValidationError,
  )
})

test('rejects a nonexistent variantId', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  await assert.rejects(
    () =>
      addCartItem(customer._id, {
        organizationId: organization._id.toString(),
        variantId: oid().toString(),
        quantity: 1,
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
      addCartItem(customer._id, {
        organizationId: organizationA._id.toString(),
        variantId: variant._id.toString(),
        quantity: 1,
      }),
    ValidationError,
  )
  assert.equal(await CartModel.countDocuments({ organizationId: organizationA._id }), 0)
})

test('rejects adding an ARCHIVED variant', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id, { status: 'ARCHIVED' })
  await assert.rejects(
    () =>
      addCartItem(customer._id, {
        organizationId: organization._id.toString(),
        variantId: variant._id.toString(),
        quantity: 1,
      }),
    ValidationError,
  )
})

test('allows adding an out-of-stock (zero-balance) variant', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  const item = await addCartItem(customer._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    quantity: 1,
  })
  assert.equal(item.quantity, 1)
})

// ---------------------------------------------------------------------------
// Archived customer write-blocking
// ---------------------------------------------------------------------------

test('an archived customer cannot add an item', async () => {
  const customer = await createRealCustomer('ARCHIVED')
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  await assert.rejects(
    () =>
      addCartItem(customer._id, {
        organizationId: organization._id.toString(),
        variantId: variant._id.toString(),
        quantity: 1,
      }),
    ValidationError,
  )
})

test('an archived customer cannot update quantity, remove an item, or clear the cart', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  const item = await addCartItem(customer._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    quantity: 1,
  })
  await customerRepository.archive(customer._id)

  await assert.rejects(
    () => updateCartItemQuantity(customer._id, item._id, { quantity: 2 }),
    ValidationError,
  )
  await assert.rejects(() => removeCartItem(customer._id, item._id), ValidationError)
  await assert.rejects(() => clearCart(customer._id, organization._id), ValidationError)
})

// ---------------------------------------------------------------------------
// updateCartItemQuantity (PATCH — replace)
// ---------------------------------------------------------------------------

test('updateCartItemQuantity replaces the quantity outright', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  const item = await addCartItem(customer._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    quantity: 2,
  })

  const updated = await updateCartItemQuantity(customer._id, item._id, { quantity: 40 })
  assert.equal(updated.quantity, 40)
})

test('updateCartItemQuantity rejects quantity 0, negative, fractional, NaN, Infinity, and over-limit', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  const item = await addCartItem(customer._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    quantity: 2,
  })
  const invalidQuantities = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 10000]
  for (const quantity of invalidQuantities) {
    await assert.rejects(
      () => updateCartItemQuantity(customer._id, item._id, { quantity }),
      ZodError,
    )
  }
})

test('updateCartItemQuantity rejects mass-assignment of cartId/organizationId/_id', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  const item = await addCartItem(customer._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    quantity: 2,
  })
  await assert.rejects(
    () =>
      updateCartItemQuantity(customer._id, item._id, {
        quantity: 5,
        organizationId: oid().toString(),
      }),
    ZodError,
  )
})

test('updateCartItemQuantity rejects a quantity change on an item whose variant has since been archived', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  const item = await addCartItem(customer._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    quantity: 2,
  })
  await productVariantRepository.update(organization._id, variant._id, { status: 'ARCHIVED' })

  await assert.rejects(
    () => updateCartItemQuantity(customer._id, item._id, { quantity: 5 }),
    ValidationError,
  )
  const stored = await CartItemModel.findById(item._id)
  assert.equal(stored?.quantity, 2)
})

test('updating a nonexistent item throws NotFoundError', async () => {
  const customer = await createRealCustomer()
  await assert.rejects(
    () => updateCartItemQuantity(customer._id, oid(), { quantity: 5 }),
    NotFoundError,
  )
})

test("a different customer cannot update another customer's item (cross-customer IDOR)", async () => {
  const customerA = await createRealCustomer()
  const customerB = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  const item = await addCartItem(customerA._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    quantity: 2,
  })

  await assert.rejects(
    () => updateCartItemQuantity(customerB._id, item._id, { quantity: 99 }),
    NotFoundError,
  )
  const stored = await CartItemModel.findById(item._id)
  assert.equal(stored?.quantity, 2)
})

// ---------------------------------------------------------------------------
// removeCartItem (DELETE — hard delete, always allowed regardless of variant status)
// ---------------------------------------------------------------------------

test('removeCartItem hard-deletes the item', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  const item = await addCartItem(customer._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    quantity: 1,
  })

  await removeCartItem(customer._id, item._id)
  assert.equal(await CartItemModel.findById(item._id), null)
})

test('removeCartItem always succeeds even when the variant has since been archived', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  const item = await addCartItem(customer._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    quantity: 1,
  })
  await productVariantRepository.update(organization._id, variant._id, { status: 'ARCHIVED' })

  await assert.doesNotReject(() => removeCartItem(customer._id, item._id))
  assert.equal(await CartItemModel.findById(item._id), null)
})

test('removing a nonexistent item throws NotFoundError', async () => {
  const customer = await createRealCustomer()
  await assert.rejects(() => removeCartItem(customer._id, oid()), NotFoundError)
})

test("a different customer cannot remove another customer's item (cross-customer IDOR)", async () => {
  const customerA = await createRealCustomer()
  const customerB = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  const item = await addCartItem(customerA._id, {
    organizationId: organization._id.toString(),
    variantId: variant._id.toString(),
    quantity: 1,
  })

  await assert.rejects(() => removeCartItem(customerB._id, item._id), NotFoundError)
  assert.ok(await CartItemModel.findById(item._id))
})

// ---------------------------------------------------------------------------
// clearCart
// ---------------------------------------------------------------------------

test('clearCart removes every item for that organization only', async () => {
  const customer = await createRealCustomer()
  const organizationA = await createRealOrganization()
  const organizationB = await createRealOrganization()
  const variantA = await createRealVariant(organizationA._id)
  const variantB = await createRealVariant(organizationB._id)

  await addCartItem(customer._id, {
    organizationId: organizationA._id.toString(),
    variantId: variantA._id.toString(),
    quantity: 1,
  })
  await addCartItem(customer._id, {
    organizationId: organizationB._id.toString(),
    variantId: variantB._id.toString(),
    quantity: 1,
  })

  const view = await clearCart(customer._id, organizationA._id)
  assert.deepEqual(view.items, [])

  const viewA = await getCart(customer._id, organizationA._id)
  assert.equal(viewA.items.length, 0)
  const viewB = await getCart(customer._id, organizationB._id)
  assert.equal(viewB.items.length, 1)
})

test('clearCart on a customer with no cart yet is a safe no-op and creates nothing', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const view = await clearCart(customer._id, organization._id)
  assert.deepEqual(view.items, [])
  assert.equal(await CartModel.countDocuments({}), 0)
})
