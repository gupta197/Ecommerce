import mongoose, { Schema, type Types } from 'mongoose'

export const ADDRESS_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
export type AddressStatus = (typeof ADDRESS_STATUSES)[number]

export interface AddressAttrs {
  customerId: Types.ObjectId
  recipientName: string
  phone?: string
  line1: string
  line2?: string
  city: string
  state: string
  postalCode: string
  country: string
  isDefaultBilling: boolean
  isDefaultShipping: boolean
  status: AddressStatus
  createdAt: Date
  updatedAt: Date
}

const addressSchema = new Schema<AddressAttrs>(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    // recipientName/phone are independent of the Customer's own name/phone —
    // a shipment can legitimately go to a different named recipient (a gift,
    // an office delivery).
    recipientName: { type: String, required: true, trim: true, maxlength: 200 },
    phone: { type: String, trim: true, maxlength: 20 },
    line1: { type: String, required: true, trim: true, maxlength: 200 },
    line2: { type: String, trim: true, maxlength: 200 },
    city: { type: String, required: true, trim: true, maxlength: 100 },
    state: { type: String, required: true, trim: true, maxlength: 100 },
    postalCode: { type: String, required: true, trim: true, maxlength: 20 },
    // Bounded free-text for now, not a locked ISO-3166 enum — approved
    // decision; no country reference dataset/dependency introduced.
    country: { type: String, required: true, trim: true, maxlength: 100 },
    // Never settable via the general update schema — only
    // address.repository.ts's dedicated clearDefaultFlag/setDefaultFlag
    // (called exclusively from address.service.ts's setDefaultAddress,
    // itself wrapped in one withTransaction()) ever change these.
    isDefaultBilling: { type: Boolean, required: true, default: false },
    isDefaultShipping: { type: Boolean, required: true, default: false },
    status: { type: String, enum: ADDRESS_STATUSES, required: true, default: 'ACTIVE' },
  },
  {
    collection: 'addresses',
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.__v
        return ret
      },
    },
  },
)

// Listing index: the one real query pattern ("this customer's addresses").
addressSchema.index({ customerId: 1 })
// Partial unique indexes: at most one default billing / one default shipping
// address per customer, enforced at the database level — the same technique
// already used for organization-membership's ACTIVE-status uniqueness,
// CAT-004's barcode, and INV-001's location code.
addressSchema.index(
  { customerId: 1, isDefaultBilling: 1 },
  { unique: true, partialFilterExpression: { isDefaultBilling: true } },
)
addressSchema.index(
  { customerId: 1, isDefaultShipping: 1 },
  { unique: true, partialFilterExpression: { isDefaultShipping: true } },
)

export type AddressDocument = mongoose.HydratedDocument<AddressAttrs>

export const AddressModel = mongoose.model<AddressAttrs>('Address', addressSchema)
