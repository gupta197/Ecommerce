import mongoose, { Schema, type Types } from 'mongoose'

export const BACK_IN_STOCK_REQUEST_STATUSES = ['PENDING', 'CANCELLED'] as const
export type BackInStockRequestStatus = (typeof BACK_IN_STOCK_REQUEST_STATUSES)[number]

export interface BackInStockRequestAttrs {
  customerId: Types.ObjectId
  organizationId: Types.ObjectId
  variantId: Types.ObjectId
  status: BackInStockRequestStatus
  createdAt: Date
  updatedAt: Date
}

const backInStockRequestSchema = new Schema<BackInStockRequestAttrs>(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    organizationId: { type: Schema.Types.ObjectId, required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', required: true },
    // No FULFILLED — fulfillment detection/notification delivery is
    // explicitly out of scope for COM-001 (no queue/provider infrastructure
    // exists yet). Only the request itself is tracked.
    status: {
      type: String,
      enum: BACK_IN_STOCK_REQUEST_STATUSES,
      required: true,
      default: 'PENDING',
    },
  },
  {
    collection: 'back_in_stock_requests',
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.__v
        return ret
      },
    },
  },
)

// Partial unique index scoped to status:'PENDING' — at most one active
// request per customer+variant, while a CANCELLED request never blocks a
// new PENDING one for the same pair. Same technique as WishlistItem's own
// ACTIVE-scoped index above.
backInStockRequestSchema.index(
  { customerId: 1, variantId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'PENDING' } },
)
// Listing index: "this customer's requests" (both PENDING and CANCELLED —
// unlike WishlistItem, a customer's own request history is meaningful).
backInStockRequestSchema.index({ customerId: 1 })
// Forward-justified (not speculative): the exact query a future
// notification-dispatch task will need — "who is waiting for variant X in
// organization Y" — is the entire reason this collection exists.
backInStockRequestSchema.index({ organizationId: 1, variantId: 1, status: 1 })

export type BackInStockRequestDocument = mongoose.HydratedDocument<BackInStockRequestAttrs>

export const BackInStockRequestModel = mongoose.model<BackInStockRequestAttrs>(
  'BackInStockRequest',
  backInStockRequestSchema,
)
