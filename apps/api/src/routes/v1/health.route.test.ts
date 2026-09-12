import { test } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { loadConfig } from '../../config/env.js'
import { createLogger } from '../../lib/logger.js'
import { createApp } from '../../app.js'

function buildTestApp() {
  const config = loadConfig({
    NODE_ENV: 'test',
    CORS_ORIGIN: 'http://localhost:5173',
    LOG_LEVEL: 'silent',
    MONGODB_URI: 'mongodb://localhost:27017',
    MONGODB_DB_NAME: 'db_001_test',
  } as NodeJS.ProcessEnv)
  const logger = createLogger(config)
  return createApp(config, logger)
}

test('GET /api/v1/health returns 200 with the standard success envelope', async () => {
  const app = buildTestApp()
  const res = await request(app).get('/api/v1/health')

  assert.equal(res.status, 200)
  assert.equal(res.body.success, true)
  assert.equal(res.body.data.status, 'ok')
  assert.equal(typeof res.body.data.uptime, 'number')
  assert.equal(typeof res.body.data.timestamp, 'string')
})

test('unmatched route returns the standardized 404 envelope', async () => {
  const app = buildTestApp()
  const res = await request(app).get('/api/v1/does-not-exist')

  assert.equal(res.status, 404)
  assert.equal(res.body.success, false)
  assert.equal(res.body.error.code, 'NOT_FOUND')
})
