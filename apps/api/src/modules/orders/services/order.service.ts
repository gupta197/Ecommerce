import { Types } from 'mongoose'
import * as orderRepository from '../repositories/order.repository.js'
import type { OrderDocument, OrderStatus } from '../models/order.model.js'
import type { OrderStatusPatch } from '../repositories/order.repository.js'
import { NotFoundError, ValidationError } from '../../../lib/http-errors.js'
import { cancelOrderSchema, listOrdersQuerySchema } from '../validation/order.schema.js'
import { assertCustomerActive } from './shared-validation.js'
import * as auditService from '../../audit/services/audit.service.js'
import type { Logger } from '../../../lib/logger.js'

// ---------------------------------------------------------------------------
// State machine (ADR-027). Explicit, enumerable transition table — not a
// generic rules engine — matching this codebase's consistent preference for
// explicit logic over abstraction (e.g. inventory.service.ts's own
// computeSignedDelta). PROCESSING -> CANCELLED is deliberately NOT included:
// no staff-cancellation caller exists in this tranche (approved Tranche A
// scope), so it is not yet a reachable, testable edge. A future Tranche B
// would add it additively once staff cancellation is approved.
// ---------------------------------------------------------------------------

export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING_PAYMENT: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['PACKED'],
  PACKED: ['SHIPPED'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
}

function illegalTransitionError(from: OrderStatus, to: OrderStatus): ValidationError {
  return new ValidationError(`Cannot transition an order from ${from} to ${to}.`, [
    { path: 'status', message: `${to} is not a legal transition from ${from}` },
  ])
}

function staleTransitionError(): ValidationError {
  return new ValidationError('This order is no longer in the expected state.', [
    { path: 'status', message: 'Order status changed before this transition could be applied' },
  ])
}

async function recordOrderAudit(
  action: 'order.status_changed' | 'order.cancelled',
  order: OrderDocument,
  actorUserId: Types.ObjectId | undefined,
  metadata: Record<string, string | number | boolean | null>,
  logger?: Logger,
): Promise<void> {
  // Post-commit, best-effort — ADR-019's own rule: never inside a
  // transaction's callback, never capable of failing the operation that
  // triggered it. Neither transitionOrder's nor cancelOrder's own write
  // uses a transaction (both are single-document atomic updates), so
  // "post-commit" here simply means "after the awaited write resolved".
  await auditService.record(
    {
      actorUserId,
      organizationId: order.organizationId,
      action,
      entityType: 'Order',
      entityId: order._id,
      outcome: 'SUCCESS',
      severity: 'INFO',
      metadata,
    },
    logger,
  )
}

/**
 * Internal, trusted-caller-only transition — never exposed via any route in
 * this tranche. `orderId` is resolved unscoped (findByIdInternal): these
 * functions are not customer-facing, so there is no "authenticated caller's
 * own customerId" to scope by. `confirmOrder` is the one named in the
 * approved plan as "the trusted internal service boundary that COM-005 will
 * use for verified payment-success integration" — startProcessing/
 * markPacked/markShipped/markDelivered exist for the identical reason: the
 * full chain must be real, tested, and transition-table-enforced (so
 * illegal/skipped transitions are genuinely rejected, and so `deliveredAt`
 * can genuinely be populated) even though no staff route calls them yet.
 */
async function transitionOrderInternal(
  orderId: Types.ObjectId,
  toStatus: OrderStatus,
  patch: OrderStatusPatch = {},
  logger?: Logger,
): Promise<OrderDocument> {
  const current = await orderRepository.findByIdInternal(orderId)
  if (!current) {
    throw new NotFoundError('Order not found.')
  }
  if (!ORDER_TRANSITIONS[current.status].includes(toStatus)) {
    throw illegalTransitionError(current.status, toStatus)
  }

  const updated = await orderRepository.updateStatus(
    { id: orderId },
    current.status,
    toStatus,
    patch,
  )
  if (!updated) {
    throw staleTransitionError()
  }

  await recordOrderAudit(
    'order.status_changed',
    updated,
    undefined,
    { fromStatus: current.status, toStatus },
    logger,
  )
  return updated
}

/**
 * The trusted internal boundary COM-005 will call once a payment provider
 * is integrated and a webhook has been cryptographically verified — COM-004
 * implements and tests this transition but exposes it to no route and no
 * client input of any kind. Never call this from anything client-triggered.
 */
