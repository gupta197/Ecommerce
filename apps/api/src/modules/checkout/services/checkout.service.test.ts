import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import mongoose, { Types } from 'mongoose'
import { ZodError } from 'zod'
import { CartModel } from '../../cart/models/cart.model.js'
import { CartItemModel } from '../../cart/models/cart-item.model.js'
import { OrganizationModel } from '../../organizations/models/organization.model.js'
import { CustomerModel } from '../../customers/models/customer.model.js'
import { AddressModel, type AddressDocument } from '../../customers/models/address.model.js'
import { ProductModel } from '../../catalog/models/product.model.js'
import { ProductVariantModel } from '../../catalog/models/product-variant.model.js'
import { StockBalanceModel } from '../../inventory/models/stock-balance.model.js'
import { LocationModel } from '../../inventory/models/location.model.js'
import { InventoryTransactionModel } from '../../inventory/models/inventory-transaction.model.js'
import { OrderModel } from '../../orders/models/order.model.js'
import * as organizationRepository from '../../organizations/repositories/organization.repository.js'
import * as customerRepository from '../../customers/repositories/customer.repository.js'
import * as addressRepository from '../../customers/repositories/address.repository.js'
import * as productRepository from '../../catalog/repositories/product.repository.js'
import * as productVariantRepository from '../../catalog/repositories/product-variant.repository.js'
import * as locationRepository from '../../inventory/repositories/location.repository.js'
import * as stockBalanceRepository from '../../inventory/repositories/stock-balance.repository.js'
import { addCartItem } from '../../cart/services/cart.service.js'
import { previewCheckout, confirmCheckout } from './checkout.service.js'
import { NotFoundError, ValidationError } from '../../../lib/http-errors.js'

let replSet: MongoMemoryReplSet

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  await mongoose.connect(replSet.getUri(), { dbName: 'com_003_checkout_service_test' })
  await Promise.all([
    CartModel.init(),
    CartItemModel.init(),
    OrganizationModel.init(),
    CustomerModel.init(),
    AddressModel.init(),
    ProductModel.init(),
    ProductVariantModel.init(),
    StockBalanceModel.init(),
    LocationModel.init(),
    InventoryTransactionModel.init(),
    OrderModel.init(),
  ])
})

after(async () => {
  await mongoose.disconnect()
  await replSet.stop()
})

beforeEach(async () => {
  await Promise.all([
    CartModel.deleteMany({}),
    CartItemModel.deleteMany({}),
    OrganizationModel.deleteMany({}),
    CustomerModel.deleteMany({}),
    AddressModel.deleteMany({}),
    ProductModel.deleteMany({}),
    ProductVariantModel.deleteMany({}),
    StockBalanceModel.deleteMany({}),
    LocationModel.deleteMany({}),
    InventoryTransactionModel.deleteMany({}),
    OrderModel.deleteMany({}),
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
  return location
}

async function createRealAddress(
  customerId: Types.ObjectId,
  overrides: {
    isDefaultShipping?: boolean
    isDefaultBilling?: boolean
    status?: 'ACTIVE' | 'ARCHIVED'
    city?: string
  } = {},
): Promise<AddressDocument> {
  const address = await addressRepository.create({
    customerId,
    recipientName: 'Ada Lovelace',
    line1: '1 Analytical Engine Way',
    city: overrides.city ?? 'London',
    state: 'London',
    postalCode: 'AB1 2CD',
    country: 'UK',
    status: overrides.status ?? 'ACTIVE',
  })
  if (overrides.isDefaultShipping || overrides.isDefaultBilling) {
    await AddressModel.updateOne(
      { _id: address._id },
      {
        $set: {
          isDefaultShipping: Boolean(overrides.isDefaultShipping),
          isDefaultBilling: Boolean(overrides.isDefaultBilling),
        },
      },
    )
  }
  const refreshed = await AddressModel.findById(address._id)
  if (!refreshed) {
    throw new Error('Address unexpectedly missing after creation')
  }
  return refreshed
}

async function addToCart(
  customerId: Types.ObjectId,
  organizationId: Types.ObjectId,
  variantId: Types.ObjectId,
  quantity: number,
) {
  return addCartItem(customerId, {
    organizationId: organizationId.toString(),
    variantId: variantId.toString(),
    quantity,
  })
}

function checkoutInput(organizationId: Types.ObjectId, overrides: Record<string, unknown> = {}) {
  return { organizationId: organizationId.toString(), ...overrides }
}

// ---------------------------------------------------------------------------
// CUSTOMER
// ---------------------------------------------------------------------------

test('an archived customer cannot preview checkout', async () => {
  const customer = await createRealCustomer('ARCHIVED')
  const organization = await createRealOrganization()
  await assert.rejects(
    () => previewCheckout(customer._id, checkoutInput(organization._id)),
    ValidationError,
  )
})

test('an archived customer cannot confirm checkout', async () => {
  const customer = await createRealCustomer('ARCHIVED')
  const organization = await createRealOrganization()
  await assert.rejects(
    () => confirmCheckout(customer._id, checkoutInput(organization._id)),
    ValidationError,
  )
})

// ---------------------------------------------------------------------------
// CART
// ---------------------------------------------------------------------------

test('preview rejects when no Cart exists yet', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  await assert.rejects(
    () => previewCheckout(customer._id, checkoutInput(organization._id)),
    ValidationError,
  )
})

test('confirm rejects when no Cart exists yet, and creates no Order', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  await assert.rejects(
    () => confirmCheckout(customer._id, checkoutInput(organization._id)),
    ValidationError,
  )
  assert.equal(await OrderModel.countDocuments({}), 0)
})

test('confirm rejects an empty Cart (Cart exists, zero items)', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  const item = await addToCart(customer._id, organization._id, variant._id, 1)
  await CartItemModel.deleteOne({ _id: item._id })

  await assert.rejects(
    () => confirmCheckout(customer._id, checkoutInput(organization._id)),
    ValidationError,
  )
})

