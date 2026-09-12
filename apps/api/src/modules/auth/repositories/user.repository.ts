import type { Types } from 'mongoose'
import { UserModel, type UserDocument } from '../models/user.model.js'

export interface CreateUserData {
  email: string
  passwordHash: string
}

const DUPLICATE_KEY_ERROR_CODE = 11000

// Deliberately NOT imported from modules/catalog — cross-module sharing
// between auth and catalog is an explicit decision to make separately if
// it's ever genuinely needed, not something to bundle into this task.
function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === DUPLICATE_KEY_ERROR_CODE
  )
}

/** Returns the created user, or `null` if the email already exists.
 *  Callers must not use the `null` case to produce a different response
 *  than the success case — see auth.service.ts's register(). */
export async function create(data: CreateUserData): Promise<UserDocument | null> {
  try {
    return await UserModel.create(data)
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return null
    }
    throw error
  }
}

export async function findByEmailWithPassword(email: string): Promise<UserDocument | null> {
  return UserModel.findOne({ email }).select('+passwordHash')
}

export async function findById(id: Types.ObjectId): Promise<UserDocument | null> {
  return UserModel.findById(id)
}

export async function recordLoginFailure(
  id: Types.ObjectId,
  data: { failedLoginAttempts: number; nextAttemptAllowedAt: Date | null },
): Promise<void> {
  await UserModel.updateOne({ _id: id }, { $set: data })
}

export async function resetLoginFailures(id: Types.ObjectId): Promise<void> {
  await UserModel.updateOne(
    { _id: id },
    { $set: { failedLoginAttempts: 0, nextAttemptAllowedAt: null } },
  )
}