export async function confirmOrder(
  orderId: Types.ObjectId,
  logger?: Logger,
): Promise<OrderDocument> {
  return transitionOrderInternal(orderId, 'CONFIRMED', {}, logger)
}

/** Internal only — no staff route exists in this tranche (Tranche B). */
export async function startProcessing(
  orderId: Types.ObjectId,
  logger?: Logger,
): Promise<OrderDocument> {
  return transitionOrderInternal(orderId, 'PROCESSING', {}, logger)
}

/** Internal only — no staff route exists in this tranche (Tranche B). */
export async function markPacked(orderId: Types.ObjectId, logger?: Logger): Promise<OrderDocument> {
  return transitionOrderInternal(orderId, 'PACKED', {}, logger)
}

export interface ShipOrderInfo {
  carrier?: string
  trackingNumber?: string
}

/** Internal only — no staff route exists in this tranche (Tranche B). */
export async function markShipped(
  orderId: Types.ObjectId,
  info: ShipOrderInfo = {},
  logger?: Logger,
): Promise<OrderDocument> {
  return transitionOrderInternal(
    orderId,
    'SHIPPED',
    { carrier: info.carrier, trackingNumber: info.trackingNumber, shippedAt: new Date() },
    logger,
  )
}

/** Internal only — no staff route exists in this tranche (Tranche B). Sets
 *  `deliveredAt`, the field a future, explicitly-approved return-window
 *  policy would measure against (no window is enforced in this tranche). */
export async function markDelivered(
  orderId: Types.ObjectId,
  logger?: Logger,
): Promise<OrderDocument> {
  return transitionOrderInternal(orderId, 'DELIVERED', { deliveredAt: new Date() }, logger)
}

// ---------------------------------------------------------------------------
// Customer-facing operations
// ---------------------------------------------------------------------------

const CANCELLABLE_STATUSES: readonly OrderStatus[] = ['PENDING_PAYMENT', 'CONFIRMED']

/**
 * Customer-initiated cancellation — the ONLY customer-triggered status
 * transition in this tranche. Legal only from PENDING_PAYMENT/CONFIRMED
 * (approved Tranche A rule); PROCESSING/PACKED/SHIPPED/DELIVERED are
 * deliberately unreachable here — not merely unrouted, but absent from
 * ORDER_TRANSITIONS' own CANCELLED edges for every state past CONFIRMED.
 * Scoped by customerId end-to-end (read AND the guarded write), never by
 * orderId alone.
 */
export async function cancelOrder(
  customerId: Types.ObjectId,
  orderId: Types.ObjectId,
  input: unknown,
  logger?: Logger,
): Promise<OrderDocument> {
  const parsed = cancelOrderSchema.parse(input)
  await assertCustomerActive(customerId)

  const order = await orderRepository.findById(customerId, orderId)
  if (!order) {
    throw new NotFoundError('Order not found.')
  }
  if (!CANCELLABLE_STATUSES.includes(order.status)) {
    throw new ValidationError('This order can no longer be cancelled.', [
      { path: 'status', message: 'Order is not in a cancellable state' },
    ])
  }

  const updated = await orderRepository.updateStatus(
    { id: order._id, customerId },
    order.status,
    'CANCELLED',
    { cancellationReason: parsed.reason, cancelledAt: new Date() },
  )
  if (!updated) {
    throw staleTransitionError()
  }

  await recordOrderAudit(
    'order.cancelled',
    updated,
    customerId,
    { fromStatus: order.status, reason: parsed.reason ?? null },
    logger,
  )
  return updated
}

export async function getOrder(
  customerId: Types.ObjectId,
  orderId: Types.ObjectId,
): Promise<OrderDocument> {
  const order = await orderRepository.findById(customerId, orderId)
  if (!order) {
    throw new NotFoundError('Order not found.')
  }
  return order
}

export async function listOrders(
  customerId: Types.ObjectId,
  queryInput: unknown,
): Promise<orderRepository.ListOrdersResult> {
  const parsed = listOrdersQuerySchema.parse(queryInput)
  return orderRepository.listByCustomer(
    customerId,
    {
      status: parsed.status,
      organizationId: parsed.organizationId ? new Types.ObjectId(parsed.organizationId) : undefined,
    },
    { page: parsed.page, limit: parsed.limit },
  )
}