test('confirm computes correct totals across multiple cart items', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variantA = await createRealVariant(organization._id, { price: 100 })
  const variantB = await createRealVariant(organization._id, { price: 250 })
  await giveStock(organization._id, variantA._id, 10)
  await giveStock(organization._id, variantB._id, 10)
  await addToCart(customer._id, organization._id, variantA._id, 2)
  await addToCart(customer._id, organization._id, variantB._id, 3)
  await createRealAddress(customer._id, { isDefaultShipping: true })

  const order = await confirmCheckout(customer._id, checkoutInput(organization._id))
  assert.equal(order.items.length, 2)
  assert.equal(order.subtotal, 200 + 750)
  assert.equal(order.total, 950)
})

test('an archived variant in the cart blocks the entire checkout', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variantA = await createRealVariant(organization._id)
  const variantB = await createRealVariant(organization._id)
  await giveStock(organization._id, variantA._id, 10)
  await giveStock(organization._id, variantB._id, 10)
  await addToCart(customer._id, organization._id, variantA._id, 1)
  await addToCart(customer._id, organization._id, variantB._id, 1)
  await createRealAddress(customer._id, { isDefaultShipping: true })
  await productVariantRepository.update(organization._id, variantB._id, { status: 'ARCHIVED' })

  await assert.rejects(
    () => previewCheckout(customer._id, checkoutInput(organization._id)),
    ValidationError,
  )
  await assert.rejects(
    () => confirmCheckout(customer._id, checkoutInput(organization._id)),
    ValidationError,
  )
  assert.equal(await OrderModel.countDocuments({}), 0)
})

test("a customer's cart in one organization is untouched by checking out another organization", async () => {
  const customer = await createRealCustomer()
  const organizationA = await createRealOrganization()
  const organizationB = await createRealOrganization()
  const variantA = await createRealVariant(organizationA._id)
  const variantB = await createRealVariant(organizationB._id)
  await giveStock(organizationA._id, variantA._id, 10)
  await giveStock(organizationB._id, variantB._id, 10)
  await addToCart(customer._id, organizationA._id, variantA._id, 1)
  await addToCart(customer._id, organizationB._id, variantB._id, 2)
  await createRealAddress(customer._id, { isDefaultShipping: true })

  await confirmCheckout(customer._id, checkoutInput(organizationA._id))

  assert.equal(await CartItemModel.countDocuments({}), 1)
  const remaining = await CartItemModel.findOne({})
  assert.equal(remaining?.variantId.toString(), variantB._id.toString())
})

test('Cart is left unchanged when checkout fails validation', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  // No stock given -> insufficient stock -> checkout must fail.
  await addToCart(customer._id, organization._id, variant._id, 1)
  await createRealAddress(customer._id, { isDefaultShipping: true })

  await assert.rejects(
    () => confirmCheckout(customer._id, checkoutInput(organization._id)),
    ValidationError,
  )
  assert.equal(await CartItemModel.countDocuments({}), 1)
  assert.equal(await OrderModel.countDocuments({}), 0)
})

// ---------------------------------------------------------------------------
// PRICE
// ---------------------------------------------------------------------------

