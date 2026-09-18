import { z } from 'zod'
import { Types } from 'mongoose'

// Deliberately NOT imported from modules/catalog's own copy — each module
// keeps this local, per established convention (see e.g.
// organization-membership.repository.ts's own local isDuplicateKeyError()).
export const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Invalid ObjectId')
  .refine((value) => Types.ObjectId.isValid(value), { message: 'Invalid ObjectId' })

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export type Pagination = z.infer<typeof paginationSchema>
