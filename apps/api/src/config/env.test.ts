import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, ConfigError } from './env.js'

const baseMongo = {
  MONGODB_URI: 'mongodb://localhost:27017',
  MONGODB_DB_NAME: 'db_001_test',
}

const validProdMongo = {
  MONGODB_URI: 'mongodb+srv://cluster0.example.mongodb.net',
  MONGODB_DB_NAME: 'ecommerce_prod',
}

test('valid development env parses with sensible defaults', () => {
  const config = loadConfig({ NODE_ENV: 'development', ...baseMongo } as NodeJS.ProcessEnv)
  assert.equal(config.nodeEnv, 'development')
  assert.equal(config.port, 4000)
  assert.deepEqual(config.corsOrigins, ['http://localhost:5173', 'http://localhost:5174'])
  assert.equal(config.mongo.uri, baseMongo.MONGODB_URI)
  assert.equal(config.mongo.dbName, baseMongo.MONGODB_DB_NAME)
})

test('production without CORS_ORIGIN fails fast', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production', ...validProdMongo } as NodeJS.ProcessEnv),
    ConfigError,
  )
})

test('production with CORS_ORIGIN="*" fails fast', () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: 'production',
        CORS_ORIGIN: '*',
        ...validProdMongo,
      } as NodeJS.ProcessEnv),
    ConfigError,
  )
})

test('production with a valid explicit CORS_ORIGIN succeeds', () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    CORS_ORIGIN: 'https://shop.example.com',
    ...validProdMongo,
  } as NodeJS.ProcessEnv)
  assert.deepEqual(config.corsOrigins, ['https://shop.example.com'])
})

test('production with a localhost MONGODB_URI fails fast', () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: 'production',
        CORS_ORIGIN: 'https://shop.example.com',
        MONGODB_URI: 'mongodb://localhost:27017',
        MONGODB_DB_NAME: 'ecommerce_prod',
      } as NodeJS.ProcessEnv),
    ConfigError,
  )
})

test('production with a 127.0.0.1 MONGODB_URI fails fast', () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: 'production',
        CORS_ORIGIN: 'https://shop.example.com',
        MONGODB_URI: 'mongodb://127.0.0.1:27017',
        MONGODB_DB_NAME: 'ecommerce_prod',
      } as NodeJS.ProcessEnv),
    ConfigError,
  )
})

test('production with a non-TLS, non-srv MONGODB_URI fails fast', () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: 'production',
        CORS_ORIGIN: 'https://shop.example.com',
        MONGODB_URI: 'mongodb://db.internal.example.com:27017',
        MONGODB_DB_NAME: 'ecommerce_prod',
      } as NodeJS.ProcessEnv),
    ConfigError,
  )
})

test('production with an explicit tls=true MONGODB_URI succeeds', () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    CORS_ORIGIN: 'https://shop.example.com',
    MONGODB_URI: 'mongodb://db.internal.example.com:27017/?tls=true',
    MONGODB_DB_NAME: 'ecommerce_prod',
  } as NodeJS.ProcessEnv)
  assert.equal(config.mongo.uri, 'mongodb://db.internal.example.com:27017/?tls=true')
})

test('production with a mongodb+srv:// MONGODB_URI succeeds', () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    CORS_ORIGIN: 'https://shop.example.com',
    ...validProdMongo,
  } as NodeJS.ProcessEnv)
  assert.equal(config.mongo.uri, validProdMongo.MONGODB_URI)
})
