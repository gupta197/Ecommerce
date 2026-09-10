import { loadLocalEnvFile, loadConfig, ConfigError, type AppConfig } from './config/env.js'
import { createLogger } from './lib/logger.js'
import { createApp } from './app.js'

loadLocalEnvFile()

let config: AppConfig
try {
  config = loadConfig()
} catch (error) {
  if (error instanceof ConfigError) {
    // logger depends on config, which failed to load — console is the only option here
    console.error(`Startup failed: ${error.message}`)
    process.exit(1)
  }
  throw error
}

const logger = createLogger(config)
const app = createApp(config, logger)

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, nodeEnv: config.nodeEnv }, 'API server listening')
})

let shuttingDown = false

function shutdown(signal: string): void {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ signal }, 'Shutdown signal received, closing server')

  const forceExitTimer = setTimeout(() => {
    logger.error(
      { timeoutMs: config.shutdownTimeoutMs },
      'Graceful shutdown timed out, forcing exit',
    )
    process.exit(1)
  }, config.shutdownTimeoutMs)
  forceExitTimer.unref()

  server.close((err) => {
    clearTimeout(forceExitTimer)
    if (err) {
      logger.error({ err }, 'Error while closing server')
      process.exit(1)
      return
    }
    logger.info('Server closed cleanly, exiting')
    process.exit(0)
  })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
