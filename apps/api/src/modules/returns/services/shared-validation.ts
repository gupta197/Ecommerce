import { Types } from 'mongoose'
import * as customerRepository from '../../customers/repositories/customer.repository.js'
import { ValidationError } from '../../../lib/http-errors.js'

/** Archived (or, defensively, missing) customers cannot request a return —
 *  mirrors every other module's assertCustomerActive exactly. Listing
 *  returns is never gated by this check. */
export async function assertCustomerActive(customerId: Types.ObjectId): Promise<void> {
  const customer = await customerRepository.findById(customerId)
  if (!customer || customer.status === 'ARCHIVED') {
    throw new ValidationError('An archived customer profile cannot perform this action.', [
      { path: 'customerId', message: 'Customer profile is archived' },
    ])
  }
}
