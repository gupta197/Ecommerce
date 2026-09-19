import { Types, type ClientSession } from 'mongoose'
import { withTransaction } from '../../../db/transaction.js'
import { NotFoundError, ValidationError } from '../../../lib/http-errors.js'
import { checkoutRequestSchema, type CheckoutRequestInput } from '../validation/checkout.schema.js'
import {
  assertCustomerActive,
  assertValidOrganization,
  getAggregateStock,
} from './shared-validation.js'

// Cart/CartItem are COM-002's own models. Their repositories
// (cart.repository.ts / cart-item.repository.ts) do not accept a
// ClientSession parameter, and COM-002 is a closed, completed module that
// this task must not modify. Reading/deleting these documents directly via
// their already-public Mongoose models (read+delete only, never a write of
// new data) is the only way to satisfy the requirement that confirmCheckout
// re-read and clear the Cart INSIDE the same transaction as Order creation
// (see confirmCheckout below) without touching a single cart/ file.
import { CartModel, type CartDocument } from '../../cart/models/cart.model.js'
import { CartItemModel, type CartItemDocument } from '../../cart/models/cart-item.model.js'
import * as cartRepository from '../../cart/repositories/cart.repository.js'
import * as cartItemRepository from '../../cart/repositories/cart-item.repository.js'

import * as productVariantRepository from '../../catalog/repositories/product-variant.repository.js'
import * as productRepository from '../../catalog/repositories/product.repository.js'
import * as addressRepository from '../../customers/repositories/address.repository.js'
import type { AddressDocument } from '../../customers/models/address.model.js'
import * as orderRepository from '../../orders/repositories/order.repository.js'
import type { OrderDocument, OrderAddressSnapshot } from '../../orders/models/order.model.js'

export interface CheckoutItemView {
  variantId: string
  productId: string
  name: string
  sku: string
  price: number
  quantity: number
  subtotal: number
}

export interface CheckoutAddressView {
  recipientName: string
  phone?: string
  line1: string
  line2?: string
  city: string
  state: string
  postalCode: string
  country: string
}

export interface CheckoutView {
  organizationId: string
  items: CheckoutItemView[]
  subtotal: number
  total: number
  shippingAddress: CheckoutAddressView
  billingAddress: CheckoutAddressView
}

interface LoadedCartItem {
  variantId: Types.ObjectId
  quantity: number
}

function emptyCartError(): ValidationError {
  return new ValidationError('Your cart is empty.', [
    { path: 'organizationId', message: 'Cart has no items to check out' },
  ])
}

function archivedAddressError(fieldPath: string): ValidationError {
  return new ValidationError('An archived address cannot be used for checkout.', [
    { path: fieldPath, message: 'Address is archived' },
  ])
}

function missingShippingAddressError(): ValidationError {
  return new ValidationError('A shipping address is required to check out.', [
    {
      path: 'shippingAddressId',
      message: 'No shipping address supplied and no default shipping address found',
    },
  ])
}

// ---------------------------------------------------------------------------
// Money safety (CLAUDE.md §6.4 / §13 of the COM-003 audit): price × quantity
// and sum(subtotals) are validated as safe integers at every step, never
// trusted to "just work" on unbounded or malformed persisted values.
// ---------------------------------------------------------------------------

function unsafeAmountError(fieldPath: string): ValidationError {
  return new ValidationError('A computed monetary value is not a safe integer.', [
    { path: fieldPath, message: 'Amount exceeds safe integer bounds or is malformed' },
  ])
}

function safeLineSubtotal(price: number, quantity: number, fieldPath: string): number {
  if (
    !Number.isSafeInteger(price) ||
    price < 0 ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1
  ) {
    throw unsafeAmountError(fieldPath)
  }
  const subtotal = price * quantity
  if (!Number.isSafeInteger(subtotal)) {
    throw unsafeAmountError(fieldPath)
  }
  return subtotal
}

function safeSum(values: number[], fieldPath: string): number {
  let sum = 0
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw unsafeAmountError(fieldPath)
    }
    sum += value
    if (!Number.isSafeInteger(sum)) {
      throw unsafeAmountError(fieldPath)
    }
  }
  return sum
}

