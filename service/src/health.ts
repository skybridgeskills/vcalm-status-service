import type { Context } from 'hono'
import type { Logger } from './logger.js'
import type { Services } from './services/index.js'
import { ProblemDetailsError, sendProblemDetails } from './problem-details.js'

export const SERVICE_NAME = 'vcalm-status-service'

/**
 * Readiness for the ALB target group: 200 only when the backends this service
 * cannot serve without are reachable. Signing is not probed — it is exercised
 * on write, and a public GET serves stored bytes without it.
 */
export const createHealthCheck =
  (deps: { services: Services; logger: Logger }) => async (c: Context) => {
    try {
      await deps.services.storage.ping()
    } catch (error) {
      deps.logger.error('healthz failed', { err: error })
      return sendProblemDetails(c, {
        ...new ProblemDetailsError(
          503,
          'Storage backend is unreachable'
        ).toProblemDetails(),
        service: SERVICE_NAME,
        healthy: false
      })
    }
    return c.json({ message: `${SERVICE_NAME} status: ok.`, healthy: true })
  }
