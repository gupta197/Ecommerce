import { z } from 'zod'
import { objectIdSchema } from './common.schema.js'

// TRANSFER_IN/TRANSFER_OUT are deliberately excluded — they can only ever be
// produced by recordTransfer(), never accepted as direct caller input to
// recordTransaction() (locked INV-001 decision).
export const RECORD_TRANSACTION_TYPE_VALUES = [
  'PURCHASE',
  'SALE',
  'RETURN',
  'ADJUSTMENT',
  'DAMAGE',
  'OPENING_BALANCE',
] as const
export type RecordTransactionType = (typeof RECORD_TRANSACTION_TYPE_VALUES)[number]

export const ADJUSTMENT_DIRECTION_VALUES = ['INCREASE', 'DECREASE'] as const
export const adjustmentDirectionSchema = z.enum(ADJUSTMENT_DIRECTION_VALUES)

const NOTE_MAX_LENGTH = 500

// Strictly positive: integer, finite, non-zero, non-negative, no fractional
// values — rejects 0, -1, 1.5, NaN, Infinity, -Infinity, and (via the base
// z.number() type check) strings/null/arrays/objects. Direction is carried
// entirely by `type`/`adjustmentDirection`, never by the sign of this value.
export const positiveQuantitySchema = z.number().finite().int().positive()

const baseRecordTransactionSchema = z
  .object({
    variantId: objectIdSchema,
    locationId: objectIdSchema,
    type: z.enum(RECORD_TRANSACTION_TYPE_VALUES),
    quantity: positiveQuantitySchema,
    adjustmentDirection: adjustmentDirectionSchema.optional(),
    note: z.string().trim().max(NOTE_MAX_LENGTH).optional(),
  })
  .strict()

// ADJUSTMENT requires adjustmentDirection; every other type must omit it —
// a plain "unsigned quantity + type implies direction" mapping is NOT
// sufficient for ADJUSTMENT alone, which can mean either direction (locked
// INV-001 decision).
export const recordTransactionSchema = baseRecordTransactionSchema.superRefine((data, ctx) => {
  if (data.type === 'ADJUSTMENT') {
    if (data.adjustmentDirection === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['adjustmentDirection'],
        message: 'adjustmentDirection is required for ADJUSTMENT transactions',
      })
    }
  } else if (data.adjustmentDirection !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['adjustmentDirection'],
      message: 'adjustmentDirection is only valid for ADJUSTMENT transactions',
    })
  }
})

export const recordTransferSchema = z
  .object({
    variantId: objectIdSchema,
    fromLocationId: objectIdSchema,
    toLocationId: objectIdSchema,
    quantity: positiveQuantitySchema,
    note: z.string().trim().max(NOTE_MAX_LENGTH).optional(),
  })
  .strict()

export type RecordTransactionInput = z.infer<typeof recordTransactionSchema>
export type RecordTransferInput = z.infer<typeof recordTransferSchema>
