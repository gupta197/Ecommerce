import { Types, type ClientSession } from 'mongoose'
import {
  OrderModel,
  type OrderDocument,
  type OrderAttrs,
  type OrderStatus,
} from '../models/order.model.js'

export interface CreateOrderData {
  customerId: Types.ObjectId
  organizationId: Types.ObjectId
  items: OrderAttrs['items']
  subtotal: number
  total: number
  status: OrderAttrs['status']
  shippingAddress: OrderAttrs['shippingAddress']
  billingAddress: OrderAttrs['billingAddress']
}

/**
 * COM-003's own original repository operation — Order creation, with an
 * optional session so it can participate in checkout.service.ts's single
 * Order-creation-plus-Cart-clearing transaction. Untouched by COM-004.
 */
export async function create(
  data: CreateOrderData,
  session?: ClientSession,
): Promise<OrderDocument> {
  const [order] = await OrderModel.create([data], { session })
  if (!order) {
    throw new Error('OrderModel.create unexpectedly returned no document')
  }
  return order
}

// --- COM-004 additions (ADR-027) ---

// customerId is a mandatory scoping parameter — the same IDOR-prevention
// convention every other module uses. This is the ONLY lookup a
// customer-facing route may ever use.
export async function findById(
  customerId: Types.ObjectId,
  id: Types.ObjectId,
): Promise<OrderDocument | null> {
  return OrderModel.findOne({ _id: id, customerId })
}

/**
 * Unscoped by design — for internal, trusted-caller-only service functions
 * only (confirmOrder/startProcessing/markPacked/markShipped/markDelivered
 * in order.service.ts). These are never reachable from any customer or
 * staff route in this tranche; COM-005 will be the first real external
 * caller of confirmOrder, once it exists. Never call this from a route
 * handler directly — always go through order.service.ts's customer-scoped
 * functions for anything client-triggered.
 */
export async function findByIdInternal(id: Types.ObjectId): Promise<OrderDocument | null> {
  return OrderModel.findById(id)
}

export interface UpdateStatusFilter {
  id: Types.ObjectId
  // Omitted for internal/system-triggered transitions (findByIdInternal's
  // callers); present for customer-triggered ones (cancelOrder) to keep the
  // same IDOR-prevention scoping all the way through the write, not just
  // the read.
  customerId?: Types.ObjectId
}

export type OrderStatusPatch = Partial<
  Pick<
    OrderAttrs,
    | 'cancellationReason'
    | 'cancelledAt'
    | 'carrier'
    | 'trackingNumber'
    | 'shippedAt'
    | 'deliveredAt'
  >
>

/**
 * Atomically guarded state transition — the `status: fromStatus` clause is
 * part of the query filter itself, never a separate "read current status,
 * decide in application code, then write" sequence. Two concurrent
 * transition attempts against the same Order race on this filter: whichever
 * write lands first changes `status` away from `fromStatus`, so the loser's
 * own `findOneAndUpdate` simply matches nothing and returns `null` — the
 * caller must treat `null` as "no longer in the expected state", never as
 * a silent no-op success. This is the same atomic-conditional-update
 * technique already proven in cart-item.repository.ts's quantity ceiling
 * and stock-balance.repository.ts's guarded decrement.
 */
export async function updateStatus(
  filter: UpdateStatusFilter,
  fromStatus: OrderStatus,
  toStatus: OrderStatus,
  patch: OrderStatusPatch = {},
): Promise<OrderDocument | null> {
  const query: Record<string, unknown> = { _id: filter.id, status: fromStatus }
  if (filter.customerId) {
    query.customerId = filter.customerId
  }
  return OrderModel.findOneAndUpdate(
    query,
    { $set: { status: toStatus, ...patch } },
    { returnDocument: 'after' },
  )
}

export interface ListOrdersFilter {
  status?: OrderStatus
  organizationId?: Types.ObjectId
}

export interface ListOrdersOptions {
  page: number
  limit: number
}

export interface ListOrdersResult {
  items: OrderDocument[]
  total: number
}

export async function listByCustomer(
  customerId: Types.ObjectId,
  filter: ListOrdersFilter,
  options: ListOrdersOptions,
): Promise<ListOrdersResult> {
  const query: Record<string, unknown> = { customerId }
  if (filter.status) {
    query.status = filter.status
  }
  if (filter.organizationId) {
    query.organizationId = filter.organizationId
  }

  const skip = (options.page - 1) * options.limit

  const [items, total] = await Promise.all([
    OrderModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(options.limit),
    OrderModel.countDocuments(query),
  ])

  return { items, total }
}
