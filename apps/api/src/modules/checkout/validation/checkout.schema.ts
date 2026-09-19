import { z } from 'zod'
import { objectIdSchema } from './common.schema.js'

// The exact same shape is used for both preview and confirm (both perform
// the identical validation walk — see checkout.service.ts). customerId,
// cartId, cartItemId, price, subtotal, total, status, orderId, timestamps,
// and any line-item data are all deliberately absent: customerId is always
// derived server-side from the authenticated caller, the cart is resolved
// server-side from (customerId, organizationId), and every monetary value
// is always server-computed, never client-supplied (CLAUDE.md §7.1/§7.2).
export const checkoutRequestSchema = z
  .object({
    organizationId: objectIdSchema,
    shippingAddressId: objectIdSchema.optional(),
    billingAddressId: objectIdSchema.optional(),
  })
  .strict()

export type CheckoutRequestInput = z.infer<typeof checkoutRequestSchema>
