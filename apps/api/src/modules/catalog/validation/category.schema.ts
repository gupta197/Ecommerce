import { z } from 'zod'
import { objectIdSchema, slugSchema } from './common.schema.js'

export const CATEGORY_STATUS_VALUES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const
export const categoryStatusSchema = z.enum(CATEGORY_STATUS_VALUES)

export const createCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    slug: slugSchema.optional(),
    description: z.string().trim().max(2000).optional(),
    parentId: objectIdSchema.optional(),
    status: categoryStatusSchema.default('DRAFT'),
    sortOrder: z.coerce.number().int().default(0),
  })
  .strict()

// .partial() makes every field optional (omitted = "don't change"); parentId
// stays independently nullable so an explicit `null` means "move to root",
// which is different from omitting the field entirely.
export const updateCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    slug: slugSchema,
    description: z.string().trim().max(2000),
    parentId: objectIdSchema.nullable(),
    status: categoryStatusSchema,
    sortOrder: z.coerce.number().int(),
  })
  .partial()
  .strict()

export const categoryListQuerySchema = z
  .object({
    parentId: objectIdSchema.nullable().optional(),
    status: categoryStatusSchema.optional(),
  })
  .strict()

export type CreateCategoryInput = z.infer<typeof createCategorySchema>
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>
export type CategoryListQuery = z.infer<typeof categoryListQuerySchema>
