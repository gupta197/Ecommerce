import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { NextFunction, Request, Response } from 'express'
import { createCsrfMiddleware } from './csrf.js'
import { ValidationError } from '../lib/http-errors.js'

const ALLOWED_ORIGINS = ['https://app.example.com']
const csrf = createCsrfMiddleware({ allowedOrigins: ALLOWED_ORIGINS })

function fakeRequest(overrides: Partial<Request> = {}): Request {
  return { headers: {}, ...overrides } as Request
}

function runMiddleware(req: Request): Promise<unknown> {
  return new Promise((resolve) => {
    const next: NextFunction = ((error?: unknown) => resolve(error)) as NextFunction
    csrf(req, {} as Response, next)
  })
}

test('passes with a matching double-submit token and a valid Origin', async () => {
  const req = fakeRequest({
    headers: {
      origin: 'https://app.example.com',
      cookie: 'xsrf_token=token-123',
      'x-xsrf-token': 'token-123',
    },
  })
  const error = await runMiddleware(req)
  assert.equal(error, undefined)
})

test('rejects a mismatched double-submit token', async () => {
  const req = fakeRequest({
    headers: {
      origin: 'https://app.example.com',
      cookie: 'xsrf_token=token-123',
      'x-xsrf-token': 'token-different',
    },
  })
  const error = await runMiddleware(req)
  assert.ok(error instanceof ValidationError)
})

test('rejects a missing CSRF cookie', async () => {
  const req = fakeRequest({
    headers: { origin: 'https://app.example.com', 'x-xsrf-token': 'token-123' },
  })
  const error = await runMiddleware(req)
  assert.ok(error instanceof ValidationError)
})

test('rejects a missing CSRF header', async () => {
  const req = fakeRequest({
    headers: { origin: 'https://app.example.com', cookie: 'xsrf_token=token-123' },
  })
  const error = await runMiddleware(req)
  assert.ok(error instanceof ValidationError)
})

test('rejects a disallowed Origin even with a matching double-submit token', async () => {
  const req = fakeRequest({
    headers: {
      origin: 'https://evil.example.com',
      cookie: 'xsrf_token=token-123',
      'x-xsrf-token': 'token-123',
    },
  })
  const error = await runMiddleware(req)
  assert.ok(error instanceof ValidationError)
})

test('falls back to a valid Referer origin when Origin is absent', async () => {
  const req = fakeRequest({
    headers: {
      referer: 'https://app.example.com/some/page',
      cookie: 'xsrf_token=token-123',
      'x-xsrf-token': 'token-123',
    },
  })
  const error = await runMiddleware(req)
  assert.equal(error, undefined)
})

test('rejects a disallowed Referer origin when Origin is absent', async () => {
  const req = fakeRequest({
    headers: {
      referer: 'https://evil.example.com/some/page',
      cookie: 'xsrf_token=token-123',
      'x-xsrf-token': 'token-123',
    },
  })
  const error = await runMiddleware(req)
  assert.ok(error instanceof ValidationError)
})

test('rejects a malformed Referer header when Origin is absent', async () => {
  const req = fakeRequest({
    headers: {
      referer: 'not-a-valid-url',
      cookie: 'xsrf_token=token-123',
      'x-xsrf-token': 'token-123',
    },
  })
  const error = await runMiddleware(req)
  assert.ok(error instanceof ValidationError)
})

test('does not hard-fail solely for missing Origin and Referer — the double-submit token remains the primary control', async () => {
  const req = fakeRequest({
    headers: { cookie: 'xsrf_token=token-123', 'x-xsrf-token': 'token-123' },
  })
  const error = await runMiddleware(req)
  assert.equal(error, undefined)
})
