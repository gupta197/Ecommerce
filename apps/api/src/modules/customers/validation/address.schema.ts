import { z } from 'zod'

const recipientNameSchema = z.string().trim().min(1).max(200)
const phoneSchema = z.string().trim().min(1).max(20)
const addressLineSchema = z.string().trim().min(1).max(200)
const cityStateSchema = z.string().trim().min(1).max(100)
const postalCodeSchema = z.string().trim().min(1).max(20)
const countrySchema = z.string().trim().min(1).max(100)

// customerId, isDefaultBilling, isDefaultShipping, and status are all
// deliberately absent from both schemas — customerId is always derived
// server-side from the authenticated caller's own Customer profile, the
// default flags are only ever changed via setDefaultAddressSchema below
// (through address.service.ts's dedicated, transactional setDefaultAddress),
// and status only changes through archiveAddress (approved decisions).
export const createAddressSchema = z
  .object({
    recipientName: recipientNameSchema,
    phone: phoneSchema.optional(),
    line1: addressLineSchema,
    line2: addressLineSchema.optional(),
    city: cityStateSchema,
    state: cityStateSchema,
    postalCode: postalCodeSchema,
    country: countrySchema,
  })
  .strict()

export const updateAddressSchema = z
  .object({
    recipientName: recipientNameSchema,
    phone: phoneSchema,
    line1: addressLineSchema,
    line2: addressLineSchema,
    city: cityStateSchema,
    state: cityStateSchema,
    postalCode: postalCodeSchema,
    country: countrySchema,
  })
  .partial()
  .strict()

export const ADDRESS_DEFAULT_TYPE_VALUES = ['billing', 'shipping'] as const
export type AddressDefaultType = (typeof ADDRESS_DEFAULT_TYPE_VALUES)[number]

export const setDefaultAddressSchema = z
  .object({
    type: z.enum(ADDRESS_DEFAULT_TYPE_VALUES),
  })
  .strict()

export type CreateAddressInput = z.infer<typeof createAddressSchema>
export type UpdateAddressInput = z.infer<typeof updateAddressSchema>
export type SetDefaultAddressInput = z.infer<typeof setDefaultAddressSchema>
