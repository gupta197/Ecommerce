import mongoose, { Schema, type Types } from 'mongoose'

export interface StockBalanceAttrs {
  organizationId: Types.ObjectId
  locationId: Types.ObjectId
  variantId: Types.ObjectId
  quantityOnHand: number
  updatedAt: Date
}

const stockBalanceSchema = new Schema<StockBalanceAttrs>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    locationId: { type: Schema.Types.ObjectId, ref: 'Location', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', required: true },
    // min: 0 is defense-in-depth only, mirroring Organization.activeOwnerCount
    // (ADR-018) — the atomic guarded decrement in stock-balance.repository.ts
    // is the actual guarantee against a negative balance, not this validator.
    quantityOnHand: { type: Number, required: true, default: 0, min: 0 },
  },
  {
    collection: 'stock_balances',
    // Only `updatedAt` — no `createdAt` — per the locked INV-001 field list.
    // A balance row's own creation time isn't a business-relevant fact the
    // way it is for the immutable ledger; Mongoose supports timestamping a
    // single field via this object form rather than the `true` shorthand.
    timestamps: { createdAt: false, updatedAt: true },
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.__v
        return ret
      },
    },
  },
)

// This IS the primary key in all but name — exactly one balance row may
// exist per (organization, location, variant) triple.
stockBalanceSchema.index({ organizationId: 1, locationId: 1, variantId: 1 }, { unique: true })

export type StockBalanceDocument = mongoose.HydratedDocument<StockBalanceAttrs>

export const StockBalanceModel = mongoose.model<StockBalanceAttrs>(
  'StockBalance',
  stockBalanceSchema,
)
