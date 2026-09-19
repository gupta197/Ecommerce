import { z } from 'zod'
import { objectIdSchema } from './common.schema.js'

// customerId/_id/status/timestamps are all deliberately absent — customerId
// is always derived server-side from the authenticated caller's own
// Customer profile, and status only ever changes through the dedicated
// archive operation, never a general update path (this schema has no
// update variant at all: a wishlist item is only ever created or archived).
export const createWishlistItemSchema = z
  .object({
    organizationId: objectIdSchema,
    variantId: objectIdSchema,
  })
  .strict()

export type CreateWishlistItemInput = z.infer<typeof createWishlistItemSchema>