test('preview and confirm use the current ProductVariant price, not a cached one', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id, { price: 100 })
  await giveStock(organization._id, variant._id, 10)
  await addToCart(customer._id, organization._id, variant._id, 2)
  await createRealAddress(customer._id, { isDefaultShipping: true })

  await productVariantRepository.update(organization._id, variant._id, { price: 150 })

  const preview = await previewCheckout(customer._id, checkoutInput(organization._id))
  assert.equal(preview.items[0]?.price, 150)
  assert.equal(preview.subtotal, 300)
})

test('a price change between preview and confirm is used silently at confirm, not rejected', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id, { price: 100 })
  await giveStock(organization._id, variant._id, 10)
  await addToCart(customer._id, organization._id, variant._id, 2)
  await createRealAddress(customer._id, { isDefaultShipping: true })

  const preview = await previewCheckout(customer._id, checkoutInput(organization._id))
  assert.equal(preview.total, 200)

  await productVariantRepository.update(organization._id, variant._id, { price: 120 })

  const order = await confirmCheckout(customer._id, checkoutInput(organization._id))
  assert.equal(order.items[0]?.price, 120)
  assert.equal(order.total, 240)
})

test('client-supplied price/subtotal/total/status fields are rejected by strict validation', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const forbiddenFields: Record<string, unknown> = {
    price: 1,
    subtotal: 1,
    total: 1,
    status: 'PENDING_PAYMENT',
    customerId: oid().toString(),
    cartId: oid().toString(),
    cartItemId: oid().toString(),
    orderId: oid().toString(),
    createdAt: new Date('2000-01-01'),
    items: [{ variantId: oid().toString(), price: 1, quantity: 1 }],
  }
  for (const [field, value] of Object.entries(forbiddenFields)) {
    await assert.rejects(
      () => previewCheckout(customer._id, checkoutInput(organization._id, { [field]: value })),
      ZodError,
    )
    await assert.rejects(
      () => confirmCheckout(customer._id, checkoutInput(organization._id, { [field]: value })),
      ZodError,
    )
  }
})

test('a malformed organizationId is rejected before any DB lookup', async () => {
  const customer = await createRealCustomer()
  await assert.rejects(
    () => previewCheckout(customer._id, { organizationId: 'not-an-object-id' }),
    ZodError,
  )
})

test('a Mongo-operator-shaped organizationId is rejected', async () => {
  const customer = await createRealCustomer()
  await assert.rejects(
    () => previewCheckout(customer._id, { organizationId: { $gt: '' } }),
    ZodError,
  )
})

test('SAFETY: a computed line subtotal exceeding safe-integer bounds is rejected, not silently corrupted', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id, { price: Number.MAX_SAFE_INTEGER })
  await giveStock(organization._id, variant._id, 10)
  await addToCart(customer._id, organization._id, variant._id, 2)
  await createRealAddress(customer._id, { isDefaultShipping: true })

  await assert.rejects(
    () => previewCheckout(customer._id, checkoutInput(organization._id)),
    ValidationError,
  )
})

// ---------------------------------------------------------------------------
// INVENTORY
// ---------------------------------------------------------------------------

test('sufficient stock allows checkout', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  await giveStock(organization._id, variant._id, 5)
  await addToCart(customer._id, organization._id, variant._id, 5)
  await createRealAddress(customer._id, { isDefaultShipping: true })

  const order = await confirmCheckout(customer._id, checkoutInput(organization._id))
  assert.equal(order.items[0]?.quantity, 5)
})

test('zero stock blocks checkout', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  await addToCart(customer._id, organization._id, variant._id, 1)
  await createRealAddress(customer._id, { isDefaultShipping: true })

  await assert.rejects(
    () => confirmCheckout(customer._id, checkoutInput(organization._id)),
    ValidationError,
  )
})

test('insufficient stock (less than requested) blocks checkout', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  await giveStock(organization._id, variant._id, 3)
  await addToCart(customer._id, organization._id, variant._id, 5)
  await createRealAddress(customer._id, { isDefaultShipping: true })

  await assert.rejects(
    () => confirmCheckout(customer._id, checkoutInput(organization._id)),
    ValidationError,
  )
})

test('stock spread across multiple locations is correctly summed', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  await giveStock(organization._id, variant._id, 3)
  await giveStock(organization._id, variant._id, 4)
  await addToCart(customer._id, organization._id, variant._id, 6)
  await createRealAddress(customer._id, { isDefaultShipping: true })

  const order = await confirmCheckout(customer._id, checkoutInput(organization._id))
  assert.equal(order.items[0]?.quantity, 6)
})

