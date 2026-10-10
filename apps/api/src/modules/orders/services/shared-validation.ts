import { Types } from 'mongoose'
import * as customerRepository from '../../customers/repositories/customer.repository.js'
import { NotFoundError, ValidationError } from '../../../lib/http-errors.js'

/** Resolves the caller's own Customer id from their authenticated userId —
 *  identity always comes from req.auth.userId, never a client-supplied
 *  customerId (same boundary every prior commerce module established). */
export async function resolveCustomerId(userId: Types.ObjectId): Promise<Types.ObjectId> {
  const customer = await customerRepository.findByUserId(userId)
  if (!customer) {
    throw new NotFoundError('Customer profile not found.')
  }
  return customer._id
}

/** Archived (or, defensively, missing) customers cannot mutate their own
 *  orders/returns — mirrors every other module's assertCustomerActive
 *  exactly. Reads (list/get) are never gated by this check. */
export async function assertCustomerActive(customerId: Types.ObjectId): Promise<void> {
  const customer = await customerRepository.findById(customerId)
  if (!customer || customer.status === 'ARCHIVED') {
    throw new ValidationError('An archived customer profile cannot perform this action.', [
      { path: 'customerId', message: 'Customer profile is archived' },
    ])
  }
}
