import mongoose, { Schema, type Types } from 'mongoose'

export const INVENTORY_TRANSACTION_TYPES = [
  'PURCHASE',
  'SALE',
  'RETURN',
  'ADJUSTMENT',
  'DAMAGE',
  'OPENING_BALANCE',
  'TRANSFER_IN',
  'TRANSFER_OUT',
] as const
export type InventoryTransactionType = (typeof INVENTORY_TRANSACTION_TYPES)[number]

export const ADJUSTMENT_DIRECTIONS = ['INCREASE', 'DECREASE'] as const
export type AdjustmentDirection = (typeof ADJUSTMENT_DIRECTIONS)[number]

export interface InventoryTransactionAttrs {
  organizationId: Types.ObjectId
  locationId: Types.ObjectId
  variantId: Types.ObjectId
  type: InventoryTransactionType
  quantity: number
  adjustmentDirection?: AdjustmentDirection
  note?: string
  createdAt: Date
}

const inventoryTransactionSchema = new Schema<InventoryTransactionAttrs>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    locationId: { type: Schema.Types.ObjectId, ref: 'Location', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', required: true },
    // TRANSFER_IN/TRANSFER_OUT are valid stored values (written only by
    // recordTransfer()) even though recordTransaction()'s own input schema
    // rejects them — see validation/inventory-transaction.schema.ts.
    type: { type: String, enum: INVENTORY_TRANSACTION_TYPES, required: true },
    // min: 1 is defense-in-depth mirroring the Zod layer's .positive() check
    // — a transaction's magnitude is always a positive count, direction is
    // carried by `type`/`adjustmentDirection`, never by the sign of `quantity`.
    quantity: { type: Number, required: true, min: 1 },
    adjustmentDirection: {
      type: String,
      enum: ADJUSTMENT_DIRECTIONS,
      // A conditional `required` function, not just a custom validator:
      // Mongoose skips calling a plain path validator when the value is
      // `undefined` (the "missing" case), so the "must be present for
      // ADJUSTMENT" half has to be expressed via `required`, which is
      // specifically designed to be evaluated even when the value is absent.
      required: function (this: InventoryTransactionAttrs) {
        return this.type === 'ADJUSTMENT'
      },
    },
    note: { type: String, trim: true, maxlength: 500 },
  },
  {
    collection: 'inventory_transactions',
    // Only `createdAt` — this document is never modified after creation.
    timestamps: { createdAt: true, updatedAt: false },
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.__v
        return ret
      },
    },
  },
)

// The other half of the defense-in-depth mirror of the Zod layer's
// superRefine: adjustmentDirection must be ABSENT for every non-ADJUSTMENT
// type (the `required` function above only enforces presence, not absence).
// This validator does run for this case, since it only needs to fire when a
// value is actually present. The Zod schema is the actual guarantee for
// anything reaching this model through recordTransaction()/recordTransfer();
// this protects against a direct model-level write bypassing that layer.
inventoryTransactionSchema.path('adjustmentDirection').validate(function (
  this: InventoryTransactionAttrs,
  value: AdjustmentDirection | undefined,
) {
  return this.type === 'ADJUSTMENT' ? true : value === undefined
}, 'adjustmentDirection is only valid for ADJUSTMENT transactions')

inventoryTransactionSchema.index({ organizationId: 1, variantId: 1, locationId: 1, createdAt: -1 })
inventoryTransactionSchema.index({ organizationId: 1, createdAt: -1 })

export type InventoryTransactionDocument = mongoose.HydratedDocument<InventoryTransactionAttrs>

export const InventoryTransactionModel = mongoose.model<InventoryTransactionAttrs>(
  'InventoryTransaction',
  inventoryTransactionSchema,
)
