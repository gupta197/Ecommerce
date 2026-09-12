import { parseCookie } from 'cookie'

/** Parses a raw `Cookie` request header. Never throws on a missing/malformed
 *  header — returns an empty object instead.
 *
 *  Note: `cookie@2.x` renamed its exports from `parse`/`serialize` (the
 *  shape Express itself still depends on internally, via an older `cookie`
 *  major) to `parseCookie`/`stringifyCookie` — verified against the actually
 *  installed package rather than assumed from the 0.x API. */
export function parseCookies(cookieHeader: string | undefined): Record<string, string | undefined> {
  if (!cookieHeader) {
    return {}
  }
  return parseCookie(cookieHeader)
}

export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  return parseCookies(cookieHeader)[name]
}
