import mongoose from 'mongoose'
import type { AppConfig } from '../config/env.js'
import type { Logger } from '../lib/logger.js'
import { registerDefaultQueryTimeoutPlugin } from './plugins/default-query-timeout.js'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let listenersRegistered = false

function registerConnectionEventListeners(logger: Logger): void {
  if (listenersRegistered) return
  listenersRegistered = true

  // Post-startup connection issues are logged only — the process stays up.
  // The MongoDB driver's own reconnection logic (SDAM) handles recovery;
  // we do not hand-roll reconnect behavior here.
  mongoose.connection.on('error', (err: unknown) => {
    logger.error({ err }, 'MongoDB connection error')
  })
  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB connection lost')
  })
  mongoose.connection.on('reconnected', () => {
    logger.info('MongoDB connection re-established')
  })
}

/**
 * Connects to MongoDB using the configured URI/pool/timeout settings.
 * Retries the *initial* connection attempt a bounded number of times
 * (useful when the app container starts before the database is ready);
 * once connected, ongoing reconnection is left entirely to the driver.
 *
 * Never logs the connection string or any credential — only the
 * configured database name.
 */
export async function connectDatabase(config: AppConfig, logger: Logger): Promise<void> {
  mongoose.set('strictQuery', true)
  mongoose.set('sanitizeFilter', true)
  mongoose.set('autoIndex', config.nodeEnv !== 'production')
  mongoose.set('autoCreate', config.nodeEnv !== 'production')
  mongoose.set('debug', config.nodeEnv === 'development' && config.logLevel === 'debug')

  registerDefaultQueryTimeoutPlugin(config.mongo.queryTimeoutMs)
  registerConnectionEventListeners(logger)

  const { retries, retryDelayMs } = config.mongo.initialConnect
  let attempt = 0

  for (;;) {
    try {
      await mongoose.connect(config.mongo.uri, {
        dbName: config.mongo.dbName,
        maxPoolSize: config.mongo.maxPoolSize,
        minPoolSize: config.mongo.minPoolSize,
        serverSelectionTimeoutMS: config.mongo.serverSelectionTimeoutMs,
        socketTimeoutMS: config.mongo.socketTimeoutMs,
        retryWrites: true,
        retryReads: true,
      })
      logger.info({ dbName: config.mongo.dbName }, 'Connected to MongoDB')
      return
    } catch (error) {
      attempt += 1
      if (attempt > retries) {
        throw error
      }
      logger.warn({ attempt, retries, retryDelayMs }, 'MongoDB connection attempt failed, retrying')
      await sleep(retryDelayMs)
    }
  }
}

export async function disconnectDatabase(logger: Logger): Promise<void> {
  await mongoose.disconnect()
  logger.info('MongoDB connection closed')
}

/** Used by the /api/v1/ready endpoint. 1 === connected. */
export function isDatabaseReady(): boolean {
  return mongoose.connection.readyState === 1
}
