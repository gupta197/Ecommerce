import { test } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { MongoMemoryServer } from 'mongodb-memory-server'
import mongoose from 'mongoose'
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
    JWT_ACCESS_TOKEN_SECRET: 'x'.repeat(32),
  } as NodeJS.ProcessEnv)
  const logger = createLogger(config)
  return createApp(config, logger)
}

test('GET /api/v1/ready returns 503 with the standard error envelope when MongoDB is not connected', async () => {
  const app = buildTestApp()
  const res = await request(app).get('/api/v1/ready')

  assert.equal(res.status, 503)
  assert.equal(res.body.success, false)
  assert.equal(res.body.error.code, 'NOT_READY')
})

test('GET /api/v1/ready returns 200 with the standard success envelope when MongoDB is connected', async () => {
  const mongod = await MongoMemoryServer.create()
  try {
    await mongoose.connect(mongod.getUri(), { dbName: 'db_001_ready_test' })

    const app = buildTestApp()
    const res = await request(app).get('/api/v1/ready')

    assert.equal(res.status, 200)
    assert.equal(res.body.success, true)
    assert.equal(res.body.data.status, 'ok')
  } finally {
    await mongoose.disconnect()
    await mongod.stop()
  }
})
