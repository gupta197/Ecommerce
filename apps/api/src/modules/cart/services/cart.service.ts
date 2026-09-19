import { Types } from 'mongoose'
import * as cartRepository from '../repositories/cart.repository.js'
import * as cartItemRepository from '../repositories/cart-item.repository.js'
import * as productVariantRepository from '../../catalog/repositories/product-variant.repository.js'
import * as productRepository from '../../catalog/repositories/product.repository.js'
import { NotFoundError, ValidationError } from '../../../lib/http-errors.js'
import {
  addCartItemSchema,
  updateCartItemQuantitySchema,
  type AddCartItemInput,
  type UpdateCartItemQuantityInput,
} from '../validation/cart-item.schema.js'
import { CART_ITEM_MAX_QUANTITY, type CartItemDocument } from '../models/cart-item.model.js'
import type { CartDocument } from '../models/cart.model.js'
import type { ProductVariantStatus } from '../../catalog/models/product-variant.model.js'
import {
  assertCustomerActive,
  assertValidOrganization,
  assertValidVariant,
  getAggregateStock,
} from './shared-validation.js'

export interface CartItemView {
  id: string
  variantId: string
  productId: string
  productName: string
  sku: string
  price: number
  quantity: number
  subtotal: number
  variantStatus: ProductVariantStatus
  inStock: boolean
}

export interface CartView {
  organizationId: string
  items: CartItemView[]
  total: number
}

function quantityLimitError(): ValidationError {
  return new ValidationError(
    'Adding this quantity would exceed the maximum allowed quantity for this item.',
    [{ path: 'quantity', message: `Maximum quantity per cart item is ${CART_ITEM_MAX_QUANTITY}` }],
  )
}

/** Resolves the CartItem for `itemId` and verifies it belongs to a Cart
 *  owned by `customerId` — CartItem itself carries no customerId (ADR-025),
 *  so ownership is established via its cartId. Both "item does not exist"
 *  and "item belongs to a different customer" produce the identical
 *  generic NotFoundError, matching every other module's no-enumeration
 *  IDOR convention. */
async function resolveOwnedItem(
  customerId: Types.ObjectId,
  itemId: Types.ObjectId,
): Promise<{ item: CartItemDocument; cart: CartDocument }> {
  const item = await cartItemRepository.findById(itemId)
  if (!item) {
    throw new NotFoundError('Cart item not found.')
  }
  const cart = await cartRepository.findById(customerId, item.cartId)
  if (!cart) {
    throw new NotFoundError('Cart item not found.')
  }
  return { item, cart }
}

async function toItemView(
  organizationId: Types.ObjectId,
  item: CartItemDocument,
): Promise<CartItemView> {
  const variant = await productVariantRepository.findById(organizationId, item.variantId)
  // Products/variants are never hard-deleted anywhere in this codebase
  // (only archived), so a missing variant here is not a reachable
  // application state — handled defensively only because a GET must never
  // 500, never as a designed cascade/removal behavior.
  if (!variant) {
    return {
      id: item._id.toString(),
      variantId: item.variantId.toString(),
      productId: '',
      productName: '(unavailable)',
      sku: '',
      price: 0,
      quantity: item.quantity,
      subtotal: 0,
      variantStatus: 'ARCHIVED',
      inStock: false,
    }
  }

  const [product, aggregateStock] = await Promise.all([
    productRepository.findById(organizationId, variant.productId),
    getAggregateStock(organizationId, item.variantId),
  ])

  // Money is integer minor units (ADR-008) — plain integer multiplication,
  // never floating-point arithmetic.
  const subtotal = variant.price * item.quantity

  return {
    id: item._id.toString(),
    variantId: variant._id.toString(),
    productId: variant.productId.toString(),
    productName: product?.name ?? '(unavailable)',
    sku: variant.sku,
    price: variant.price,
    quantity: item.quantity,
    subtotal,
    variantStatus: variant.status,
    inStock: aggregateStock > 0,
  }
}

/**
 * GET /cart. Deliberately read-only: if no Cart document exists yet for
 * (customerId, organizationId), this returns an empty-cart view rather than
 * creating one (approved COM-002 correction #2 — Cart creation happens only
 * via addCartItem). Every price/subtotal/total is resolved fresh from the
 * current ProductVariant on every call — never a stored snapshot — which is
 * what makes "Cart totals are server-authoritative" true at read time.
 */
