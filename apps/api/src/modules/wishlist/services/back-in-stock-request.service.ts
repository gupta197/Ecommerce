import { Types } from 'mongoose'
import * as backInStockRequestRepository from '../repositories/back-in-stock-request.repository.js'
import { NotFoundError, ValidationError } from '../../../lib/http-errors.js'
import {
  createBackInStockRequestSchema,
  type CreateBackInStockRequestInput,
} from '../validation/back-in-stock-request.schema.js'
import type { BackInStockRequestDocument } from '../models/back-in-stock-request.model.js'
import {
  assertCustomerActive,
  assertValidOrganization,
  assertValidVariant,
  getAggregateStock,
} from './shared-validation.js'

function variantInStockError(): ValidationError {
  return new ValidationError(
    'This variant currently has stock available; a back-in-stock request is not needed.',
    [{ path: 'variantId', message: 'Variant is in stock' }],
  )
}

/**
 * Creates a PENDING request. The stock check (aggregate quantityOnHand
 * across all locations, via INV-001's existing, unmodified
 * stock-balance.repository.ts) happens as a plain read, not inside a
 * transaction with the write — a small TOCTOU window (stock could change
 * between the check and the insert) is explicitly accepted, per the
 * approved plan. No reservation/backorder behavior is implemented.
 */
export async function createBackInStockRequest(
  customerId: Types.ObjectId,
  input: unknown,
): Promise<BackInStockRequestDocument> {
  const parsed: CreateBackInStockRequestInput = createBackInStockRequestSchema.parse(input)
  await assertCustomerActive(customerId)

  const organizationId = new Types.ObjectId(parsed.organizationId)
  const variantId = new Types.ObjectId(parsed.variantId)

  await assertValidOrganization(organizationId)
  await assertValidVariant(organizationId, variantId)

  const aggregateStock = await getAggregateStock(organizationId, variantId)
  if (aggregateStock > 0) {
    throw variantInStockError()
  }

  return backInStockRequestRepository.create({
    customerId,
    organizationId,
    variantId,
    status: 'PENDING',
  })
}

export async function listBackInStockRequests(
  customerId: Types.ObjectId,
): Promise<BackInStockRequestDocument[]> {
  return backInStockRequestRepository.findByCustomerId(customerId)
}

/** Cancels a PENDING request (PENDING -> CANCELLED). Never deletes. Once
 *  cancelled, the same customer may create a new PENDING request for the
 *  same variant again (the partial unique index only constrains PENDING
 *  rows). No FULFILLED state and no automatic fulfillment detection exist
 *  in this task. */
export async function cancelBackInStockRequest(
  customerId: Types.ObjectId,
  id: Types.ObjectId,
): Promise<BackInStockRequestDocument> {
  await assertCustomerActive(customerId)
  const cancelled = await backInStockRequestRepository.cancel(customerId, id)
  if (!cancelled) {
    throw new NotFoundError('Back-in-stock request not found.')
  }
  return cancelled
}
