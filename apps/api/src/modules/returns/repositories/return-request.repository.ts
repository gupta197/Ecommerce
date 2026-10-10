import { Types, type ClientSession } from 'mongoose'
import {
  ReturnRequestModel,
  type ReturnRequestDocument,
  type ReturnRequestAttrs,
} from '../models/return-request.model.js'

export interface CreateReturnRequestData {
  orderId: Types.ObjectId
  customerId: Types.ObjectId
  organizationId: Types.ObjectId
  items: ReturnRequestAttrs['items']
  reason: string
}

/** Always called inside the caller's transaction (after
 *  return-request-lock.repository.ts's touch() and the quantity-integrity
 *  check have both run against the same session) — never standalone. */
export async function create(
  data: CreateReturnRequestData,
  session: ClientSession,
): Promise<ReturnRequestDocument> {
  const [request] = await ReturnRequestModel.create([{ ...data, status: 'PENDING' }], { session })
  if (!request) {
    throw new Error('ReturnRequestModel.create unexpectedly returned no document')
  }
  return request
}

/**
 * Sums requested quantities per variantId across every EXISTING
 * non-REJECTED ReturnRequest for this order — always a live read, never a
 * cached counter, so "a rejected request no longer counts toward the
 * limit" is true by construction regardless of whether any reject
 * capability exists yet (it does not, in this tranche). Must be called
 * with the same session as the lock-touch that precedes it and the create()
 * that follows it, inside one transaction — see
 * return-request-lock.model.ts for why the lock-touch is what actually
 * makes this read-then-decide sequence race-safe.
 */
export async function sumNonRejectedQuantitiesByVariant(
  orderId: Types.ObjectId,
  session: ClientSession,
): Promise<Map<string, number>> {
  const requests = await ReturnRequestModel.find({
    orderId,
    status: { $ne: 'REJECTED' },
  }).session(session)

  const sums = new Map<string, number>()
  for (const request of requests) {
    for (const item of request.items) {
      const key = item.variantId.toString()
      sums.set(key, (sums.get(key) ?? 0) + item.quantity)
    }
  }
  return sums
}

// customerId is a mandatory scoping parameter — the same IDOR-prevention
// convention every other module uses, defense-in-depth alongside the
// service layer's own order-ownership check.
export async function findById(
  customerId: Types.ObjectId,
  id: Types.ObjectId,
): Promise<ReturnRequestDocument | null> {
  return ReturnRequestModel.findOne({ _id: id, customerId })
}

export interface ListReturnRequestsOptions {
  page: number
  limit: number
}

export interface ListReturnRequestsResult {
  items: ReturnRequestDocument[]
  total: number
}

export async function listByOrder(
  customerId: Types.ObjectId,
  orderId: Types.ObjectId,
  options: ListReturnRequestsOptions,
): Promise<ListReturnRequestsResult> {
  const query = { orderId, customerId }
  const skip = (options.page - 1) * options.limit

  const [items, total] = await Promise.all([
    ReturnRequestModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(options.limit),
    ReturnRequestModel.countDocuments(query),
  ])

  return { items, total }
}
