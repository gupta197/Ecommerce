import mongoose, { Schema, type Types } from 'mongoose'

export const CATEGORY_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const
export type CategoryStatus = (typeof CATEGORY_STATUSES)[number]

export interface CategoryAttrs {
  organizationId: Types.ObjectId
  name: string
  slug: string
  description?: string
  parentId?: Types.ObjectId | null
  status: CategoryStatus
  sortOrder: number
  createdAt: Date
  updatedAt: Date
}

const categorySchema = new Schema<CategoryAttrs>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    slug: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 2000 },
    parentId: { type: Schema.Types.ObjectId, ref: 'Category' },
    status: { type: String, enum: CATEGORY_STATUSES, required: true, default: 'DRAFT' },
    sortOrder: { type: Number, required: true, default: 0 },
  },
  {
    collection: 'categories',
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.__v
        return ret
      },
    },
  },
)

// organizationId is the leading field of both compound indexes below, so a
// separate single-field index on it would be redundant (Mongo can use a
// compound index's prefix for organizationId-only queries).
categorySchema.index({ organizationId: 1, slug: 1 }, { unique: true })
categorySchema.index({ organizationId: 1, parentId: 1, sortOrder: 1 })

export type CategoryDocument = mongoose.HydratedDocument<CategoryAttrs>

export const CategoryModel = mongoose.model<CategoryAttrs>('Category', categorySchema)
