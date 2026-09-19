import { Types } from 'mongoose'
import { withTransaction } from '../../../db/transaction.js'
import * as addressRepository from '../repositories/address.repository.js'
import type { UpdateAddressData } from '../repositories/address.repository.js'
import * as customerRepository from '../repositories/customer.repository.js'
import { NotFoundError, ValidationError } from '../../../lib/http-errors.js'
import {
  createAddressSchema,
  updateAddressSchema,
  setDefaultAddressSchema,
  type CreateAddressInput,
  type UpdateAddressInput,
  type SetDefaultAddressInput,
} from '../validation/address.schema.js'
import type { AddressDocument } from '../models/address.model.js'

/** A customer that is archived (or, defensively, missing) cannot perform
 *  any address write — applies to create/update/archive/setDefault, never
 *  to reads. Re-checked here rather than trusted from the caller, so this
 *  service is self-defending independent of the route layer's own logic. */
async function assertCustomerActive(customerId: Types.ObjectId): Promise<void> {
  const customer = await customerRepository.findById(customerId)
  if (!customer || customer.status === 'ARCHIVED') {
    throw new ValidationError('An archived customer profile cannot manage addresses.', [
      { path: 'customerId', message: 'Customer profile is archived' },
    ])
  }
}

function archivedAddressError(): ValidationError {
  return new ValidationError('An archived address cannot be modified.', [
    { path: 'status', message: 'Address is archived' },
  ])
}

export async function createAddress(
  customerId: Types.ObjectId,
  input: unknown,
): Promise<AddressDocument> {
  const parsed: CreateAddressInput = createAddressSchema.parse(input)
  await assertCustomerActive(customerId)

  return addressRepository.create({
    customerId,
    recipientName: parsed.recipientName,
    phone: parsed.phone,
    line1: parsed.line1,
    line2: parsed.line2,
    city: parsed.city,
    state: parsed.state,
    postalCode: parsed.postalCode,
    country: parsed.country,
    status: 'ACTIVE',
  })
}

export async function listAddresses(customerId: Types.ObjectId): Promise<AddressDocument[]> {
  return addressRepository.findByCustomerId(customerId)
}

export async function updateAddress(
  customerId: Types.ObjectId,
  id: Types.ObjectId,
  input: unknown,
): Promise<AddressDocument> {
  const parsed: UpdateAddressInput = updateAddressSchema.parse(input)
  await assertCustomerActive(customerId)

  const existing = await addressRepository.findById(customerId, id)
  if (!existing) {
    throw new NotFoundError('Address not found.')
  }
  if (existing.status === 'ARCHIVED') {
    throw archivedAddressError()
  }

  const patch: UpdateAddressData = {}
  if (parsed.recipientName !== undefined) patch.recipientName = parsed.recipientName
  if (parsed.phone !== undefined) patch.phone = parsed.phone
  if (parsed.line1 !== undefined) patch.line1 = parsed.line1
  if (parsed.line2 !== undefined) patch.line2 = parsed.line2
  if (parsed.city !== undefined) patch.city = parsed.city
  if (parsed.state !== undefined) patch.state = parsed.state
  if (parsed.postalCode !== undefined) patch.postalCode = parsed.postalCode
  if (parsed.country !== undefined) patch.country = parsed.country

  const updated = await addressRepository.update(customerId, id, patch)
  if (!updated) {
    throw new NotFoundError('Address not found.')
  }
  return updated
}

/** Soft-archives an address. Never deletes. An archived address can never
 *  become default again (setDefaultAddress rejects it) but is otherwise
 *  left exactly as-is — no cascade to the customer profile in either
 *  direction. */
export async function archiveAddress(
  customerId: Types.ObjectId,
  id: Types.ObjectId,
): Promise<AddressDocument> {
  await assertCustomerActive(customerId)
  const archived = await addressRepository.archive(customerId, id)
  if (!archived) {
    throw new NotFoundError('Address not found.')
  }
  return archived
}

/**
 * Sets an address as the customer's default (billing or shipping), entirely
 * inside one withTransaction() per the approved decision:
 *   1. Verify customer owns the address (findById, customer-scoped).
 *   2. Verify the address is ACTIVE.
 *   3. Unset the existing default of that type for this customer.
 *   4. Set the requested address as default.
 * All four steps commit or roll back together — never two independent
 * writes. The {customerId, isDefaultBilling/isDefaultShipping: true}
 * partial unique indexes remain an additional, database-level invariant on
 * top of this transaction, not a replacement for it.
 */
export async function setDefaultAddress(
  customerId: Types.ObjectId,
  id: Types.ObjectId,
  input: unknown,
): Promise<AddressDocument> {
  const parsed: SetDefaultAddressInput = setDefaultAddressSchema.parse(input)
  await assertCustomerActive(customerId)

  return withTransaction(async (session) => {
    const address = await addressRepository.findById(customerId, id, session)
    if (!address) {
      throw new NotFoundError('Address not found.')
    }
    if (address.status === 'ARCHIVED') {
      throw archivedAddressError()
    }

    await addressRepository.clearDefaultFlag(customerId, parsed.type, session)
    const updated = await addressRepository.setDefaultFlag(customerId, id, parsed.type, session)
    if (!updated) {
      throw new NotFoundError('Address not found.')
    }
    return updated
  })
}
