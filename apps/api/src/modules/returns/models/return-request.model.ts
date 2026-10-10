import mongoose, { Schema, type Types } from 'mongoose'

// Full status enum for the ReturnRequest workflow, per ADR-027: PENDING ->
// APPROVED|REJECTED (terminal) ; APPROVED -> RECEIVED (terminal). COM-004
// Tranche A only ever creates PENDING requests — no service/route in this
// tranche ever transitions a request away from PENDING (that is an
// explicitly deferred Tranche B / staff-decision requirement, see
// returns/README.md). The enum is defined in full now because the data
// model and the quantity-integrity check (return-request.repository.ts's
// sumNonRejectedQuantitiesByVariant) both need to reason about every status
// value, even though only PENDING is reachable through any code path today.
export const RETURN_REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'RECEIVED'] as const
export type ReturnRequestStatus = (typeof RETURN_REQUEST_STATUSES)[number]

export interface ReturnItemAttrs {
  variantId: Types.ObjectId
  quantity: number
}

export interface ReturnRequestAttrs {
  orderId: Types.ObjectId
  customerId: Types.ObjectId
  // Denormalized from the parent Order (itself immutable) purely for query
  // convenience — the same denormalization precedent CartItem/
  // InventoryTransaction already established for their own parent references.
  organizationId: Types.ObjectId
  items: ReturnItemAttrs[]
  // Free-text, bounded — no fixed reason taxonomy is defined by any existing
  // Planning/ADR evidence; enforcing an enum here would be inventing an
  // unapproved business rule.
  reason: string
  status: ReturnRequestStatus
  requestedAt: Date
  createdAt: Date
  updatedAt: Date
}

const returnItemSchema = new Schema<ReturnItemAttrs>(
  {
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', required: true },
    quantity: { type: Number, required: true, min: 1 },
  },
  { _id: false },
)

const REASON_MAX_LENGTH = 500

const returnRequestSchema = new Schema<ReturnRequestAttrs>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    organizationId: { type: Schema.Types.ObjectId, required: true },
    items: {
      type: [returnItemSchema],
      required: true,
      validate: {
        validator: (items: ReturnItemAttrs[]) => items.length > 0,
        message: 'A return request must contain at least one item',
      },
    },
    reason: { type: String, required: true, trim: true, maxlength: REASON_MAX_LENGTH },
    status: { type: String, enum: RETURN_REQUEST_STATUSES, required: true, default: 'PENDING' },
    requestedAt: { type: Date, required: true, default: () => new Date() },
  },
  {
    collection: 'return_requests',
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.__v
        return ret
      },
    },
  },
)

// {orderId}: the one real query pattern this tranche needs — "every
// non-rejected return request against this order" (the quantity-integrity
// check) and "this order's own return history" (GET .../orders/:id/returns).
returnRequestSchema.index({ orderId: 1 })
// {customerId}: "this customer's own returns across every order" — not
// exposed by a dedicated route in this tranche, but the natural analog of
// Order's own {customerId, createdAt} index, forward-justified the same way.
returnRequestSchema.index({ customerId: 1, createdAt: -1 })

export type ReturnRequestDocument = mongoose.HydratedDocument<ReturnRequestAttrs>

export const ReturnRequestModel = mongoose.model<ReturnRequestAttrs>(
  'ReturnRequest',
  returnRequestSchema,
)
