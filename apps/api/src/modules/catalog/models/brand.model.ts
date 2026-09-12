import mongoose, { Schema, type Types } from 'mongoose'

export const BRAND_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const
export type BrandStatus = (typeof BRAND_STATUSES)[number]

export interface BrandLogo {
  url: string
  altText?: string
}

export interface BrandAttrs {
  organizationId: Types.ObjectId
  name: string
  slug: string
  description?: string
  logo?: BrandLogo
  status: BrandStatus
  createdAt: Date
  updatedAt: Date
}

const brandLogoSchema = new Schema<BrandLogo>(
  {
    url: { type: String, required: true },
    altText: { type: String, trim: true, maxlength: 200 },
  },
  { _id: false },
)

const brandSchema = new Schema<BrandAttrs>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    slug: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 2000 },
    logo: { type: brandLogoSchema, required: false },
    status: { type: String, enum: BRAND_STATUSES, required: true, default: 'DRAFT' },
  },
  {
    collection: 'brands',
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.__v
        return ret
      },
    },
  },
)

// Brand has no hierarchy (unlike Category), so there is only one index here.
brandSchema.index({ organizationId: 1, slug: 1 }, { unique: true })

export type BrandDocument = mongoose.HydratedDocument<BrandAttrs>

export const BrandModel = mongoose.model<BrandAttrs>('Brand', brandSchema)
