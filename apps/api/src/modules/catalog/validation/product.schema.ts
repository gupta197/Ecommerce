import { z } from 'zod'
import { objectIdSchema, slugSchema } from './common.schema.js'

export const PRODUCT_STATUS_VALUES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const
export const productStatusSchema = z.enum(PRODUCT_STATUS_VALUES)

const productMediaItemSchema = z
  .object({
    url: z.string().trim().url(),
    altText: z.string().trim().max(200).optional(),
  })
  .strict()

// Max 10 items, array order is display order, no isPrimary field — locked
// CAT-003 decision.
const productMediaSchema = z.array(productMediaItemSchema).max(10)

export const createProductSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    slug: slugSchema.optional(),
    description: z.string().trim().max(2000).optional(),
    categoryId: objectIdSchema.optional(),
    brandId: objectIdSchema.optional(),
    media: productMediaSchema.optional(),
    status: productStatusSchema.default('DRAFT'),
  })
  .strict()

// .partial() makes every field optional (omitted = "don't change"); categoryId
// and brandId stay independently nullable so an explicit `null` means
// "remove this reference," distinct from omitting the field entirely —
// mirroring category.schema.ts's parentId convention exactly.
export const updateProductSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    slug: slugSchema,
    description: z.string().trim().max(2000),
    categoryId: objectIdSchema.nullable(),
    brandId: objectIdSchema.nullable(),
    media: productMediaSchema,
    status: productStatusSchema,
  })
  .partial()
  .strict()

export const productListQuerySchema = z
  .object({
    categoryId: objectIdSchema.optional(),
    brandId: objectIdSchema.optional(),
    status: productStatusSchema.optional(),
  })
  .strict()

export type CreateProductInput = z.infer<typeof createProductSchema>
export type UpdateProductInput = z.infer<typeof updateProductSchema>
export type ProductListQuery = z.infer<typeof productListQuerySchema>
