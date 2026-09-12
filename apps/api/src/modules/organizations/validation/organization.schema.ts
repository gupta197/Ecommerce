import { z } from 'zod'
import { Types } from 'mongoose'
import { MEMBERSHIP_ROLES } from '../models/organization-membership.model.js'
import { ORGANIZATION_STATUSES } from '../models/organization.model.js'

// Deliberately local to modules/organizations — NOT imported from
// modules/auth's or modules/catalog's own copies. Cross-module sharing of
// this validator is a separate decision to make explicitly if it's ever
// genuinely needed, not something to bundle into this task.
export const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Invalid ObjectId')
  .refine((value) => Types.ObjectId.isValid(value), { message: 'Invalid ObjectId' })

export const createOrganizationSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
  })
  .strict()

// activeOwnerCount is intentionally absent — it is never client-settable,
// even via this update path. Only name/status may be changed here.
export const updateOrganizationSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    status: z.enum(ORGANIZATION_STATUSES).optional(),
  })
  .strict()

export const addMemberSchema = z
  .object({
    userId: objectIdSchema,
  })
  .strict()

export const changeRoleSchema = z
  .object({
    role: z.enum(MEMBERSHIP_ROLES),
  })
  .strict()

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>
export type AddMemberInput = z.infer<typeof addMemberSchema>
export type ChangeRoleInput = z.infer<typeof changeRoleSchema>