// ---------------------------------------------------------------------------
// Address resolution — snapshot into the Order, never a live reference.
// Per the approved plan, address validation happens BEFORE the transaction
// opens, not inside it.
// ---------------------------------------------------------------------------

async function resolveExplicitAddress(
  customerId: Types.ObjectId,
  addressId: string,
  fieldPath: string,
): Promise<AddressDocument> {
  const address = await addressRepository.findById(customerId, new Types.ObjectId(addressId))
  if (!address) {
    // Identical for "doesn't exist" and "belongs to another customer" —
    // addressRepository.findById is already scoped by customerId, so a
    // cross-customer id is indistinguishable from nonexistent. No
    // enumeration, matching every other module's IDOR convention.
    throw new NotFoundError('Address not found.')
  }
  if (address.status === 'ARCHIVED') {
    throw archivedAddressError(fieldPath)
  }
  return address
}

async function resolveDefaultShippingAddress(customerId: Types.ObjectId): Promise<AddressDocument> {
  const addresses = await addressRepository.findByCustomerId(customerId)
  const defaultShipping = addresses.find((a) => a.isDefaultShipping && a.status === 'ACTIVE')
  if (!defaultShipping) {
    throw missingShippingAddressError()
  }
  return defaultShipping
}

interface ResolvedAddresses {
  shippingAddress: AddressDocument
  billingAddress: AddressDocument
}

async function resolveAddresses(
  customerId: Types.ObjectId,
  parsed: CheckoutRequestInput,
): Promise<ResolvedAddresses> {
  const shippingAddress = parsed.shippingAddressId
    ? await resolveExplicitAddress(customerId, parsed.shippingAddressId, 'shippingAddressId')
    : await resolveDefaultShippingAddress(customerId)

  const billingAddress = parsed.billingAddressId
    ? await resolveExplicitAddress(customerId, parsed.billingAddressId, 'billingAddressId')
    : shippingAddress

  return { shippingAddress, billingAddress }
}

function toAddressSnapshot(address: AddressDocument): OrderAddressSnapshot {
  return {
    recipientName: address.recipientName,
    phone: address.phone,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    state: address.state,
    postalCode: address.postalCode,
    country: address.country,
  }
}

// ---------------------------------------------------------------------------
// Pricing / inventory validation — shared by preview and confirm. Collects
// every failing item rather than stopping at the first, so a single
// checkout attempt reports the complete picture (all-or-nothing: any
// failure blocks the entire checkout, never a partial one).
// ---------------------------------------------------------------------------

async function priceCartItems(
  organizationId: Types.ObjectId,
  cartItems: LoadedCartItem[],
): Promise<{ items: CheckoutItemView[]; subtotal: number }> {
  const items: CheckoutItemView[] = []
  const issues: { path: string; message: string }[] = []

  for (const cartItem of cartItems) {
    const variant = await productVariantRepository.findById(organizationId, cartItem.variantId)
    const itemPath = `items.${cartItem.variantId.toString()}`

    if (!variant || variant.status !== 'ACTIVE') {
      issues.push({ path: itemPath, message: 'Item is no longer available' })
      continue
    }

    const product = await productRepository.findById(organizationId, variant.productId)
    if (!product) {
      // Products/variants are never hard-deleted anywhere in this codebase
      // (only archived) — this is not a reachable application state, only
      // a defensive guard against external tampering.
      issues.push({ path: itemPath, message: 'Item is no longer available' })
      continue
    }

    const aggregateStock = await getAggregateStock(organizationId, cartItem.variantId)
    if (aggregateStock < cartItem.quantity) {
      issues.push({ path: itemPath, message: 'Insufficient stock for this item' })
      continue
    }

    const subtotal = safeLineSubtotal(variant.price, cartItem.quantity, itemPath)
    items.push({
      variantId: variant._id.toString(),
      productId: variant.productId.toString(),
      name: product.name,
      sku: variant.sku,
      price: variant.price,
      quantity: cartItem.quantity,
      subtotal,
    })
  }

  if (issues.length > 0) {
    throw new ValidationError('One or more items in your cart cannot be checked out.', issues)
  }

  const subtotal = safeSum(
    items.map((item) => item.subtotal),
    'subtotal',
  )
  return { items, subtotal }
}

