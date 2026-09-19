import { z } from 'zod'
import { Types } from 'mongoose'

// Deliberately NOT imported from another module's own copy — each module
// keeps this local, per established convention (see e.g.
// organization-membership.repository.ts's own local isDuplicateKeyError()).
export const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Invalid ObjectId')
  .refine((value) => Types.ObjectId.isValid(value), { message: 'Invalid ObjectId' })
