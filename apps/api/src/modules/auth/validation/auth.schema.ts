import { z } from 'zod'
import { Types } from 'mongoose'

// Deliberately local to modules/auth — NOT imported from
// modules/catalog/validation/common.schema.ts. Cross-module sharing between
// auth and catalog is an explicit architectural decision to make separately
// if it's ever genuinely needed, not something to bundle into this task.
export const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Invalid ObjectId')
  .refine((value) => Types.ObjectId.isValid(value), { message: 'Invalid ObjectId' })

export const registerSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320),
    password: z.string().min(10).max(200),
  })
  .strict()

export const loginSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320),
    password: z.string().min(1).max(200),
  })
  .strict()

export const sessionIdParamSchema = z.object({ id: objectIdSchema }).strict()

export type RegisterInput = z.infer<typeof registerSchema>
export type LoginInput = z.infer<typeof loginSchema>