export async function getCart(
  customerId: Types.ObjectId,
  organizationId: Types.ObjectId,
): Promise<CartView> {
  const cart = await cartRepository.findByCustomerAndOrganization({ customerId, organizationId })
  if (!cart) {
    return { organizationId: organizationId.toString(), items: [], total: 0 }
  }

  const items = await cartItemRepository.listByCart(cart._id)
  const views = await Promise.all(items.map((item) => toItemView(organizationId, item)))
  const total = views.reduce((sum, view) => sum + view.subtotal, 0)

  return { organizationId: organizationId.toString(), items: views, total }
}

/**
 * POST /cart/items. Creates the customer's Cart for this organization if it
 * doesn't exist yet (the only place that happens), then atomically
 * increments-or-creates the CartItem — the 1..9999 ceiling is enforced by
 * cart-item.repository.ts's incrementOrCreate as part of the database
 * operation itself, never a separate read-calculate-write sequence.
 */
export async function addCartItem(
  customerId: Types.ObjectId,
  input: unknown,
): Promise<CartItemDocument> {
  const parsed: AddCartItemInput = addCartItemSchema.parse(input)
  await assertCustomerActive(customerId)

  const organizationId = new Types.ObjectId(parsed.organizationId)
  const variantId = new Types.ObjectId(parsed.variantId)

  await assertValidOrganization(organizationId)
  await assertValidVariant(organizationId, variantId)

  const cart = await cartRepository.findOrCreate({ customerId, organizationId })
  const result = await cartItemRepository.incrementOrCreate(
    { cartId: cart._id, organizationId, variantId },
    parsed.quantity,
  )

  if (result.limitExceeded || !result.item) {
    throw quantityLimitError()
  }
  return result.item
}

/**
 * PATCH /cart/items/:id — replaces the quantity outright. Rejected outright
 * if the item's variant has since become ARCHIVED (approved COM-002
 * correction #3): unlike removal, a quantity edit implies the customer
 * still intends to purchase something that no longer exists in the
 * organization's active catalog.
 */
export async function updateCartItemQuantity(
  customerId: Types.ObjectId,
  itemId: Types.ObjectId,
  input: unknown,
): Promise<CartItemDocument> {
  const parsed: UpdateCartItemQuantityInput = updateCartItemQuantitySchema.parse(input)
  await assertCustomerActive(customerId)

  const { item, cart } = await resolveOwnedItem(customerId, itemId)

  const variant = await productVariantRepository.findById(item.organizationId, item.variantId)
  if (!variant || variant.status === 'ARCHIVED') {
    throw new ValidationError('An archived variant cannot be modified.', [
      { path: 'quantity', message: 'Variant is archived' },
    ])
  }

  const updated = await cartItemRepository.replaceQuantity(cart._id, itemId, parsed.quantity)
  if (!updated) {
    throw new NotFoundError('Cart item not found.')
  }
  return updated
}

/**
 * DELETE /cart/items/:id — always allowed regardless of the variant's
 * status (approved COM-002 correction #3), never cascaded from anywhere
 * else. Hard delete (ADR-025): the row is genuinely gone afterward.
 */
export async function removeCartItem(
  customerId: Types.ObjectId,
  itemId: Types.ObjectId,
): Promise<CartItemDocument> {
  await assertCustomerActive(customerId)
  const { cart } = await resolveOwnedItem(customerId, itemId)

  const removed = await cartItemRepository.remove(cart._id, itemId)
  if (!removed) {
    throw new NotFoundError('Cart item not found.')
  }
  return removed
}

/**
 * DELETE /cart?organizationId=X — removes every item in the customer's
 * cart for this organization. Idempotent and never creates a Cart: if none
 * exists yet, this is a no-op that still returns the empty-cart shape.
 */
export async function clearCart(
  customerId: Types.ObjectId,
  organizationId: Types.ObjectId,
): Promise<CartView> {
  await assertCustomerActive(customerId)
  const cart = await cartRepository.findByCustomerAndOrganization({ customerId, organizationId })
  if (cart) {
    await cartItemRepository.removeAllByCart(cart._id)
  }
  return { organizationId: organizationId.toString(), items: [], total: 0 }
}
