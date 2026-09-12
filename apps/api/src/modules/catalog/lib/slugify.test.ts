import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slugify } from './slugify.js'

test('lowercases and hyphenates spaces', () => {
  assert.equal(slugify('Men Innerwear'), 'men-innerwear')
})

test('strips diacritics', () => {
  assert.equal(slugify('Café Déjà Vu'), 'cafe-deja-vu')
})

test('replaces punctuation runs with a single hyphen', () => {
  assert.equal(slugify("Men's / Innerwear!!"), 'men-s-innerwear')
})

test('trims leading and trailing hyphens', () => {
  assert.equal(slugify('  --Vests--  '), 'vests')
})

test('collapses multiple separators into one hyphen', () => {
  assert.equal(slugify('Men   &   Women'), 'men-women')
})

test('returns an empty string for empty input', () => {
  assert.equal(slugify(''), '')
})

test('returns an empty string for entirely non-alphanumeric input', () => {
  assert.equal(slugify('!!! ---'), '')
})
