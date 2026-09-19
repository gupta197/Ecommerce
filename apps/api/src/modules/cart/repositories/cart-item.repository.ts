import { Types } from 'mongoose'
import {
  CartItemModel,
  CART_ITEM_MAX_QUANTITY,
  type CartItemDocument,
} from '../models/cart-item.model.js'
import { isDuplicateKeyError } from '../lib/mongo-errors.js'

export interface CartItemKey {
  cartId: Types.ObjectId
  organizationId: Types.ObjectId
  variantId: Types.ObjectId
}

export interface IncrementOrCreateResult {
  item: CartItemDocument | null
  limitExceeded: boolean
}

// Unscoped by design: a route only ever supplies an item's own :id (no
// cartId), so cart.service.ts must look this item up before it can even
// know which cart (and therefore which customer) it belongs to. This alone
// grants no access — cart.service.ts never returns/mutates the result
// until ownership is separately re-verified via
// cartRepository.findById(customerId, item.cartId), which fails (generic
// NotFoundError) for any item that does not belong to the caller.
export async function findById(id: Types.ObjectId): Promise<CartItemDocument | null> {
  return CartItemModel.findOne({ _id: id })
}

// cartId is the mandatory scoping parameter here (CartItem's immediate
// parent — it carries no customerId of its own), the same convention every
// other module anchors on its own immediate parent (Address on customerId,
// ProductVariant on organizationId).
export async function listByCart(cartId: Types.ObjectId): Promise<CartItemDocument[]> {
  return CartItemModel.find({ cartId }).sort({ _id: 1 })
}

/**
 * Atomically increments the existing item's quantity by `amount`, or
 * creates a new item at `amount` if none exists yet for this
 * (cartId, variantId) — while enforcing the CART_ITEM_MAX_QUANTITY ceiling
 * as part of the database operation itself, never as a separate
 * "read quantity, calculate, update" sequence (mandatory COM-002
 * correction: that sequence is a concurrency race the ceiling could be
 * bypassed through).
 *
 * A single findOneAndUpdate does both jobs at once: the filter's
 * `quantity: {$lte: MAX - amount}` clause means the update only applies
 * in-place if the resulting total would stay within the ceiling; on
 * upsert-insert (no existing document to match), only the filter's
 * EQUALITY fields (cartId, variantId) seed the new document, so $inc
 * against a missing `quantity` field correctly yields `amount` for a
 * brand-new item (mirrors stock-balance.repository.ts's incrementOrCreate
 * exactly).
 *
 * If a document already exists but is already too close to the ceiling to
 * accept `amount` more, the filter no longer matches it, so `upsert: true`
 * attempts to INSERT a new document with the same (cartId, variantId) —
 * which collides with the unique index and throws a duplicate-key error.
 * That is not a bug: it is how this function detects "limit exceeded"
 * without a separate read. The catch retries as a plain (non-upsert)
 * conditional increment in case of a genuine concurrent race (e.g. another
 * request lowered the quantity in between); if that also fails to match,
 * the limit is genuinely exceeded and no write is performed.
 */
export async function incrementOrCreate(
  key: CartItemKey,
  amount: number,
): Promise<IncrementOrCreateResult> {
  const filter = {
    cartId: key.cartId,
    variantId: key.variantId,
    quantity: { $lte: CART_ITEM_MAX_QUANTITY - amount },
  }
  try {
    const updated = await CartItemModel.findOneAndUpdate(
      filter,
      {
        $inc: { quantity: amount },
        $setOnInsert: { organizationId: key.organizationId },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    )
    return { item: updated as CartItemDocument, limitExceeded: false }
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const retried = await CartItemModel.findOneAndUpdate(
        filter,
        { $inc: { quantity: amount } },
        { returnDocument: 'after' },
      )
      if (retried) {
        return { item: retried, limitExceeded: false }
      }
      return { item: null, limitExceeded: true }
    }
    throw error
  }
}

/** Replaces the quantity outright (PATCH semantics) — scoped by cartId, the
 *  ownership check cart.service.ts already performed before calling this.
 *  Returns null if the item no longer exists (race with a concurrent
 *  removal) — the caller must treat that as NotFoundError, not a no-op
 *  success. */
export async function replaceQuantity(
  cartId: Types.ObjectId,
  id: Types.ObjectId,
  quantity: number,
): Promise<CartItemDocument | null> {
  return CartItemModel.findOneAndUpdate(
    { _id: id, cartId },
    { $set: { quantity } },
    { returnDocument: 'after' },
  )
}

/** Hard delete (ADR-025) — a CartItem has no history value once removed,
 *  unlike every other soft-deleted collection in this codebase. Scoped by
 *  cartId; returns null if already removed/nonexistent. */
export async function remove(
  cartId: Types.ObjectId,
  id: Types.ObjectId,
): Promise<CartItemDocument | null> {
  return CartItemModel.findOneAndDelete({ _id: id, cartId })
}

/** Removes every item in a cart (DELETE /cart — "clear"). Idempotent: a
 *  cart with no items simply deletes zero documents. */
export async function removeAllByCart(cartId: Types.ObjectId): Promise<void> {
  await CartItemModel.deleteMany({ cartId })
}
