import mongoose, { Schema } from 'mongoose'

export const ORGANIZATION_STATUSES = ['ACTIVE', 'SUSPENDED'] as const
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number]

export interface OrganizationAttrs {
  name: string
  status: OrganizationStatus
  // Denormalized count of ACTIVE memberships with role OWNER. Maintained
  // exclusively via atomic guarded increments/decrements (see
  // repositories/organization.repository.ts) — never set directly from a
  // patch/update payload. This is the concurrency-coordination mechanism for
  // last-owner protection, not just an informational counter.
  activeOwnerCount: number
  createdAt: Date
  updatedAt: Date
}

const organizationSchema = new Schema<OrganizationAttrs>(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    status: { type: String, enum: ORGANIZATION_STATUSES, required: true, default: 'ACTIVE' },
    activeOwnerCount: { type: Number, required: true, default: 0 },
  },
  {
    collection: 'organizations',
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.__v
        return ret
      },
    },
  },
)

export type OrganizationDocument = mongoose.HydratedDocument<OrganizationAttrs>

export const OrganizationModel = mongoose.model<OrganizationAttrs>(
  'Organization',
  organizationSchema,
)
