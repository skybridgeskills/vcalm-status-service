import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createMiddleware } from 'hono/factory'
import { SERVICE_NAME, createHealthCheck } from './health.js'
import { createErrorHandler, notFoundHandler } from './problem-details.js'
import type { Config } from './config.js'
import type { Logger } from './logger.js'
import type { Services } from './services/index.js'

export interface AppDeps {
  config: Config
  services: Services
  logger: Logger
}

/** Every route this service answers, in one place. */
export const routes = {
  index: '/',
  healthz: '/healthz'
} as const

/**
 * One structured line per request, carrying a request id that a caller can
 * supply (`X-Request-Id`) to correlate across services.
 */
const requestLogging = (logger: Logger) =>
  createMiddleware(async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? randomUUID()
    const startedAt = performance.now()
    c.header('X-Request-Id', requestId)
    await next()
    logger.info('request', {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Math.round(performance.now() - startedAt)
    })
  })

export const createApp = (deps: AppDeps) =>
  new Hono()
    .notFound(notFoundHandler)
    .onError(createErrorHandler(deps.logger))

    .use(requestLogging(deps.logger))
    .use(cors())

    .get(routes.index, (c) =>
      c.json({ message: `${SERVICE_NAME} status: ok.` })
    )
    .get(routes.healthz, createHealthCheck(deps))

export type AppType = ReturnType<typeof createApp>
