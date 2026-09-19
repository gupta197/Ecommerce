import { z } from 'zod'

// status is deliberately absent from both schemas — a customer's lifecycle
// changes only through the dedicated archiveCustomerProfile/
// restoreCustomerProfile service functions, never through this general
// profile update path (approved decision).
export const createCustomerSchema = z
  .object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    displayName: z.string().trim().min(1).max(100).optional(),
    phone: z.string().trim().min(1).max(20).optional(),
  })
  .strict()

export const updateCustomerSchema = z
  .object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    displayName: z.string().trim().min(1).max(100),
    phone: z.string().trim().min(1).max(20),
  })
  .partial()
  .strict()

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>
