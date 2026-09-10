import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import request from 'supertest'
import { createRateLimiter } from './rate-limit.js'

test('rate limiter blocks requests after the configured threshold', async () => {
  const app = express()
  app.use(createRateLimiter({ windowMs: 60_000, max: 2 }))
  app.get('/', (_req, res) => res.status(200).json({ ok: true }))

  await request(app).get('/').expect(200)
  await request(app).get('/').expect(200)
  const blocked = await request(app).get('/')

  assert.equal(blocked.status, 429)
  const body = blocked.body as { error: { code: string } }
  assert.equal(body.error.code, 'RATE_LIMITED')
})
