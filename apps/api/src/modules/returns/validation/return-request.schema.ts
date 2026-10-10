import { z } from 'zod'
import { objectIdSchema, paginationSchema } from './common.schema.js'

const REASON_MAX_LENGTH = 500
const MAX_ITEMS_PER_REQUEST = 50

// Mirrors CAT-004/INV-001/COM-002's own quantity convention exactly:
// .finite() rejects NaN/Infinity, .int() rejects fractional values,
// .positive() rejects zero/negative.
const returnQuantitySchema = z.number().finite().int().positive()

const returnItemInputSchema = z
  .object({
    variantId: objectIdSchema,
    quantity: returnQuantitySchema,
  })
  .strict()

// Rejects a request naming the same variantId more than once — mirrors
// product-variant.schema.ts's own productVariantAttributesSchema duplicate-
// key convention exactly (a Set-based scan inside .refine()). Without this,
// a single request could list one variantId twice (e.g. two entries each
// within the purchased quantity individually, but exceeding it combined)
// and defeat the purchased-quantity/cumulative-quantity checks below, which
// — before this fix — validated each array entry independently rather than
// their sum (COM-004 security review finding F-1). Case-insensitive since
// ObjectId hex strings are case-insensitive.
const uniqueVariantIdsSchema = z
  .array(returnItemInputSchema)
  .min(1)
  .max(MAX_ITEMS_PER_REQUEST)
  .refine(
    (items) => {
      const seen = new Set<string>()
      for (const item of items) {
        const key = item.variantId.toLowerCase()
        if (seen.has(key)) {
          return false
        }
        seen.add(key)
      }
      return true
    },
    { message: 'Duplicate variantId entries are not allowed in a single return request' },
  )

// orderId comes from the URL (:id), never the body. customerId/
// organizationId/status/decidedAt/receivedAt/any Order snapshot field are
// all deliberately absent — a return request can only ever name WHAT is
// being returned (variantId + quantity) and WHY (reason); everything else
// is server-resolved from the authenticated customer and the Order itself.
export const createReturnRequestSchema = z
  .object({
    items: uniqueVariantIdsSchema,
    reason: z.string().trim().min(1).max(REASON_MAX_LENGTH),
  })
  .strict()

export type CreateReturnRequestInput = z.infer<typeof createReturnRequestSchema>

export const listReturnRequestsQuerySchema = paginationSchema.strict()

export type ListReturnRequestsQueryInput = z.infer<typeof listReturnRequestsQuerySchema>
