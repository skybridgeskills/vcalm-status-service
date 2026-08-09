import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createMiddleware } from 'hono/factory'
import { createTenantAuth } from './auth.js'
import { SERVICE_NAME, createHealthCheck } from './health.js'
import { createErrorHandler, notFoundHandler } from './problem-details.js'
import { allocateHandler } from './routes/allocate.js'
import { updateCredentialStatusHandler } from './routes/credentials-status.js'
import {
  createStatusListHandler,
  getStatusListHandler
} from './routes/status-lists.js'
import type { Config } from './config.js'
import type { Logger } from './logger.js'
import type { Services } from './services/index.js'

export interface AppDeps {
  config: Config
  services: Services
  logger: Logger
}

/**
 * Every route this service answers, in one place. The status surface mounts
 * flat: bearer auth already identifies the tenant and a list names its issuer
 * instance at create, so a VCALM `/instances/{id}/` prefix would add nothing.
 * That prefix stays reserved for a future issuer adapter.
 */
export const routes = {
  index: '/',
  healthz: '/healthz',
  statusLists: '/status-lists',
  statusList: '/status-lists/:id',
  credentialsStatus: '/credentials/status',
  /** A documented non-VCALM extension; see the route module. */
  credentialsStatusAllocate: '/credentials/status/allocate'
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

export const createApp = (deps: AppDeps) => {
  const tenantAuth = createTenantAuth({
    tenants: deps.services.tenants,
    config: deps.config
  })

  return (
    new Hono()
      .notFound(notFoundHandler)
      .onError(createErrorHandler(deps.logger))

      .use(requestLogging(deps.logger))
      .use(cors())

      .get(routes.index, (c) =>
        c.json({ message: `${SERVICE_NAME} status: ok.` })
      )
      .get(routes.healthz, createHealthCheck(deps))

      // Writes are tenant-authenticated; the retrieve is public per VCALM, so
      // the middleware goes on the two operations rather than on a prefix.
      .post(routes.statusLists, tenantAuth, createStatusListHandler(deps))
      .get(routes.statusList, getStatusListHandler(deps))
      .post(routes.credentialsStatusAllocate, tenantAuth, allocateHandler(deps))
      .post(
        routes.credentialsStatus,
        tenantAuth,
        updateCredentialStatusHandler(deps)
      )
  )
}

export type AppType = ReturnType<typeof createApp>
