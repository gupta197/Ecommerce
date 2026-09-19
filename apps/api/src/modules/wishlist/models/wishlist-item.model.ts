import mongoose, { Schema, type Types } from 'mongoose'

export const WISHLIST_ITEM_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
export type WishlistItemStatus = (typeof WISHLIST_ITEM_STATUSES)[number]

export interface WishlistItemAttrs {
  customerId: Types.ObjectId
  organizationId: Types.ObjectId
  variantId: Types.ObjectId
  status: WishlistItemStatus
  createdAt: Date
  updatedAt: Date
}

const wishlistItemSchema = new Schema<WishlistItemAttrs>(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    // No ref: 'Organization' — matches every other module's cross-tenant
    // organizationId convention (Category/Brand/Product/Variant/Location/etc).
    organizationId: { type: Schema.Types.ObjectId, required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', required: true },
    status: { type: String, enum: WISHLIST_ITEM_STATUSES, required: true, default: 'ACTIVE' },
  },
  {
    collection: 'wishlist_items',
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.__v
        return ret
      },
    },
  },
)

// Deliberately NOT a plain {customerId, variantId} unique index — WishlistItem
// is soft-deleted (ACTIVE -> ARCHIVED), so a customer must be able to
// re-add a variant after removing it. A partial unique index scoped to
// status:'ACTIVE' enforces "at most one ACTIVE item per customer+variant"
// while leaving any number of ARCHIVED (removed) rows for the same pair.
wishlistItemSchema.index(
  { customerId: 1, variantId: 1 },
  { unique: true, partialFilterExpression: { status: 'ACTIVE' } },
)
// Listing index: the one real query pattern ("this customer's wishlist").
wishlistItemSchema.index({ customerId: 1 })

export type WishlistItemDocument = mongoose.HydratedDocument<WishlistItemAttrs>

export const WishlistItemModel = mongoose.model<WishlistItemAttrs>(
  'WishlistItem',
  wishlistItemSchema,
)
