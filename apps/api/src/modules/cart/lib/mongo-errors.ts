const DUPLICATE_KEY_ERROR_CODE = 11000

// Deliberately NOT imported from another module's own copy — each module
// keeps this check local, per established convention.
export function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === DUPLICATE_KEY_ERROR_CODE
  )
}
