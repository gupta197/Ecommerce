import mongoose, { Schema, type Types } from 'mongoose'

export const LOGIN_ATTEMPT_REASONS = [
  'INVALID_CREDENTIALS',
  'ACCOUNT_DISABLED',
  'THROTTLED',
] as const
export type LoginAttemptReason = (typeof LOGIN_ATTEMPT_REASONS)[number]

export interface LoginAttemptAttrs {
  email: string
  userId?: Types.ObjectId
  success: boolean
  reason?: LoginAttemptReason
  ipAddress?: string
  userAgent?: string
  createdAt: Date
}

const RETENTION_SECONDS = 90 * 24 * 60 * 60 // 90 days

const loginAttemptSchema = new Schema<LoginAttemptAttrs>(
  {
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 320 },
    userId: { type: Schema.Types.ObjectId },
    success: { type: Boolean, required: true },
    reason: { type: String, enum: LOGIN_ATTEMPT_REASONS },
    ipAddress: { type: String },
    userAgent: { type: String },
  },
  {
    collection: 'login_attempts',
    timestamps: { createdAt: true, updatedAt: false },
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.__v
        return ret
      },
    },
  },
)

loginAttemptSchema.index({ email: 1, createdAt: -1 })
// 90 days: long enough for meaningful security review after the fact, short
// enough to bound data-minimization exposure of IP/user-agent/email — see
// modules/auth/README.md for the full reasoning.
loginAttemptSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS })

export type LoginAttemptDocument = mongoose.HydratedDocument<LoginAttemptAttrs>

export const LoginAttemptModel = mongoose.model<LoginAttemptAttrs>(
  'LoginAttempt',
  loginAttemptSchema,
)
