import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Request, Response, NextFunction } from 'express'
import { createErrorHandler } from './error-handler.js'
import { ValidationError } from '../lib/http-errors.js'
import { createLogger } from '../lib/logger.js'

function mockRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code
      return res
    },
    json(body: unknown) {
      res.body = body
      return res
    },
  }
  return res
}

const silentLogger = createLogger({ logLevel: 'silent' })
const noop: NextFunction = () => {}

test('AppError subclasses map to their declared status/code with no stack trace leak', () => {
  const handler = createErrorHandler(silentLogger)
  const res = mockRes()
  const err = new ValidationError('Bad input', [{ path: 'email', message: 'Required' }])

  handler(err, { id: 'test-req' } as Request, res as unknown as Response, noop)

  assert.equal(res.statusCode, 422)
  const body = res.body as { success: boolean; error: { code: string } }
  assert.equal(body.success, false)
  assert.equal(body.error.code, 'VALIDATION_ERROR')
  assert.equal(JSON.stringify(res.body).includes('at '), false)
})

test('unknown errors fall back to 500 INTERNAL_ERROR without leaking the message', () => {
  const handler = createErrorHandler(silentLogger)
  const res = mockRes()
  const err = new Error('some internal secret detail')

  handler(err, { id: 'test-req' } as Request, res as unknown as Response, noop)

  assert.equal(res.statusCode, 500)
  const body = res.body as { error: { code: string; message: string } }
  assert.equal(body.error.code, 'INTERNAL_ERROR')
  assert.equal(body.error.message.includes('secret'), false)
})
