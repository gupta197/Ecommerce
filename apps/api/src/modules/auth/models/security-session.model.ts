import mongoose, { Schema, type Types } from 'mongoose'

export const SECURITY_SESSION_STATUSES = ['ACTIVE', 'ROTATED', 'REVOKED'] as const
export type SecuritySessionStatus = (typeof SECURITY_SESSION_STATUSES)[number]

export interface SecuritySessionAttrs {
  userId: Types.ObjectId
  familyId: Types.ObjectId
  familyCreatedAt: Date
  refreshTokenHash: string
  status: SecuritySessionStatus
  ipAddress?: string
  userAgent?: string
  lastUsedAt: Date
  rotatedAt?: Date
  revokedAt?: Date
  expiresAt: Date
  createdAt: Date
  updatedAt: Date
}

const securitySessionSchema = new Schema<SecuritySessionAttrs>(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    familyId: { type: Schema.Types.ObjectId, required: true },
    familyCreatedAt: { type: Date, required: true },
    refreshTokenHash: { type: String, required: true },
    status: {
      type: String,
      enum: SECURITY_SESSION_STATUSES,
      required: true,
      default: 'ACTIVE',
    },
    ipAddress: { type: String },
    userAgent: { type: String },
    lastUsedAt: { type: Date, required: true },
    rotatedAt: { type: Date },
    revokedAt: { type: Date },
    expiresAt: { type: Date, required: true },
  },
  {
    collection: 'security_sessions',
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.__v
        delete ret.refreshTokenHash
        return ret
      },
    },
  },
)

securitySessionSchema.index({ refreshTokenHash: 1 }, { unique: true })
securitySessionSchema.index({ userId: 1, status: 1 })
securitySessionSchema.index({ familyId: 1 })
// TTL: MongoDB's background TTL monitor deletes documents once expiresAt is in
// the past — automatic cleanup, no cron job. Runs periodically (not
// instantaneously), so application code must still treat an ACTIVE-but-
// expired session as invalid rather than assuming TTL has already removed it.
securitySessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export type SecuritySessionDocument = mongoose.HydratedDocument<SecuritySessionAttrs>

export const SecuritySessionModel = mongoose.model<SecuritySessionAttrs>(
  'SecuritySession',
  securitySessionSchema,
)
