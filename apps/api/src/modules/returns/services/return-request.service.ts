import { Types } from 'mongoose'
import { withTransaction } from '../../../db/transaction.js'
import { NotFoundError, ValidationError } from '../../../lib/http-errors.js'
import * as orderRepository from '../../orders/repositories/order.repository.js'
import * as returnRequestRepository from '../repositories/return-request.repository.js'
import * as returnRequestLockRepository from '../repositories/return-request-lock.repository.js'
import {
  createReturnRequestSchema,
  listReturnRequestsQuerySchema,
  type CreateReturnRequestInput,
} from '../validation/return-request.schema.js'
import type { ReturnRequestDocument } from '../models/return-request.model.js'
import { assertCustomerActive } from './shared-validation.js'
import * as auditService from '../../audit/services/audit.service.js'
import type { Logger } from '../../../lib/logger.js'

function notDeliveredError(): ValidationError {
  return new ValidationError('Only a delivered order can be returned.', [
    { path: 'orderId', message: 'Order has not been delivered' },
  ])
}

function unknownOrderItemError(variantId: string): ValidationError {
  return new ValidationError('One or more returned items were not part of this order.', [
    { path: `items.${variantId}`, message: 'Item was not part of this order' },
  ])
}

/**
 * Validates each requested item's quantity against the Order's own
 * immutable snapshot quantity (a cheap, non-transactional check — the
 * snapshot never changes once the Order is created) and collects every
 * failing item rather than stopping at the first, mirroring
 * checkout.service.ts's priceCartItems all-or-nothing error-reporting style.
 */
function validateAgainstOrderSnapshot(
  parsed: CreateReturnRequestInput,
  orderItemsByVariant: Map<string, number>,
): void {
  const issues: { path: string; message: string }[] = []
  for (const item of parsed.items) {
    const purchasedQuantity = orderItemsByVariant.get(item.variantId)
    if (purchasedQuantity === undefined) {
      issues.push({ path: `items.${item.variantId}`, message: 'Item was not part of this order' })
      continue
    }
    if (item.quantity > purchasedQuantity) {
      issues.push({
        path: `items.${item.variantId}`,
        message: 'Requested quantity exceeds the purchased quantity',
      })
    }
  }
  if (issues.length > 0) {
    throw new ValidationError('One or more items cannot be returned as requested.', issues)
  }
}

/**
 * Creates a PENDING ReturnRequest — the only operation this tranche exposes
 * (no approve/reject/receive). Never changes the Order itself: items,
 * prices, totals, and address snapshots are read-only inputs here, never
 * written to.
 *
 * Quantity integrity: validated twice. First, cheaply and
 * non-transactionally, against the Order's own immutable snapshot quantity
 * (requested <= purchased). Second, inside one withTransaction(), against
 * the *cumulative* total already requested by every existing non-REJECTED
 * ReturnRequest for this order — this second check is what prevents two
 * concurrent/overlapping submissions from together exceeding the purchased
 * quantity, and it is made race-safe by touching
 * return-request-lock.repository.ts's per-orderId lock document, inside the
 * same transaction, BEFORE the aggregate read (see that model's own
 * comment for the full mechanism). This is deliberately not a
 * non-transactional "read existing totals, then insert" sequence.
 */
export async function requestReturn(
  customerId: Types.ObjectId,
  orderId: Types.ObjectId,
  input: unknown,
  logger?: Logger,
): Promise<ReturnRequestDocument> {
  const parsed = createReturnRequestSchema.parse(input)
  await assertCustomerActive(customerId)

  const order = await orderRepository.findById(customerId, orderId)
  if (!order) {
    throw new NotFoundError('Order not found.')
  }
  if (order.status !== 'DELIVERED') {
    throw notDeliveredError()
  }

  const orderItemsByVariant = new Map(
    order.items.map((item) => [item.variantId.toString(), item.quantity]),
  )
  for (const item of parsed.items) {
    if (!orderItemsByVariant.has(item.variantId)) {
      throw unknownOrderItemError(item.variantId)
    }
  }
  validateAgainstOrderSnapshot(parsed, orderItemsByVariant)

  const created = await withTransaction(async (session) => {
    await returnRequestLockRepository.touch(order._id, session)

    const existingSums = await returnRequestRepository.sumNonRejectedQuantitiesByVariant(
      order._id,
      session,
    )

    const issues: { path: string; message: string }[] = []
    for (const item of parsed.items) {
      const purchasedQuantity = orderItemsByVariant.get(item.variantId) as number
      const alreadyRequested = existingSums.get(item.variantId) ?? 0
      if (alreadyRequested + item.quantity > purchasedQuantity) {
        issues.push({
          path: `items.${item.variantId}`,
          message: 'Requested quantity exceeds the remaining returnable quantity for this item',
        })
      }
    }
    if (issues.length > 0) {
      throw new ValidationError('One or more items exceed the returnable quantity.', issues)
    }

    return returnRequestRepository.create(
      {
        orderId: order._id,
        customerId,
        organizationId: order.organizationId,
        items: parsed.items.map((item) => ({
          variantId: new Types.ObjectId(item.variantId),
          quantity: item.quantity,
        })),
        reason: parsed.reason,
      },
      session,
    )
  })

  // Post-commit, best-effort — ADR-019's own rule: never inside the
  // transaction's callback (a transient-error retry of that callback could
  // otherwise duplicate this non-idempotent write).
  await auditService.record(
    {
      actorUserId: customerId,
      organizationId: order.organizationId,
      action: 'return.requested',
      entityType: 'ReturnRequest',
      entityId: created._id,
      outcome: 'SUCCESS',
      severity: 'INFO',
      metadata: { orderId: order._id.toString() },
    },
    logger,
  )

  return created
}

export async function listReturnsForOrder(
  customerId: Types.ObjectId,
  orderId: Types.ObjectId,
  queryInput: unknown,
): Promise<returnRequestRepository.ListReturnRequestsResult> {
  const order = await orderRepository.findById(customerId, orderId)
  if (!order) {
    throw new NotFoundError('Order not found.')
  }
  const parsed = listReturnRequestsQuerySchema.parse(queryInput)
  return returnRequestRepository.listByOrder(customerId, orderId, {
    page: parsed.page,
    limit: parsed.limit,
  })
}
