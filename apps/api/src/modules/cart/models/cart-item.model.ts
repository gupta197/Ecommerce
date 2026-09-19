import mongoose, { Schema, type Types } from 'mongoose'

export const CART_ITEM_MIN_QUANTITY = 1
export const CART_ITEM_MAX_QUANTITY = 9999

export interface CartItemAttrs {
  cartId: Types.ObjectId
  organizationId: Types.ObjectId
  variantId: Types.ObjectId
  quantity: number
  createdAt: Date
  updatedAt: Date
}

const cartItemSchema = new Schema<CartItemAttrs>(
  {
    cartId: { type: Schema.Types.ObjectId, ref: 'Cart', required: true },
    // Denormalized from the parent Cart (which itself denormalizes it from
    // the variant reference) so every scoped operation avoids an extra
    // join — the same reasoning InventoryTransaction already uses for its
    // own organizationId despite it being reachable via locationId/variantId.
    organizationId: { type: Schema.Types.ObjectId, required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', required: true },
    // No price/name/SKU/attribute snapshot (ADR-025): the current price
    // must always be resolved live from ProductVariant so
    // "Cart totals are server-authoritative" reflects the CURRENT price,
    // never a stale value captured at add-time. A price snapshot belongs
    // to a future Order (immutable, for traceability), not to an active Cart.
    quantity: {
      type: Number,
      required: true,
      min: CART_ITEM_MIN_QUANTITY,
      max: CART_ITEM_MAX_QUANTITY,
    },
  },
  {
    collection: 'cart_items',
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.__v
        return ret
      },
    },
  },
)

// At most one row per variant per cart — the guarantee behind "adding an
// already-present variant atomically increments its quantity instead of
// creating a duplicate row" (see cart-item.repository.ts's incrementOrCreate).
// A PLAIN unique index is correct here (unlike WishlistItem/BackInStockRequest's
// partial indexes) because CartItem removal is a hard delete, not a soft
// one (ADR-025) — once a row is removed it is genuinely gone, so re-adding
// the same variant later never collides with a stale soft-deleted row.
cartItemSchema.index({ cartId: 1, variantId: 1 }, { unique: true })

export type CartItemDocument = mongoose.HydratedDocument<CartItemAttrs>

export const CartItemModel = mongoose.model<CartItemAttrs>('CartItem', cartItemSchema)
