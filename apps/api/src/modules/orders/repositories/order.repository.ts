import type { Types, ClientSession } from 'mongoose'
import { OrderModel, type OrderDocument, type OrderAttrs } from '../models/order.model.js'

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
 * The only repository operation COM-003 needs: Order creation, with an
 * optional session so it can participate in checkout.service.ts's single
 * Order-creation-plus-Cart-clearing transaction (mirrors
 * organizationRepository.create's own array-form `Model.create([data],
 * {session})` pattern, which is required — not just supported — when a
 * session must be attached to a create call).
 *
 * No findById/list/update is added here speculatively — COM-004 will add
 * whatever read/lifecycle operations its own order-management routes
 * actually need, when that task is approved.
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
