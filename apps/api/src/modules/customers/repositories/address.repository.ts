import { Types, type ClientSession } from 'mongoose'
import { AddressModel, type AddressDocument, type AddressStatus } from '../models/address.model.js'
import type { AddressDefaultType } from '../validation/address.schema.js'

export interface CreateAddressData {
  customerId: Types.ObjectId
  recipientName: string
  phone?: string
  line1: string
  line2?: string
  city: string
  state: string
  postalCode: string
  country: string
  status: AddressStatus
}

// isDefaultBilling/isDefaultShipping/customerId/status are all intentionally
// absent — defaults change only through clearDefaultFlag/setDefaultFlag
// below, status only through archive(), and customerId is immutable.
export interface UpdateAddressData {
  recipientName?: string
  phone?: string
  line1?: string
  line2?: string
  city?: string
  state?: string
  postalCode?: string
  country?: string
}

export async function create(data: CreateAddressData): Promise<AddressDocument> {
  return AddressModel.create(data)
}

// customerId is a mandatory parameter on every function in this file — the
// same IDOR-prevention convention every other module uses, anchored on
// customerId instead of organizationId. `session` is optional: most reads
// happen outside a transaction, but setDefaultAddress's ownership/status
// check must happen inside the same transaction as the writes that follow.
export async function findById(
  customerId: Types.ObjectId,
  id: Types.ObjectId,
  session?: ClientSession,
): Promise<AddressDocument | null> {
  return AddressModel.findOne({ _id: id, customerId }).session(session ?? null)
}

export async function findByCustomerId(customerId: Types.ObjectId): Promise<AddressDocument[]> {
  return AddressModel.find({ customerId }).sort({ _id: 1 })
}

export async function update(
  customerId: Types.ObjectId,
  id: Types.ObjectId,
  patch: UpdateAddressData,
): Promise<AddressDocument | null> {
  const setDoc: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      setDoc[key] = value
    }
  }

  return AddressModel.findOneAndUpdate(
    { _id: id, customerId },
    { $set: setDoc },
    { returnDocument: 'after' },
  )
}

export async function archive(
  customerId: Types.ObjectId,
  id: Types.ObjectId,
): Promise<AddressDocument | null> {
  return AddressModel.findOneAndUpdate(
    { _id: id, customerId },
    { $set: { status: 'ARCHIVED' } },
    { returnDocument: 'after' },
  )
}

function defaultFieldFor(type: AddressDefaultType): 'isDefaultBilling' | 'isDefaultShipping' {
  return type === 'billing' ? 'isDefaultBilling' : 'isDefaultShipping'
}

/** Unsets the current default (of `type`) for this customer, if any. Always
 *  called inside the same withTransaction() as setDefaultFlag — see
 *  address.service.ts's setDefaultAddress. The partial unique index remains
 *  the actual database-level guarantee against two simultaneous defaults;
 *  this transaction guarantees the two-step swap itself is all-or-nothing. */
export async function clearDefaultFlag(
  customerId: Types.ObjectId,
  type: AddressDefaultType,
  session: ClientSession,
): Promise<void> {
  const field = defaultFieldFor(type)
  await AddressModel.updateMany(
    { customerId, [field]: true },
    { $set: { [field]: false } },
    { session },
  )
}

export async function setDefaultFlag(
  customerId: Types.ObjectId,
  id: Types.ObjectId,
  type: AddressDefaultType,
  session: ClientSession,
): Promise<AddressDocument | null> {
  const field = defaultFieldFor(type)
  return AddressModel.findOneAndUpdate(
    { _id: id, customerId },
    { $set: { [field]: true } },
    { returnDocument: 'after', session },
  )
}
