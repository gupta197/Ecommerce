import mongoose, { Schema } from 'mongoose'

export const USER_STATUSES = ['ACTIVE', 'DISABLED'] as const
export type UserStatus = (typeof USER_STATUSES)[number]

export interface UserAttrs {
  email: string
  passwordHash: string
  status: UserStatus
  failedLoginAttempts: number
  nextAttemptAllowedAt?: Date | null
  createdAt: Date
  updatedAt: Date
}

const userSchema = new Schema<UserAttrs>(
  {
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 320 },
    // select: false — passwordHash is never returned unless explicitly requested
    // (e.g. `.select('+passwordHash')` for login verification), independent of
    // the toJSON transform below which also strips it from any serialized output.
    passwordHash: { type: String, required: true, select: false },
    status: { type: String, enum: USER_STATUSES, required: true, default: 'ACTIVE' },
    failedLoginAttempts: { type: Number, required: true, default: 0 },
    nextAttemptAllowedAt: { type: Date, default: null },
  },
  {
    collection: 'users',
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.__v
        delete ret.passwordHash
        return ret
      },
    },
  },
)

userSchema.index({ email: 1 }, { unique: true })

export type UserDocument = mongoose.HydratedDocument<UserAttrs>

export const UserModel = mongoose.model<UserAttrs>('User', userSchema)
