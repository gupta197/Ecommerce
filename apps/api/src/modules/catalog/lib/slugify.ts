/**
 * Converts arbitrary text into a lowercase, hyphenated slug: normalizes and
 * strips diacritics, then replaces any run of non-alphanumeric characters
 * with a single hyphen and trims leading/trailing hyphens.
 *
 * Degenerate input (empty, or entirely non-alphanumeric) produces an empty
 * string — callers must decide their own fallback (see category.service.ts).
 */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
