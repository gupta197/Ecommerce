import mongoose, { Schema, type Types } from 'mongoose'

export const CUSTOMER_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number]

export interface CustomerAttrs {
  userId: Types.ObjectId
  firstName: string
  lastName: string
  displayName?: string
  phone?: string
  status: CustomerStatus
  createdAt: Date
  updatedAt: Date
}

const customerSchema = new Schema<CustomerAttrs>(
  {
    // No ref: 'Organization' anywhere in this module — Customer is a
    // deliberately global entity (approved decision), not organization-owned
    // like Category/Brand/Product/Variant. userId gets a ref since it is a
    // same-tenant-model reference within this module's own domain.
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    firstName: { type: String, required: true, trim: true, maxlength: 100 },
    lastName: { type: String, required: true, trim: true, maxlength: 100 },
    displayName: { type: String, trim: true, maxlength: 100 },
    phone: { type: String, trim: true, maxlength: 20 },
    status: { type: String, enum: CUSTOMER_STATUSES, required: true, default: 'ACTIVE' },
  },
  {
    collection: 'customers',
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.__v
        return ret
      },
    },
  },
)

// Enforces the 1:1 relationship with User — the actual guarantee, not just a
// convention. Never queried by anything else, so no compound index is needed.
customerSchema.index({ userId: 1 }, { unique: true })

export type CustomerDocument = mongoose.HydratedDocument<CustomerAttrs>

export const CustomerModel = mongoose.model<CustomerAttrs>('Customer', customerSchema)
