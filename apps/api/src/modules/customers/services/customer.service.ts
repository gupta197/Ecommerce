import { Types } from 'mongoose'
import * as customerRepository from '../repositories/customer.repository.js'
import type { UpdateCustomerData } from '../repositories/customer.repository.js'
import { NotFoundError, ValidationError } from '../../../lib/http-errors.js'
import {
  createCustomerSchema,
  updateCustomerSchema,
  type CreateCustomerInput,
  type UpdateCustomerInput,
} from '../validation/customer.schema.js'
import type { CustomerDocument } from '../models/customer.model.js'

function duplicateProfileError(): ValidationError {
  return new ValidationError('A customer profile already exists for this account.', [
    { path: 'userId', message: 'Customer profile already exists' },
  ])
}

function archivedProfileError(): ValidationError {
  return new ValidationError('An archived customer profile cannot be updated.', [
    { path: 'status', message: 'Customer profile is archived' },
  ])
}

export async function createCustomerProfile(
  userId: Types.ObjectId,
  input: unknown,
): Promise<CustomerDocument> {
  const parsed: CreateCustomerInput = createCustomerSchema.parse(input)

  if (await customerRepository.existsWithUserId(userId)) {
    throw duplicateProfileError()
  }

  return customerRepository.create({
    userId,
    firstName: parsed.firstName,
    lastName: parsed.lastName,
    displayName: parsed.displayName,
    phone: parsed.phone,
    status: 'ACTIVE',
  })
}

/** Resolves the caller's own Customer profile from their authenticated
 *  userId — identity always comes from req.auth.userId, never from a
 *  client-supplied customerId (approved decision). */
export async function getCustomerProfile(userId: Types.ObjectId): Promise<CustomerDocument> {
  const customer = await customerRepository.findByUserId(userId)
  if (!customer) {
    throw new NotFoundError('Customer profile not found.')
  }
  return customer
}

export async function updateCustomerProfile(
  userId: Types.ObjectId,
  input: unknown,
): Promise<CustomerDocument> {
  const parsed: UpdateCustomerInput = updateCustomerSchema.parse(input)

  const existing = await customerRepository.findByUserId(userId)
  if (!existing) {
    throw new NotFoundError('Customer profile not found.')
  }
  if (existing.status === 'ARCHIVED') {
    throw archivedProfileError()
  }

  const patch: UpdateCustomerData = {}
  if (parsed.firstName !== undefined) patch.firstName = parsed.firstName
  if (parsed.lastName !== undefined) patch.lastName = parsed.lastName
  if (parsed.displayName !== undefined) patch.displayName = parsed.displayName
  if (parsed.phone !== undefined) patch.phone = parsed.phone

  const updated = await customerRepository.update(existing._id, patch)
  if (!updated) {
    throw new NotFoundError('Customer profile not found.')
  }
  return updated
}

/** Soft-archives the caller's own profile. Never deletes, never cascades:
 *  existing addresses are untouched (see address.service.ts's
 *  assertCustomerActive, which blocks further address writes once
 *  archived, but never modifies existing address data). */
export async function archiveCustomerProfile(userId: Types.ObjectId): Promise<CustomerDocument> {
  const existing = await customerRepository.findByUserId(userId)
  if (!existing) {
    throw new NotFoundError('Customer profile not found.')
  }
  const archived = await customerRepository.archive(existing._id)
  if (!archived) {
    throw new NotFoundError('Customer profile not found.')
  }
  return archived
}

export async function restoreCustomerProfile(userId: Types.ObjectId): Promise<CustomerDocument> {
  const existing = await customerRepository.findByUserId(userId)
  if (!existing) {
    throw new NotFoundError('Customer profile not found.')
  }
  const restored = await customerRepository.restore(existing._id)
  if (!restored) {
    throw new NotFoundError('Customer profile not found.')
  }
  return restored
}
