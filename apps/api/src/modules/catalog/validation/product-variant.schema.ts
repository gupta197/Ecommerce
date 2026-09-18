import { z } from 'zod'
import { objectIdSchema } from './common.schema.js'

export const PRODUCT_VARIANT_STATUS_VALUES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const
export const productVariantStatusSchema = z.enum(PRODUCT_VARIANT_STATUS_VALUES)

const SKU_MAX_LENGTH = 64
const SKU_PATTERN = /^[A-Z0-9](?:[A-Z0-9_-]*[A-Z0-9])?$/

// Normalized (trimmed, uppercased) here in the schema itself so every caller
// — create and update alike — gets the same canonical value before it is
// ever used for a duplicate check or persisted. The database's
// {organizationId, sku} unique index remains the ultimate concurrency
// guarantee; this normalization only prevents "sku-1" vs "SKU-1" ambiguity.
export const skuSchema = z
  .string()
  .trim()
  .min(1)
  .max(SKU_MAX_LENGTH)
  .transform((value) => value.toUpperCase())
  .pipe(
    z
      .string()
      .regex(SKU_PATTERN, 'SKU must be alphanumeric, with optional internal hyphens/underscores'),
  )

const BARCODE_MAX_LENGTH = 64

// Trim + bounded non-empty string only — deliberately no digits-only or
// checksum/symbology enforcement (locked CAT-004 decision; deferred to a
// future scanning/inventory requirement).
export const barcodeSchema = z.string().trim().min(1).max(BARCODE_MAX_LENGTH)

// Integer minor units (e.g. paise), per existing ADR-008 — not new
// architecture. .finite() rejects NaN/Infinity/-Infinity; .int() rejects
// fractional values; .nonnegative() rejects negative values.
export const moneySchema = z.number().finite().int().nonnegative()

const ATTRIBUTE_KEY_MAX_LENGTH = 50
const ATTRIBUTE_STRING_VALUE_MAX_LENGTH = 200
const MAX_ATTRIBUTES = 30
const ATTRIBUTE_KEY_PATTERN = /^[a-zA-Z0-9 _-]+$/
const FORBIDDEN_ATTRIBUTE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

// Array of {key, value} pairs — never a Record<string, unknown> — so an
// attacker-supplied key is only ever a string value inside a fixed-shape
// object, never used as a dynamic object property name. This structurally
// rules out prototype pollution regardless of what a key contains; the
// __proto__/constructor/prototype ban below is an explicit belt-and-suspenders
// layer on top of that, not the only protection.
const productVariantAttributeItemSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(ATTRIBUTE_KEY_MAX_LENGTH)
      .regex(
        ATTRIBUTE_KEY_PATTERN,
        'Attribute key may only contain letters, digits, spaces, hyphens, and underscores',
      )
      .refine((value) => !FORBIDDEN_ATTRIBUTE_KEYS.has(value.toLowerCase()), {
        message: 'Attribute key is not allowed',
      }),
    value: z.union([
      z.string().trim().max(ATTRIBUTE_STRING_VALUE_MAX_LENGTH),
      z.number().finite(),
      z.boolean(),
    ]),
  })
  .strict()

export const productVariantAttributesSchema = z
  .array(productVariantAttributeItemSchema)
  .max(MAX_ATTRIBUTES)
  .refine(
    (items) => {
      const seen = new Set<string>()
      for (const item of items) {
        const normalizedKey = item.key.toLowerCase()
        if (seen.has(normalizedKey)) {
          return false
        }
        seen.add(normalizedKey)
      }
      return true
    },
    { message: 'Duplicate attribute keys (case-insensitive) are not allowed' },
  )

export const createProductVariantSchema = z
  .object({
    productId: objectIdSchema,
    sku: skuSchema,
    barcode: barcodeSchema.optional(),
    price: moneySchema,
    compareAtPrice: moneySchema.optional(),
    cost: moneySchema.optional(),
    attributes: productVariantAttributesSchema.optional(),
    status: productVariantStatusSchema.default('DRAFT'),
  })
  .strict()

// productId is deliberately absent from the update schema entirely — not
// nullable, not optional-but-present — a variant's product relationship is
// immutable once created (locked CAT-004 decision).
export const updateProductVariantSchema = z
  .object({
    sku: skuSchema,
    barcode: barcodeSchema,
    price: moneySchema,
    compareAtPrice: moneySchema,
    cost: moneySchema,
    attributes: productVariantAttributesSchema,
    status: productVariantStatusSchema,
  })
  .partial()
  .strict()

export const productVariantListQuerySchema = z
  .object({
    productId: objectIdSchema.optional(),
    status: productVariantStatusSchema.optional(),
  })
  .strict()

export type CreateProductVariantInput = z.infer<typeof createProductVariantSchema>
export type UpdateProductVariantInput = z.infer<typeof updateProductVariantSchema>
export type ProductVariantListQuery = z.infer<typeof productVariantListQuerySchema>
