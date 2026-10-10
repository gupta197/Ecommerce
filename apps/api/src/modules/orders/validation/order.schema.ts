import { z } from 'zod'
import { objectIdSchema, paginationSchema } from './common.schema.js'
import { ORDER_STATUSES } from '../models/order.model.js'

const CANCELLATION_REASON_MAX_LENGTH = 500

// customerId/status/cancelledAt and every other server-controlled field are
// deliberately absent — the only client input a cancellation can ever
// supply is an optional free-text reason. The target order is always
// resolved from the URL's :id plus the authenticated customer, never from
// the body.
export const cancelOrderSchema = z
  .object({
    reason: z.string().trim().min(1).max(CANCELLATION_REASON_MAX_LENGTH).optional(),
  })
  .strict()

export type CancelOrderInput = z.infer<typeof cancelOrderSchema>

// Query-string input is always a string (or absent) at the Express layer —
// z.coerce on pagination's own fields already handles that; status/
// organizationId are plain enum/ObjectId strings, never coerced.
export const listOrdersQuerySchema = paginationSchema
  .extend({
    status: z.enum(ORDER_STATUSES).optional(),
    organizationId: objectIdSchema.optional(),
  })
  .strict()

export type ListOrdersQueryInput = z.infer<typeof listOrdersQuerySchema>
