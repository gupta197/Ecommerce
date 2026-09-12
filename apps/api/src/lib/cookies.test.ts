import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCookies, readCookie } from './cookies.js'

test('parseCookies returns an empty object for an undefined header', () => {
  assert.deepEqual(parseCookies(undefined), {})
})

test('parseCookies returns an empty object for an empty string header', () => {
  assert.deepEqual(parseCookies(''), {})
})

test('parseCookies parses a single cookie', () => {
  assert.deepEqual({ ...parseCookies('foo=bar') }, { foo: 'bar' })
})

test('parseCookies parses multiple cookies', () => {
  const result = parseCookies('foo=bar; baz=qux')
  assert.equal(result.foo, 'bar')
  assert.equal(result.baz, 'qux')
})

test('readCookie returns the named value when present', () => {
  assert.equal(readCookie('access_token=abc123; other=xyz', 'access_token'), 'abc123')
})

test('readCookie returns undefined when the named cookie is absent', () => {
  assert.equal(readCookie('other=xyz', 'access_token'), undefined)
})

test('readCookie returns undefined for an undefined header', () => {
  assert.equal(readCookie(undefined, 'access_token'), undefined)
})

test('readCookie does not throw on a malformed header', () => {
  assert.doesNotThrow(() => readCookie('this is not; a=valid=cookie==', 'access_token'))
})
