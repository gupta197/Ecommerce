import { z } from 'zod'

export const LOCATION_STATUS_VALUES = ['ACTIVE', 'ARCHIVED'] as const
export const locationStatusSchema = z.enum(LOCATION_STATUS_VALUES)

const LOCATION_CODE_MAX_LENGTH = 50

export const locationCodeSchema = z.string().trim().min(1).max(LOCATION_CODE_MAX_LENGTH)

export const createLocationSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    code: locationCodeSchema.optional(),
    status: locationStatusSchema.default('ACTIVE'),
  })
  .strict()

export const updateLocationSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    code: locationCodeSchema,
    status: locationStatusSchema,
  })
  .partial()
  .strict()

export type CreateLocationInput = z.infer<typeof createLocationSchema>
export type UpdateLocationInput = z.infer<typeof updateLocationSchema>
