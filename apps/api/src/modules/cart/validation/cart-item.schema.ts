import { z } from 'zod'
import { objectIdSchema } from './common.schema.js'
import { CART_ITEM_MIN_QUANTITY, CART_ITEM_MAX_QUANTITY } from '../models/cart-item.model.js'

// Same shape as CAT-004's money/quantity fields: .finite() rejects
// +/-Infinity, .int() rejects fractional values, and Zod's own z.number()
// already rejects NaN before either of those runs. The 1..9999 ceiling is
// also enforced atomically at the repository/database layer for POST's
// additive increment (see cart-item.repository.ts) — this schema bound
// alone is not sufficient to prevent a concurrent-increment race from
// exceeding it.
const quantitySchema = z
  .number()
  .finite()
  .int()
  .min(CART_ITEM_MIN_QUANTITY)
  .max(CART_ITEM_MAX_QUANTITY)

// customerId/cartId/_id/price/subtotal/total/status/timestamps are all
// deliberately absent — customerId is always derived server-side from the
// authenticated caller's own Customer profile, cartId is resolved
// server-side from (customerId, organizationId), and price/subtotal/total
// are always server-computed, never client-supplied (CLAUDE.md §7.1).
export const addCartItemSchema = z
  .object({
    organizationId: objectIdSchema,
    variantId: objectIdSchema,
    quantity: quantitySchema,
  })
  .strict()

export type AddCartItemInput = z.infer<typeof addCartItemSchema>

// organizationId is deliberately absent here — PATCH operates on an
// existing CartItem addressed by :id alone; ownership is re-resolved
// server-side via the item's own cartId, never re-supplied by the client.
export const updateCartItemQuantitySchema = z
  .object({
    quantity: quantitySchema,
  })
  .strict()

export type UpdateCartItemQuantityInput = z.infer<typeof updateCartItemQuantitySchema>
