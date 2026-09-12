import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { MongoMemoryServer } from 'mongodb-memory-server'
import pino from 'pino'
import { loadConfig } from '../config/env.js'
import { createLogger } from '../lib/logger.js'
import { connectDatabase, disconnectDatabase, isDatabaseReady } from './connection.js'

function testConfig(overrides: Record<string, string>) {
  return loadConfig({
    NODE_ENV: 'test',
    CORS_ORIGIN: 'http://localhost:5173',
    LOG_LEVEL: 'silent',
    MONGODB_DB_NAME: 'db_001_test',
    ...overrides,
  } as NodeJS.ProcessEnv)
}

test('connectDatabase connects successfully and isDatabaseReady reflects state', async () => {
  const mongod = await MongoMemoryServer.create()
  try {
    const config = testConfig({ MONGODB_URI: mongod.getUri() })
    const logger = createLogger(config)

    assert.equal(isDatabaseReady(), false)
    await connectDatabase(config, logger)
    assert.equal(isDatabaseReady(), true)

    await disconnectDatabase(logger)
    assert.equal(isDatabaseReady(), false)
  } finally {
    await mongod.stop()
  }
})

test('connectDatabase gives up after the configured retry budget against an unreachable host', async () => {
  const config = testConfig({
    MONGODB_URI: 'mongodb://127.0.0.1:1',
    MONGODB_SERVER_SELECTION_TIMEOUT_MS: '200',
    MONGODB_INITIAL_CONNECT_RETRIES: '1',
    MONGODB_INITIAL_CONNECT_RETRY_DELAY_MS: '50',
  })
  const logger = createLogger(config)

  await assert.rejects(() => connectDatabase(config, logger))
})

test('connection log output never contains the connection string', async () => {
  const mongod = await MongoMemoryServer.create()
  try {
    const uri = mongod.getUri()
    const config = testConfig({ MONGODB_URI: uri, LOG_LEVEL: 'info' })

    const chunks: string[] = []
    const stream = new Writable({
      write(chunk: Buffer, _enc, callback) {
        chunks.push(chunk.toString())
        callback()
      },
    })
    const logger = pino({ level: config.logLevel }, stream)

    await connectDatabase(config, logger)
    await disconnectDatabase(logger)

    const output = chunks.join('')
    assert.equal(output.includes(uri), false)
  } finally {
    await mongod.stop()
  }
})
