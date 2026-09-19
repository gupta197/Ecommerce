import mongoose, { Schema, type Types } from 'mongoose'

export interface CartAttrs {
  customerId: Types.ObjectId
  organizationId: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const cartSchema = new Schema<CartAttrs>(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    // No ref: 'Organization' — matches every other module's cross-tenant
    // organizationId convention (Category/Brand/Product/Variant/Location/
    // WishlistItem/BackInStockRequest/etc).
    organizationId: { type: Schema.Types.ObjectId, required: true },
    // Deliberately no `status`/lifecycle field (ADR-025, COM-002): no
    // concrete state transition exists yet for Cart to model — a future
    // COM-003 CHECKED_OUT-style transition can be added additively when it
    // is actually needed, the same discipline already applied elsewhere in
    // this codebase (e.g. no speculative fields on InventoryTransaction).
  },
  {
    collection: 'carts',
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.__v
        return ret
      },
    },
  },
)

// One Cart per customer per organization — this is the actual concurrency
// guarantee behind cart.repository.ts's atomic findOrCreate, not merely a
// performance index. A cart can never span multiple organizations by
// construction: every item add validates its variant against this same
// organizationId (see cart.service.ts).
cartSchema.index({ customerId: 1, organizationId: 1 }, { unique: true })

export type CartDocument = mongoose.HydratedDocument<CartAttrs>

export const CartModel = mongoose.model<CartAttrs>('Cart', cartSchema)