test('a successful checkout never mutates StockBalance and never creates an InventoryTransaction', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  await giveStock(organization._id, variant._id, 10)
  await addToCart(customer._id, organization._id, variant._id, 4)
  await createRealAddress(customer._id, { isDefaultShipping: true })

  const balanceBefore = await StockBalanceModel.findOne({
    organizationId: organization._id,
    variantId: variant._id,
  })

  await confirmCheckout(customer._id, checkoutInput(organization._id))

  const balanceAfter = await StockBalanceModel.findOne({
    organizationId: organization._id,
    variantId: variant._id,
  })
  assert.equal(balanceAfter?.quantityOnHand, balanceBefore?.quantityOnHand)
  assert.equal(await InventoryTransactionModel.countDocuments({}), 0)
})

// ---------------------------------------------------------------------------
// ORGANIZATION
// ---------------------------------------------------------------------------

test('rejects a nonexistent organizationId', async () => {
  const customer = await createRealCustomer()
  await assert.rejects(() => previewCheckout(customer._id, checkoutInput(oid())), ValidationError)
})

test('rejects a SUSPENDED organization', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization('SUSPENDED')
  await assert.rejects(
    () => previewCheckout(customer._id, checkoutInput(organization._id)),
    ValidationError,
  )
})

test('a CartItem referencing a variant from a different organization is rejected (defense-in-depth)', async () => {
  const customer = await createRealCustomer()
  const organizationA = await createRealOrganization()
  const organizationB = await createRealOrganization()
  const variantA = await createRealVariant(organizationA._id)
  const variantFromB = await createRealVariant(organizationB._id)
  await giveStock(organizationA._id, variantA._id, 10)
  await addToCart(customer._id, organizationA._id, variantA._id, 1)
  await createRealAddress(customer._id, { isDefaultShipping: true })

  // Simulate a corrupted/legacy row that Cart's own invariant would never
  // produce through its normal API — direct DB manipulation, not achievable
  // via any public COM-002 operation.
  const cart = await CartModel.findOne({
    customerId: customer._id,
    organizationId: organizationA._id,
  })
  await CartItemModel.create({
    cartId: cart!._id,
    organizationId: organizationA._id,
    variantId: variantFromB._id,
    quantity: 1,
  })

  await assert.rejects(
    () => previewCheckout(customer._id, checkoutInput(organizationA._id)),
    ValidationError,
  )
})

// ---------------------------------------------------------------------------
// ADDRESS
// ---------------------------------------------------------------------------

test('an explicit shipping address is used and snapshotted', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  await giveStock(organization._id, variant._id, 10)
  await addToCart(customer._id, organization._id, variant._id, 1)
  const address = await createRealAddress(customer._id, { city: 'Explicit City' })

  const order = await confirmCheckout(
    customer._id,
    checkoutInput(organization._id, { shippingAddressId: address._id.toString() }),
  )
  assert.equal(order.shippingAddress.city, 'Explicit City')
})

test("the customer's default shipping address is used when none is explicitly supplied", async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  await giveStock(organization._id, variant._id, 10)
  await addToCart(customer._id, organization._id, variant._id, 1)
  await createRealAddress(customer._id, { city: 'Not Default' })
  await createRealAddress(customer._id, { isDefaultShipping: true, city: 'Default City' })

  const order = await confirmCheckout(customer._id, checkoutInput(organization._id))
  assert.equal(order.shippingAddress.city, 'Default City')
})

test('checkout is rejected when no shipping address is supplied and no default exists', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  await giveStock(organization._id, variant._id, 10)
  await addToCart(customer._id, organization._id, variant._id, 1)
  await createRealAddress(customer._id) // no default flags set

  await assert.rejects(
    () => confirmCheckout(customer._id, checkoutInput(organization._id)),
    ValidationError,
  )
})

test("a different customer's address is rejected as not found (IDOR)", async () => {
  const customerA = await createRealCustomer()
  const customerB = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  await giveStock(organization._id, variant._id, 10)
  await addToCart(customerA._id, organization._id, variant._id, 1)
  const addressB = await createRealAddress(customerB._id)

  await assert.rejects(
    () =>
      confirmCheckout(
        customerA._id,
        checkoutInput(organization._id, { shippingAddressId: addressB._id.toString() }),
      ),
    NotFoundError,
  )
})

test('an archived address cannot be used for checkout', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  await giveStock(organization._id, variant._id, 10)
  await addToCart(customer._id, organization._id, variant._id, 1)
  const address = await createRealAddress(customer._id)
  await addressRepository.archive(customer._id, address._id)

  await assert.rejects(
    () =>
      confirmCheckout(
        customer._id,
        checkoutInput(organization._id, { shippingAddressId: address._id.toString() }),
      ),
    ValidationError,
  )
})

