import { Types } from 'mongoose'
import {
  CustomerModel,
  type CustomerDocument,
  type CustomerStatus,
} from '../models/customer.model.js'
import { ValidationError } from '../../../lib/http-errors.js'
import { isDuplicateKeyError } from '../lib/mongo-errors.js'

export interface CreateCustomerData {
  userId: Types.ObjectId
  firstName: string
  lastName: string
  displayName?: string
  phone?: string
  status: CustomerStatus
}

// status is intentionally absent — lifecycle changes go through the
// dedicated archive()/restore() functions below, never through this
// general-purpose patch (mirrors customerId/userId immutability elsewhere:
// the field simply doesn't exist on the update type).
export interface UpdateCustomerData {
  firstName?: string
  lastName?: string
  displayName?: string
  phone?: string
}

const DUPLICATE_USER_MESSAGE = 'A customer profile already exists for this account.'

function duplicateUserError(): ValidationError {
  return new ValidationError(DUPLICATE_USER_MESSAGE, [
    { path: 'userId', message: 'Customer profile already exists for this user' },
  ])
}

export async function create(data: CreateCustomerData): Promise<CustomerDocument> {
  try {
    return await CustomerModel.create(data)
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw duplicateUserError()
    }
    throw error
  }
}

// Not scoped by an additional tenant parameter: Customer is the top-level
// unit here (there is no organizationId in this module — approved
// decision), so `_id` alone is the correct key. The actual IDOR protection
// is that every caller in customer.service.ts resolves this `_id` via
// findByUserId(req.auth.userId) first — it is never accepted as raw client
// input anywhere in this module.
export async function findById(id: Types.ObjectId): Promise<CustomerDocument | null> {
  return CustomerModel.findById(id)
}

export async function findByUserId(userId: Types.ObjectId): Promise<CustomerDocument | null> {
  return CustomerModel.findOne({ userId })
}

export async function existsWithUserId(userId: Types.ObjectId): Promise<boolean> {
  const match = await CustomerModel.exists({ userId })
  return match !== null
}

export async function update(
  id: Types.ObjectId,
  patch: UpdateCustomerData,
): Promise<CustomerDocument | null> {
  // Matches category.repository.ts's exact convention: only `undefined`
  // (an omitted field) is filtered out of $set.
  const setDoc: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      setDoc[key] = value
    }
  }

  return CustomerModel.findOneAndUpdate({ _id: id }, { $set: setDoc }, { returnDocument: 'after' })
}

export async function archive(id: Types.ObjectId): Promise<CustomerDocument | null> {
  return CustomerModel.findOneAndUpdate(
    { _id: id },
    { $set: { status: 'ARCHIVED' } },
    { returnDocument: 'after' },
  )
}

export async function restore(id: Types.ObjectId): Promise<CustomerDocument | null> {
  return CustomerModel.findOneAndUpdate(
    { _id: id },
    { $set: { status: 'ACTIVE' } },
    { returnDocument: 'after' },
  )
}
