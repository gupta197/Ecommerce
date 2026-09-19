const DUPLICATE_KEY_ERROR_CODE = 11000

// Deliberately NOT imported from another module's own copy — each module
// keeps this check local, per established convention. Not currently
// exercised by order.repository.ts (Order has no unique index in COM-003),
// but kept for structural consistency with every other module and for
// immediate availability once COM-004 adds operations that might need it.
export function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === DUPLICATE_KEY_ERROR_CODE
  )
}
