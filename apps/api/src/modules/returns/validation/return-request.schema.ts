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

// orderId comes from the URL (:id), never the body. customerId/
// organizationId/status/decidedAt/receivedAt/any Order snapshot field are
// all deliberately absent — a return request can only ever name WHAT is
// being returned (variantId + quantity) and WHY (reason); everything else
// is server-resolved from the authenticated customer and the Order itself.
export const createReturnRequestSchema = z
  .object({
    items: z.array(returnItemInputSchema).min(1).max(MAX_ITEMS_PER_REQUEST),
    reason: z.string().trim().min(1).max(REASON_MAX_LENGTH),
  })
  .strict()

export type CreateReturnRequestInput = z.infer<typeof createReturnRequestSchema>

export const listReturnRequestsQuerySchema = paginationSchema.strict()

export type ListReturnRequestsQueryInput = z.infer<typeof listReturnRequestsQuerySchema>
