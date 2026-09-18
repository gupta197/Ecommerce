import mongoose, { Schema, type Types } from 'mongoose'

export const PRODUCT_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const
export type ProductStatus = (typeof PRODUCT_STATUSES)[number]

export interface ProductMedia {
  url: string
  altText?: string
}

export interface ProductAttrs {
  organizationId: Types.ObjectId
  name: string
  slug: string
  description?: string
  categoryId?: Types.ObjectId
  brandId?: Types.ObjectId
  media?: ProductMedia[]
  status: ProductStatus
  createdAt: Date
  updatedAt: Date
}

const productMediaSchema = new Schema<ProductMedia>(
  {
    url: { type: String, required: true },
    altText: { type: String, trim: true, maxlength: 200 },
  },
  { _id: false },
)

const productSchema = new Schema<ProductAttrs>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    slug: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 2000 },
    // Same-module refs (like Category's own self-referencing parentId) get
    // a `ref` for Mongoose's benefit; the cross-tenant organizationId above
    // deliberately does not, matching Category/Brand's existing pattern.
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category' },
    brandId: { type: Schema.Types.ObjectId, ref: 'Brand' },
    // No SKU/barcode/price/compare-at price/cost/inventory/attributes here —
    // CLAUDE.md §6.2 and the CAT-004 task row assign all of those to
    // ProductVariant (CAT-004), not Product. See catalog/README.md.
    media: {
      type: [productMediaSchema],
      default: undefined,
      validate: {
        validator: (value: ProductMedia[] | undefined) => !value || value.length <= 10,
        message: 'A product may have at most 10 media items.',
      },
    },
    status: { type: String, enum: PRODUCT_STATUSES, required: true, default: 'DRAFT' },
  },
  {
    collection: 'products',
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.__v
        return ret
      },
    },
  },
)

// organizationId leads both compound indexes below, so a separate
// organizationId-only index would be redundant (same reasoning as
// category.model.ts).
productSchema.index({ organizationId: 1, slug: 1 }, { unique: true })
productSchema.index({ organizationId: 1, categoryId: 1, status: 1 })
productSchema.index({ organizationId: 1, brandId: 1, status: 1 })

export type ProductDocument = mongoose.HydratedDocument<ProductAttrs>

export const ProductModel = mongoose.model<ProductAttrs>('Product', productSchema)
