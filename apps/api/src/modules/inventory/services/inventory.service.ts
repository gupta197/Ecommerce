import { Types } from 'mongoose'
import { withTransaction } from '../../../db/transaction.js'
import * as locationRepository from '../repositories/location.repository.js'
import * as stockBalanceRepository from '../repositories/stock-balance.repository.js'
import * as inventoryTransactionRepository from '../repositories/inventory-transaction.repository.js'
// Read-only use of ProductVariant's already-public repository to validate a
// reference — no modification to product-variant.repository.ts. Mirrors
// product-variant.service.ts's own one-directional dependency on
// product.repository.ts.
import * as productVariantRepository from '../../catalog/repositories/product-variant.repository.js'
import { ValidationError } from '../../../lib/http-errors.js'
import {
  recordTransactionSchema,
  recordTransferSchema,
  type RecordTransactionInput,
  type RecordTransactionType,
  type RecordTransferInput,
} from '../validation/inventory-transaction.schema.js'
import type {
  AdjustmentDirection,
  InventoryTransactionDocument,
} from '../models/inventory-transaction.model.js'
import type { StockBalanceDocument } from '../models/stock-balance.model.js'
import type {
  ListInventoryTransactionsFilter,
  ListInventoryTransactionsOptions,
  ListInventoryTransactionsResult,
} from '../repositories/inventory-transaction.repository.js'

/** Validates that `variantId` exists in this organization and is not
 *  archived. Never trusts that a syntactically valid ObjectId implies a
 *  real, owned, usable variant — mirrors product-variant.service.ts's own
 *  assertValidProduct() exactly, applied to inventory's Variant reference. */
async function assertValidVariant(
  organizationId: Types.ObjectId,
  variantId: Types.ObjectId,
): Promise<void> {
  const variant = await productVariantRepository.findById(organizationId, variantId)
  if (!variant) {
    throw new ValidationError(
      'variantId does not reference an existing product variant in this organization.',
      [{ path: 'variantId', message: 'Variant not found' }],
    )
  }
  if (variant.status === 'ARCHIVED') {
    throw new ValidationError(
      'An inventory transaction cannot be recorded for an archived variant.',
      [{ path: 'variantId', message: 'Variant is archived' }],
    )
  }
}

/** Same validation as assertValidVariant, for a Location. `fieldPath` lets
 *  callers with two location references (recordTransfer's from/to) produce
 *  an error that names the correct field. */
async function assertValidLocation(
  organizationId: Types.ObjectId,
  locationId: Types.ObjectId,
  fieldPath: string,
): Promise<void> {
  const location = await locationRepository.findById(organizationId, locationId)
  if (!location) {
    throw new ValidationError(
      `${fieldPath} does not reference an existing location in this organization.`,
      [{ path: fieldPath, message: 'Location not found' }],
    )
  }
  if (location.status === 'ARCHIVED') {
    throw new ValidationError(
      'An inventory transaction cannot be recorded for an archived location.',
      [{ path: fieldPath, message: 'Location is archived' }],
    )
  }
}

/** Maps a transaction type (+ adjustmentDirection for ADJUSTMENT) to a
 *  signed stock delta. The magnitude (`quantity`) is always positive on
 *  input (enforced by validation/inventory-transaction.schema.ts); this is
 *  the one place direction is applied. */
function computeSignedDelta(
  type: RecordTransactionType,
  quantity: number,
  adjustmentDirection: AdjustmentDirection | undefined,
): number {
  switch (type) {
    case 'PURCHASE':
    case 'RETURN':
    case 'OPENING_BALANCE':
      return quantity
    case 'SALE':
    case 'DAMAGE':
      return -quantity
    case 'ADJUSTMENT':
      // Zod's superRefine already guarantees adjustmentDirection is defined
      // here; this check is defense-in-depth, not the primary guarantee.
      if (adjustmentDirection === undefined) {
        throw new ValidationError('adjustmentDirection is required for ADJUSTMENT transactions.', [
          { path: 'adjustmentDirection', message: 'Required' },
        ])
      }
      return adjustmentDirection === 'INCREASE' ? quantity : -quantity
  }
}

function insufficientStockError(fieldPath = 'quantity'): ValidationError {
  return new ValidationError('Insufficient stock at this location.', [
    { path: fieldPath, message: 'Insufficient stock' },
  ])
}

