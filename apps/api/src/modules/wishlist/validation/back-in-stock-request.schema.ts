import { z } from 'zod'
import { objectIdSchema } from './common.schema.js'

// Same reasoning as createWishlistItemSchema — customerId/_id/status/
// timestamps are never accepted from input; status only changes through
// the dedicated cancel operation.
export const createBackInStockRequestSchema = z
  .object({
    organizationId: objectIdSchema,
    variantId: objectIdSchema,
  })
  .strict()

export type CreateBackInStockRequestInput = z.infer<typeof createBackInStockRequestSchema>
