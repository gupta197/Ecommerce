import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, ConfigError } from './env.js'

test('valid development env parses with sensible defaults', () => {
  const config = loadConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)
  assert.equal(config.nodeEnv, 'development')
  assert.equal(config.port, 4000)
  assert.deepEqual(config.corsOrigins, ['http://localhost:5173', 'http://localhost:5174'])
})

test('production without CORS_ORIGIN fails fast', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv), ConfigError)
})

test('production with CORS_ORIGIN="*" fails fast', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production', CORS_ORIGIN: '*' } as NodeJS.ProcessEnv),
    ConfigError,
  )
})

test('production with a valid explicit CORS_ORIGIN succeeds', () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    CORS_ORIGIN: 'https://shop.example.com',
  } as NodeJS.ProcessEnv)
  assert.deepEqual(config.corsOrigins, ['https://shop.example.com'])
})