/**
 * Records a single-location inventory movement (PURCHASE, SALE, RETURN,
 * ADJUSTMENT, DAMAGE, OPENING_BALANCE). TRANSFER_IN/TRANSFER_OUT are
 * rejected by the input schema — those are only ever produced by
 * recordTransfer(). Validation (variant/location existence and archived
 * status) happens before the transaction opens; the balance update and the
 * ledger write happen together inside one withTransaction() — both succeed
 * or neither does.
 */
export async function recordTransaction(
  organizationId: Types.ObjectId,
  input: unknown,
): Promise<InventoryTransactionDocument> {
  const parsed: RecordTransactionInput = recordTransactionSchema.parse(input)

  const variantId = new Types.ObjectId(parsed.variantId)
  const locationId = new Types.ObjectId(parsed.locationId)

  await assertValidVariant(organizationId, variantId)
  await assertValidLocation(organizationId, locationId, 'locationId')

  const delta = computeSignedDelta(parsed.type, parsed.quantity, parsed.adjustmentDirection)
  const key = { organizationId, locationId, variantId }

  return withTransaction(async (session) => {
    if (delta < 0) {
      const updated = await stockBalanceRepository.decrementIfSufficient(key, -delta, session)
      if (!updated) {
        throw insufficientStockError()
      }
    } else {
      await stockBalanceRepository.incrementOrCreate(key, delta, session)
    }

    return inventoryTransactionRepository.create(
      {
        organizationId,
        locationId,
        variantId,
        type: parsed.type,
        quantity: parsed.quantity,
        adjustmentDirection: parsed.adjustmentDirection,
        note: parsed.note,
      },
      session,
    )
  })
}

export interface RecordTransferResult {
  transferOut: InventoryTransactionDocument
  transferIn: InventoryTransactionDocument
}

/**
 * Moves stock from one location to another as a single atomic operation —
 * never two independent recordTransaction() calls, which could leave a
 * TRANSFER_OUT applied with no matching TRANSFER_IN (or vice versa) if the
 * second call failed. Validation happens before the transaction opens; the
 * source decrement, destination increment, and both ledger entries all
 * happen inside one withTransaction().
 */
export async function recordTransfer(
  organizationId: Types.ObjectId,
  input: unknown,
): Promise<RecordTransferResult> {
  const parsed: RecordTransferInput = recordTransferSchema.parse(input)

  if (parsed.fromLocationId === parsed.toLocationId) {
    throw new ValidationError('Source and destination locations must be different.', [
      { path: 'toLocationId', message: 'Must differ from fromLocationId' },
    ])
  }

  const variantId = new Types.ObjectId(parsed.variantId)
  const fromLocationId = new Types.ObjectId(parsed.fromLocationId)
  const toLocationId = new Types.ObjectId(parsed.toLocationId)

  await assertValidVariant(organizationId, variantId)
  await assertValidLocation(organizationId, fromLocationId, 'fromLocationId')
  await assertValidLocation(organizationId, toLocationId, 'toLocationId')

  return withTransaction(async (session) => {
    const decremented = await stockBalanceRepository.decrementIfSufficient(
      { organizationId, locationId: fromLocationId, variantId },
      parsed.quantity,
      session,
    )
    if (!decremented) {
      throw insufficientStockError()
    }

    await stockBalanceRepository.incrementOrCreate(
      { organizationId, locationId: toLocationId, variantId },
      parsed.quantity,
      session,
    )

    const transferOut = await inventoryTransactionRepository.create(
      {
        organizationId,
        locationId: fromLocationId,
        variantId,
        type: 'TRANSFER_OUT',
        quantity: parsed.quantity,
        note: parsed.note,
      },
      session,
    )
    const transferIn = await inventoryTransactionRepository.create(
      {
        organizationId,
        locationId: toLocationId,
        variantId,
        type: 'TRANSFER_IN',
        quantity: parsed.quantity,
        note: parsed.note,
      },
      session,
    )

    return { transferOut, transferIn }
  })
}

export async function getBalance(
  organizationId: Types.ObjectId,
  locationId: Types.ObjectId,
  variantId: Types.ObjectId,
): Promise<StockBalanceDocument | null> {
  return stockBalanceRepository.findByVariantAndLocation(organizationId, locationId, variantId)
}

export async function listTransactions(
  organizationId: Types.ObjectId,
  filter: ListInventoryTransactionsFilter,
  options: ListInventoryTransactionsOptions,
): Promise<ListInventoryTransactionsResult> {
  return inventoryTransactionRepository.list(organizationId, filter, options)
}
