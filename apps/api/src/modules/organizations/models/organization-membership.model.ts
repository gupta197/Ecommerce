import mongoose, { Schema, type Types } from 'mongoose'

export const MEMBERSHIP_ROLES = ['OWNER', 'ADMIN', 'MEMBER'] as const
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number]

export const MEMBERSHIP_STATUSES = ['ACTIVE', 'REMOVED'] as const
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number]

export interface OrganizationMembershipAttrs {
  organizationId: Types.ObjectId
  userId: Types.ObjectId
  role: MembershipRole
  status: MembershipStatus
  createdAt: Date
  updatedAt: Date
}

const organizationMembershipSchema = new Schema<OrganizationMembershipAttrs>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    role: { type: String, enum: MEMBERSHIP_ROLES, required: true },
    status: { type: String, enum: MEMBERSHIP_STATUSES, required: true, default: 'ACTIVE' },
  },
  {
    collection: 'organization_memberships',
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.__v
        return ret
      },
    },
  },
)

// Partial (not blanket) uniqueness: ACTIVE -> REMOVED is terminal for SEC-002,
// so re-adding a previously removed user must be possible via a brand-new
// document. Scoping uniqueness to status:'ACTIVE' permits any number of
// historical REMOVED rows for the same (organizationId, userId) pair while
// still guaranteeing at most one ACTIVE membership at a time.
organizationMembershipSchema.index(
  { organizationId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { status: 'ACTIVE' } },
)
organizationMembershipSchema.index({ userId: 1, status: 1 })
organizationMembershipSchema.index({ organizationId: 1, role: 1, status: 1 })

export type OrganizationMembershipDocument = mongoose.HydratedDocument<OrganizationMembershipAttrs>

export const OrganizationMembershipModel = mongoose.model<OrganizationMembershipAttrs>(
  'OrganizationMembership',
  organizationMembershipSchema,
)
