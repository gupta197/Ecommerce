import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isDuplicateKeyError } from './mongo-errors.js'

test('recognizes a MongoDB duplicate-key error (code 11000)', () => {
  assert.equal(isDuplicateKeyError({ code: 11000 }), true)
})

test('rejects an unrelated error code', () => {
  assert.equal(isDuplicateKeyError({ code: 121 }), false)
  assert.equal(isDuplicateKeyError(new Error('boom')), false)
})

test('handles non-object input safely', () => {
  assert.equal(isDuplicateKeyError(null), false)
  assert.equal(isDuplicateKeyError(undefined), false)
  assert.equal(isDuplicateKeyError('error'), false)
  assert.equal(isDuplicateKeyError(42), false)
})
