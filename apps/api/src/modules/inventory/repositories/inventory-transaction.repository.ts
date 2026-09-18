import { Types, type ClientSession } from 'mongoose'
import {
  InventoryTransactionModel,
  type AdjustmentDirection,
  type InventoryTransactionDocument,
  type InventoryTransactionType,
} from '../models/inventory-transaction.model.js'

export interface CreateInventoryTransactionData {
  organizationId: Types.ObjectId
  locationId: Types.ObjectId
  variantId: Types.ObjectId
  type: InventoryTransactionType
  quantity: number
  adjustmentDirection?: AdjustmentDirection
  note?: string
}

export interface ListInventoryTransactionsFilter {
  locationId?: Types.ObjectId
  variantId?: Types.ObjectId
  type?: InventoryTransactionType
}

export interface ListInventoryTransactionsOptions {
  page: number
  limit: number
}

export interface ListInventoryTransactionsResult {
  items: InventoryTransactionDocument[]
  total: number
}

// No update(), no delete() — this ledger is genuinely append-only, mirroring
// audit-event.repository.ts's exact shape. `session` is a required
// parameter, not optional: a ledger entry is only ever created as part of
// the single withTransaction() that also updates the corresponding
// StockBalance (inventory.service.ts) — the signature itself makes writing
// one without the other structurally awkward to do by accident.
export async function create(
  data: CreateInventoryTransactionData,
  session: ClientSession,
): Promise<InventoryTransactionDocument> {
  const [created] = await InventoryTransactionModel.create([data], { session })
  return created as InventoryTransactionDocument
}

export async function findById(
  organizationId: Types.ObjectId,
  id: Types.ObjectId,
): Promise<InventoryTransactionDocument | null> {
  return InventoryTransactionModel.findOne({ _id: id, organizationId })
}

export async function list(
  organizationId: Types.ObjectId,
  filter: ListInventoryTransactionsFilter,
  options: ListInventoryTransactionsOptions,
): Promise<ListInventoryTransactionsResult> {
  const query: Record<string, unknown> = { organizationId }
  if (filter.locationId) {
    query.locationId = filter.locationId
  }
  if (filter.variantId) {
    query.variantId = filter.variantId
  }
  if (filter.type) {
    query.type = filter.type
  }

  const skip = (options.page - 1) * options.limit

  const [items, total] = await Promise.all([
    InventoryTransactionModel.find(query)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(options.limit),
    InventoryTransactionModel.countDocuments(query),
  ])

  return { items, total }
}
