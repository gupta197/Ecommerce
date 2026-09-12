import { z } from 'zod'
import { Types } from 'mongoose'

/**
 * A 24-character hex string that is also accepted by mongoose's own
 * ObjectId.isValid. The regex check matters on its own: ObjectId.isValid
 * also (surprisingly) accepts any 12-character string, treating it as raw
 * bytes — requiring the 24-hex-char shape first avoids that false positive.
 */
export const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Invalid ObjectId')
  .refine((value) => Types.ObjectId.isValid(value), { message: 'Invalid ObjectId' })

export const slugSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    'Slug must be lowercase alphanumeric segments separated by single hyphens',
  )

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export type Pagination = z.infer<typeof paginationSchema>
