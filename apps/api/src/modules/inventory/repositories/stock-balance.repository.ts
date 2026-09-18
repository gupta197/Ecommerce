import { Types, type ClientSession } from 'mongoose'
import { StockBalanceModel, type StockBalanceDocument } from '../models/stock-balance.model.js'
import { isDuplicateKeyError } from '../lib/mongo-errors.js'

export interface StockBalanceKey {
  organizationId: Types.ObjectId
  locationId: Types.ObjectId
  variantId: Types.ObjectId
}

export interface ListStockBalancesFilter {
  locationId?: Types.ObjectId
  variantId?: Types.ObjectId
}

export interface ListStockBalancesOptions {
  page: number
  limit: number
}

export interface ListStockBalancesResult {
  items: StockBalanceDocument[]
  total: number
}

export async function findByVariantAndLocation(
  organizationId: Types.ObjectId,
  locationId: Types.ObjectId,
  variantId: Types.ObjectId,
): Promise<StockBalanceDocument | null> {
  return StockBalanceModel.findOne({ organizationId, locationId, variantId })
}

export async function list(
  organizationId: Types.ObjectId,
  filter: ListStockBalancesFilter,
  options: ListStockBalancesOptions,
): Promise<ListStockBalancesResult> {
  const query: Record<string, unknown> = { organizationId }
  if (filter.locationId) {
    query.locationId = filter.locationId
  }
  if (filter.variantId) {
    query.variantId = filter.variantId
  }

  const skip = (options.page - 1) * options.limit

  const [items, total] = await Promise.all([
    StockBalanceModel.find(query).sort({ _id: 1 }).skip(skip).limit(options.limit),
    StockBalanceModel.countDocuments(query),
  ])

  return { items, total }
}

/**
 * Atomically increments the balance for `key` by `amount`, creating the
 * balance document (starting from 0) if it doesn't exist yet — a single
 * `findOneAndUpdate` with `upsert: true`, never "read then decide to
 * create-or-update" in application code.
 *
 * Two concurrent first-writes for the same key racing to insert are
 * resolved by the {organizationId, locationId, variantId} unique index:
 * inside a MongoDB transaction (the only way this is ever called — see
 * inventory.service.ts) a losing writer surfaces as a transient write
 * conflict, which `withTransaction()`'s automatic whole-callback retry
 * already resolves. The duplicate-key catch below is an additional,
 * cheap defense-in-depth layer for the same race outside that primary
 * mechanism — after the retry, the document is known to exist, so a plain
 * conditional increment (no upsert) is guaranteed correct.
 */
export async function incrementOrCreate(
  key: StockBalanceKey,
  amount: number,
  session: ClientSession,
): Promise<StockBalanceDocument> {
  const filter = {
    organizationId: key.organizationId,
    locationId: key.locationId,
    variantId: key.variantId,
  }
  try {
    const updated = await StockBalanceModel.findOneAndUpdate(
      filter,
      { $inc: { quantityOnHand: amount } },
      { upsert: true, returnDocument: 'after', session, setDefaultsOnInsert: true },
    )
    // upsert:true + returnDocument:'after' always returns the post-write document.
    return updated as StockBalanceDocument
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const retried = await StockBalanceModel.findOneAndUpdate(
        filter,
        { $inc: { quantityOnHand: amount } },
        { returnDocument: 'after', session },
      )
      if (retried) {
        return retried
      }
    }
    throw error
  }
}

/**
 * Atomically decrements the balance for `key` by `amount`, but only if the
 * current balance is at least `amount` — the sufficiency check is part of
 * the database filter itself, never a separate "read balance, check in
 * application code, then write" sequence. Returns `null` (no write
 * performed) if the balance is missing or insufficient; the caller must
 * treat `null` as "insufficient stock," not as "not found."
 */
export async function decrementIfSufficient(
  key: StockBalanceKey,
  amount: number,
  session: ClientSession,
): Promise<StockBalanceDocument | null> {
  return StockBalanceModel.findOneAndUpdate(
    {
      organizationId: key.organizationId,
      locationId: key.locationId,
      variantId: key.variantId,
      quantityOnHand: { $gte: amount },
    },
    { $inc: { quantityOnHand: -amount } },
    { returnDocument: 'after', session },
  )
}
