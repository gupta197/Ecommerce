import { z } from 'zod'
import { slugSchema } from './common.schema.js'

export const BRAND_STATUS_VALUES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const
export const brandStatusSchema = z.enum(BRAND_STATUS_VALUES)

const brandLogoSchema = z
  .object({
    url: z.string().trim().url(),
    altText: z.string().trim().max(200).optional(),
  })
  .strict()

export const createBrandSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    slug: slugSchema.optional(),
    description: z.string().trim().max(2000).optional(),
    logo: brandLogoSchema.optional(),
    status: brandStatusSchema.default('DRAFT'),
  })
  .strict()

export const updateBrandSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    slug: slugSchema,
    description: z.string().trim().max(2000),
    logo: brandLogoSchema,
    status: brandStatusSchema,
  })
  .partial()
  .strict()

export const brandListQuerySchema = z
  .object({
    status: brandStatusSchema.optional(),
  })
  .strict()

export type CreateBrandInput = z.infer<typeof createBrandSchema>
export type UpdateBrandInput = z.infer<typeof updateBrandSchema>
export type BrandListQuery = z.infer<typeof brandListQuerySchema>
