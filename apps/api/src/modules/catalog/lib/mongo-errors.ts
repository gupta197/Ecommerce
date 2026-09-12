const DUPLICATE_KEY_ERROR_CODE = 11000

/** True for a raw MongoDB/Mongoose duplicate-key error (E11000) on a unique
 *  index — the model-agnostic signal a repository's create/update should
 *  translate into a domain-specific conflict error. */
export function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === DUPLICATE_KEY_ERROR_CODE
  )
}
