import mongoose, { Schema, type Types } from 'mongoose'

export const PRODUCT_VARIANT_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const
export type ProductVariantStatus = (typeof PRODUCT_VARIANT_STATUSES)[number]

export interface ProductVariantAttribute {
  key: string
  value: string | number | boolean
}

export interface ProductVariantAttrs {
  organizationId: Types.ObjectId
  productId: Types.ObjectId
  sku: string
  barcode?: string
  price: number
  compareAtPrice?: number
  cost?: number
  attributes?: ProductVariantAttribute[]
  status: ProductVariantStatus
  createdAt: Date
  updatedAt: Date
}

const MAX_ATTRIBUTES = 30

// value is intentionally Mixed at the Mongoose layer — the string|number|boolean
// union, the 30-item cap, and the __proto__/constructor/prototype key ban are
// all enforced by Zod before any document reaches this schema (see
// validation/product-variant.schema.ts). Mirrors SEC-003's SafeMetadata
// precedent: Mongoose Mixed has no runtime scalar enforcement of its own, so
// the validation layer, not the schema, is the actual guarantee.
const productVariantAttributeSchema = new Schema<ProductVariantAttribute>(
  {
    key: { type: String, required: true, trim: true, maxlength: 50 },
    value: { type: Schema.Types.Mixed, required: true },
  },
  { _id: false },
)

const productVariantSchema = new Schema<ProductVariantAttrs>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    // Normalized (trimmed, uppercased) by the Zod layer before this is ever
    // persisted — see validation/product-variant.schema.ts's skuSchema.
    sku: { type: String, required: true, trim: true, maxlength: 64 },
    barcode: { type: String, trim: true, maxlength: 64 },
    // Integer minor units (e.g. paise), per ADR-008 and db/README.md's
    // existing "Money and dates" convention — not new architecture.
    price: { type: Number, required: true, min: 0 },
    compareAtPrice: { type: Number, min: 0 },
    cost: { type: Number, min: 0 },
    attributes: {
      type: [productVariantAttributeSchema],
      default: undefined,
      validate: {
        validator: (value: ProductVariantAttribute[] | undefined) =>
          !value || value.length <= MAX_ATTRIBUTES,
        message: `A product variant may have at most ${MAX_ATTRIBUTES} attributes.`,
      },
    },
    status: { type: String, enum: PRODUCT_VARIANT_STATUSES, required: true, default: 'DRAFT' },
  },
  {
    collection: 'product_variants',
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.__v
        return ret
      },
    },
  },
)

// organizationId leads every compound index below, so a separate
// organizationId-only index would be redundant (same reasoning as
// category.model.ts/product.model.ts).
productVariantSchema.index({ organizationId: 1, sku: 1 }, { unique: true })
// A plain `sparse: true` on a COMPOUND index only excludes a document that is
// missing *every* indexed field — since organizationId is always present,
// sparse alone would never exclude a barcode-less variant, and two such
// variants would collide on `barcode: null`. A partial index scoped to
// `barcode: { $exists: true }` is the correct construct for "unique only
// among documents that actually have this field" — the same partial-index
// technique organization-membership.model.ts already uses for its own
// status-scoped uniqueness.
productVariantSchema.index(
  { organizationId: 1, barcode: 1 },
  { unique: true, partialFilterExpression: { barcode: { $exists: true } } },
)
productVariantSchema.index({ organizationId: 1, productId: 1, status: 1 })

export type ProductVariantDocument = mongoose.HydratedDocument<ProductVariantAttrs>

export const ProductVariantModel = mongoose.model<ProductVariantAttrs>(
  'ProductVariant',
  productVariantSchema,
)