// ---------------------------------------------------------------------------
// Preview — read-only. Never creates an Order, never modifies Cart or
// inventory.
// ---------------------------------------------------------------------------

export async function previewCheckout(
  customerId: Types.ObjectId,
  input: unknown,
): Promise<CheckoutView> {
  const parsed: CheckoutRequestInput = checkoutRequestSchema.parse(input)
  await assertCustomerActive(customerId)

  const organizationId = new Types.ObjectId(parsed.organizationId)
  await assertValidOrganization(organizationId)

  const { shippingAddress, billingAddress } = await resolveAddresses(customerId, parsed)

  const cart = await cartRepository.findByCustomerAndOrganization({ customerId, organizationId })
  if (!cart) {
    throw emptyCartError()
  }
  const cartItems = await cartItemRepository.listByCart(cart._id)
  if (cartItems.length === 0) {
    throw emptyCartError()
  }

  const { items, subtotal } = await priceCartItems(organizationId, cartItems)
  const total = subtotal // no tax/discount/shipping in COM-003

  return {
    organizationId: organizationId.toString(),
    items,
    subtotal,
    total,
    shippingAddress: toAddressSnapshot(shippingAddress),
    billingAddress: toAddressSnapshot(billingAddress),
  }
}

// ---------------------------------------------------------------------------
// Confirm — creates the Order and clears the Cart atomically.
// ---------------------------------------------------------------------------

async function loadCartForConfirm(
  customerId: Types.ObjectId,
  organizationId: Types.ObjectId,
  session: ClientSession,
): Promise<{ cart: CartDocument; items: CartItemDocument[] }> {
  const cart = await CartModel.findOne({ customerId, organizationId }).session(session)
  if (!cart) {
    throw emptyCartError()
  }
  const items = await CartItemModel.find({ cartId: cart._id }).session(session)
  if (items.length === 0) {
    throw emptyCartError()
  }
  return { cart, items }
}

export async function confirmCheckout(
  customerId: Types.ObjectId,
  input: unknown,
): Promise<OrderDocument> {
  const parsed: CheckoutRequestInput = checkoutRequestSchema.parse(input)
  await assertCustomerActive(customerId)

  const organizationId = new Types.ObjectId(parsed.organizationId)
  await assertValidOrganization(organizationId)

  const { shippingAddress, billingAddress } = await resolveAddresses(customerId, parsed)
  const shippingSnapshot = toAddressSnapshot(shippingAddress)
  const billingSnapshot = toAddressSnapshot(billingAddress)

  return withTransaction(async (session) => {
    const { cart, items: cartItems } = await loadCartForConfirm(customerId, organizationId, session)

    // Product/variant/stock reads are plain (non-session) reads via the
    // existing, unmodified catalog/inventory repositories — those modules
    // cannot be modified to accept a session either. This does not weaken
    // correctness: COM-003 never writes to ProductVariant/StockBalance, so
    // there is nothing for these reads to be transactionally consistent
    // WITH other than the Cart/CartItem read above and the Order write
    // below, both of which are genuinely session-scoped. See
    // checkout/README.md for the full reasoning.
    const { items, subtotal } = await priceCartItems(
      organizationId,
      cartItems.map((item): LoadedCartItem => ({
        variantId: item.variantId,
        quantity: item.quantity,
      })),
    )
    const total = subtotal

    const order = await orderRepository.create(
      {
        customerId,
        organizationId,
        items: items.map((item) => ({
          variantId: new Types.ObjectId(item.variantId),
          productId: new Types.ObjectId(item.productId),
          name: item.name,
          sku: item.sku,
          price: item.price,
          quantity: item.quantity,
          subtotal: item.subtotal,
        })),
        subtotal,
        total,
        status: 'PENDING_PAYMENT',
        shippingAddress: shippingSnapshot,
        billingAddress: billingSnapshot,
      },
      session,
    )

    await CartItemModel.deleteMany({ cartId: cart._id }).session(session)

    return order
  })
}
