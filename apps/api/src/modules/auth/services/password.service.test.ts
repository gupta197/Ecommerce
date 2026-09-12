import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashPassword, verifyPassword } from './password.service.js'

test('hashPassword produces a non-plaintext, Argon2id-formatted hash', async () => {
  const hash = await hashPassword('correct horse battery staple')
  assert.notEqual(hash, 'correct horse battery staple')
  assert.ok(hash.startsWith('$argon2id$'))
})

test('verifyPassword accepts the correct password', async () => {
  const hash = await hashPassword('correct horse battery staple')
  assert.equal(await verifyPassword(hash, 'correct horse battery staple'), true)
})

test('verifyPassword rejects an incorrect password', async () => {
  const hash = await hashPassword('correct horse battery staple')
  assert.equal(await verifyPassword(hash, 'wrong password'), false)
})

test('hashing the same password twice produces different hashes (random salt)', async () => {
  const hashA = await hashPassword('correct horse battery staple')
  const hashB = await hashPassword('correct horse battery staple')
  assert.notEqual(hashA, hashB)
})
