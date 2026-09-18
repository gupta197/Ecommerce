import mongoose, { Schema, type Types } from 'mongoose'

export const LOCATION_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
export type LocationStatus = (typeof LOCATION_STATUSES)[number]

export interface LocationAttrs {
  organizationId: Types.ObjectId
  name: string
  code?: string
  status: LocationStatus
  createdAt: Date
  updatedAt: Date
}

const locationSchema = new Schema<LocationAttrs>(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    code: { type: String, trim: true, maxlength: 50 },
    // No DRAFT — a location is either usable or decommissioned, unlike a
    // catalog entity that can be authored before publishing (locked CAT-004
    // review decision, applied to Location as well).
    status: { type: String, enum: LOCATION_STATUSES, required: true, default: 'ACTIVE' },
  },
  {
    collection: 'locations',
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.__v
        return ret
      },
    },
  },
)

// A plain `sparse: true` on a COMPOUND index only excludes a document missing
// *every* indexed field — organizationId is always present, so sparse alone
// would never exclude a code-less location (the exact bug CAT-004's barcode
// index had before it was corrected). A partial index scoped to
// `code: { $exists: true }` is the correct construct here too.
locationSchema.index(
  { organizationId: 1, code: 1 },
  { unique: true, partialFilterExpression: { code: { $exists: true } } },
)

export type LocationDocument = mongoose.HydratedDocument<LocationAttrs>

export const LocationModel = mongoose.model<LocationAttrs>('Location', locationSchema)
