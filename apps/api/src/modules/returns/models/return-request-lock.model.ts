import mongoose, { Schema, type Types } from 'mongoose'

/**
 * A pure transactional-serialization point — NOT a cache of any quantity
 * total, and not itself part of the return-request data model at all. It
 * stores no counter, so it can never go stale with respect to a future
 * approve/reject decision (neither of which exists in this tranche).
 *
 * Why this is needed: the return-quantity-integrity invariant ("sum of
 * quantities across every existing non-rejected ReturnRequest for this
 * order + the new request's own quantities must not exceed what was
 * purchased") spans MULTIPLE ReturnRequest documents. MongoDB's
 * transaction isolation does not, by itself, serialize two concurrent
 * transactions that each INSERT a different new document — there is no
 * shared document for the storage engine to detect a write conflict on,
 * unlike an UPDATE against an existing one. Touching this one
 * upsert-per-orderId document, inside the same transaction, BEFORE reading
 * the existing ReturnRequests, gives MongoDB exactly that shared point of
 * contention: two concurrent return-request submissions against the same
 * order genuinely conflict here, the loser's transaction is retried
 * automatically by the driver (the identical mechanism already proven safe
 * for COM-003's own concurrent-checkout-confirm race), and the retry's
 * fresh read then sees the winner's already-committed request.
 */
export interface ReturnRequestLockAttrs {
  orderId: Types.ObjectId
  createdAt: Date
}

const returnRequestLockSchema = new Schema<ReturnRequestLockAttrs>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
  },
  {
    collection: 'return_request_locks',
    timestamps: { createdAt: true, updatedAt: false },
  },
)

returnRequestLockSchema.index({ orderId: 1 }, { unique: true })

export type ReturnRequestLockDocument = mongoose.HydratedDocument<ReturnRequestLockAttrs>

export const ReturnRequestLockModel = mongoose.model<ReturnRequestLockAttrs>(
  'ReturnRequestLock',
  returnRequestLockSchema,
)
