import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { getConfig } from './config.js'
import { SERVICE_NAME } from './health.js'
import { createLogger } from './logger.js'
import { createServices } from './services/index.js'

const run = async () => {
  const config = getConfig()
  const logger = createLogger({
    level: config.logLevel,
    base: { service: SERVICE_NAME }
  })
  const services = createServices(config, logger)
  await services.storage.init()

  const app = createApp({ config, services, logger })

  serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, () => {
    logger.info('listening', {
      port: config.port,
      publicBaseUrl: config.publicBaseUrl,
      nodeEnv: config.nodeEnv
    })
  })

  const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal })
    await services.storage.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

run().catch((error) => {
  // The logger needs config, which is what failed; stderr is all we have.
  console.error(error)
  process.exit(1)
})