test('an explicit billing address is used and snapshotted', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  await giveStock(organization._id, variant._id, 10)
  await addToCart(customer._id, organization._id, variant._id, 1)
  await createRealAddress(customer._id, { isDefaultShipping: true, city: 'Ship City' })
  const billing = await createRealAddress(customer._id, { city: 'Bill City' })

  const order = await confirmCheckout(
    customer._id,
    checkoutInput(organization._id, { billingAddressId: billing._id.toString() }),
  )
  assert.equal(order.shippingAddress.city, 'Ship City')
  assert.equal(order.billingAddress.city, 'Bill City')
})

test('billing address falls back to the resolved shipping address when omitted', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  await giveStock(organization._id, variant._id, 10)
  await addToCart(customer._id, organization._id, variant._id, 1)
  await createRealAddress(customer._id, { isDefaultShipping: true, city: 'Only Address' })

  const order = await confirmCheckout(customer._id, checkoutInput(organization._id))
  assert.equal(order.billingAddress.city, 'Only Address')
  assert.equal(order.shippingAddress.city, order.billingAddress.city)
})

// ---------------------------------------------------------------------------
// TRANSACTION
// ---------------------------------------------------------------------------

test('TRANSACTION: successful checkout creates exactly one Order and clears the Cart atomically', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  await giveStock(organization._id, variant._id, 10)
  await addToCart(customer._id, organization._id, variant._id, 2)
  await createRealAddress(customer._id, { isDefaultShipping: true })

  await confirmCheckout(customer._id, checkoutInput(organization._id))

  assert.equal(await OrderModel.countDocuments({}), 1)
  assert.equal(await CartItemModel.countDocuments({}), 0)
})

test('TRANSACTION: a forced Order-creation failure leaves the Cart uncleared (rollback)', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  await giveStock(organization._id, variant._id, 10)
  await addToCart(customer._id, organization._id, variant._id, 2)
  await createRealAddress(customer._id, { isDefaultShipping: true })

  const original = OrderModel.create.bind(OrderModel)
  OrderModel.create = (async () => {
    throw new Error('deliberate forced order-creation failure')
  }) as typeof OrderModel.create
  try {
    await assert.rejects(() => confirmCheckout(customer._id, checkoutInput(organization._id)))
  } finally {
    OrderModel.create = original
  }

  assert.equal(await OrderModel.countDocuments({}), 0)
  assert.equal(await CartItemModel.countDocuments({}), 1)
})

test('TRANSACTION: a forced Cart-clearing failure leaves no Order created (rollback)', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  await giveStock(organization._id, variant._id, 10)
  await addToCart(customer._id, organization._id, variant._id, 2)
  await createRealAddress(customer._id, { isDefaultShipping: true })

  const original = CartItemModel.deleteMany.bind(CartItemModel)
  CartItemModel.deleteMany = ((filter: unknown) => {
    if (filter && typeof filter === 'object' && 'cartId' in filter) {
      return {
        session: () => {
          throw new Error('deliberate forced cart-clearing failure')
        },
      } as unknown as ReturnType<typeof CartItemModel.deleteMany>
    }
    return original(filter as never)
  }) as typeof CartItemModel.deleteMany
  try {
    await assert.rejects(() => confirmCheckout(customer._id, checkoutInput(organization._id)))
  } finally {
    CartItemModel.deleteMany = original
  }

  assert.equal(await OrderModel.countDocuments({}), 0)
  assert.equal(await CartItemModel.countDocuments({}), 1)
})

// ---------------------------------------------------------------------------
// CONCURRENCY
// ---------------------------------------------------------------------------

test('CONCURRENCY: two simultaneous confirms for the same Cart create exactly one Order', async () => {
  const customer = await createRealCustomer()
  const organization = await createRealOrganization()
  const variant = await createRealVariant(organization._id)
  await giveStock(organization._id, variant._id, 10)
  await addToCart(customer._id, organization._id, variant._id, 2)
  await createRealAddress(customer._id, { isDefaultShipping: true })

  const attempt = () => confirmCheckout(customer._id, checkoutInput(organization._id))
  const results = await Promise.allSettled([attempt(), attempt()])

  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  const rejected = results.filter((r) => r.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof ValidationError)

  assert.equal(await OrderModel.countDocuments({}), 1)
  assert.equal(await CartItemModel.countDocuments({}), 0)
})
