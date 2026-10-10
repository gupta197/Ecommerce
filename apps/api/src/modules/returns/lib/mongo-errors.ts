const DUPLICATE_KEY_ERROR_CODE = 11000

// Deliberately NOT imported from another module's own copy — each module
// keeps this check local, per established convention. Used by
// return-request-lock.repository.ts, whose unique {orderId} index this
// check is the defense-in-depth counterpart of.
export function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === DUPLICATE_KEY_ERROR_CODE
  )
}
