const DUPLICATE_KEY_ERROR_CODE = 11000

// Deliberately NOT imported from another module's own copy — each module
// keeps this check local, per established convention. Not currently
// exercised (checkout.service.ts never creates anything with a unique
// index of its own — Order creation goes through the orders module's own
// repository), kept for structural consistency with every other module.
export function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === DUPLICATE_KEY_ERROR_CODE
  )
}
