import { isSigningError } from '@skybridgeskills/vc-signer'
import { HTTPException } from 'hono/http-exception'
import { ZodError } from 'zod'
import { SigningServiceError } from './services/signing.js'
import { StorageError } from './services/storage.js'
import { StatusListError } from './status-lists/errors.js'
import type { Context, ErrorHandler, NotFoundHandler } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Logger } from './logger.js'
import type { StatusListErrorCode } from './status-lists/errors.js'
import type { SigningServiceErrorCode } from './services/signing.js'
import type { StorageErrorCode } from './services/storage.js'

/**
 * RFC 9457 Problem Details. VCALM's OpenAPI references ProblemDetails for
 * errors elsewhere but declares no error body for the status operations, so
 * this service answers every 4xx/5xx with the same shape.
 */

export const PROBLEM_CONTENT_TYPE = 'application/problem+json'

/** Stable `type` URIs. `about:blank` means "the status code says it all". */
export const ProblemType = {
  blank: 'about:blank',
  validation: 'urn:skybridge:vcalm-status-service:problem:validation'
} as const

export interface ProblemDetails {
  type: string
  title: string
  status: number
  detail?: string
  [extension: string]: unknown
}

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  500: 'Internal Server Error',
  503: 'Service Unavailable'
}

export const titleForStatus = (status: number): string =>
  TITLES[status] ?? (status >= 500 ? 'Server Error' : 'Request Error')

export class ProblemDetailsError extends Error {
  override readonly name = 'ProblemDetailsError'
  readonly status: number
  readonly type: string
  readonly title: string
  readonly detail: string | undefined
  readonly extensions: Record<string, unknown>

  constructor(
    status: number,
    detail?: string,
    options: {
      type?: string
      title?: string
      extensions?: Record<string, unknown>
      cause?: unknown
    } = {}
  ) {
    super(detail ?? titleForStatus(status), { cause: options.cause })
    this.status = status
    this.type = options.type ?? ProblemType.blank
    this.title = options.title ?? titleForStatus(status)
    this.detail = detail
    this.extensions = options.extensions ?? {}
  }

  toProblemDetails(): ProblemDetails {
    return {
      type: this.type,
      title: this.title,
      status: this.status,
      ...(this.detail === undefined ? {} : { detail: this.detail }),
      ...this.extensions
    }
  }
}

export const problem = (
  status: number,
  detail?: string,
  options?: ConstructorParameters<typeof ProblemDetailsError>[2]
): ProblemDetailsError => new ProblemDetailsError(status, detail, options)

/**
 * The one place a transport-neutral domain code becomes an HTTP status.
 *
 * `StatusListError`, `StorageError`, `SigningError` and `SigningServiceError`
 * deliberately carry no status — the modules that throw them have no business
 * knowing about HTTP. Mapping them here rather than in each route means a
 * handler cannot forget, and a new code fails to compile until it is given a
 * status.
 */
const STATUS_LIST_STATUS: Record<StatusListErrorCode, number> = {
  'list-too-short': 400,
  'unsupported-characteristics': 400,
  'list-not-found': 404,
  'list-purpose-mismatch': 400,
  // The list exists but its tenant or key is gone from the registry: a
  // provisioning failure the caller can do nothing about.
  'issuer-instance-unavailable': 500,
  'index-out-of-range': 400,
  'credential-not-allocated': 404,
  'list-exhausted': 409
}

const STORAGE_STATUS: Record<StorageErrorCode, number> = {
  'list-not-found': 404,
  'duplicate-list': 409,
  'index-taken': 409,
  'credential-already-allocated': 409
}

const SIGNING_SERVICE_STATUS: Record<SigningServiceErrorCode, number> = {
  'signing-unavailable': 503,
  'signing-rejected': 502,
  'signing-misconfigured': 500
}

const withCode = (status: number, code: string, detail: string) => ({
  type: ProblemType.blank,
  title: titleForStatus(status),
  status,
  detail,
  code
})

const domainProblem = (error: unknown): ProblemDetails | undefined => {
  if (error instanceof StatusListError) {
    return withCode(STATUS_LIST_STATUS[error.code], error.code, error.message)
  }
  if (error instanceof StorageError) {
    return withCode(STORAGE_STATUS[error.code], error.code, error.message)
  }
  if (error instanceof SigningServiceError) {
    return withCode(
      SIGNING_SERVICE_STATUS[error.code],
      error.code,
      error.message
    )
  }
  if (isSigningError(error)) {
    // Every signing failure is ours: the service chooses the key, builds the
    // credential and sets its issuer, so a caller cannot provoke one.
    return withCode(500, error.code, 'The status list could not be signed')
  }
  return undefined
}

/**
 * Maps a thrown value to a problem document. Unrecognized errors become a bare
 * 500: internals never reach the client, so the caller is expected to log them.
 */
export const toProblemDetails = (error: unknown): ProblemDetails => {
  if (error instanceof ProblemDetailsError) {
    return error.toProblemDetails()
  }
  const domain = domainProblem(error)
  if (domain !== undefined) {
    return domain
  }
  if (error instanceof ZodError) {
    return {
      type: ProblemType.validation,
      title: titleForStatus(400),
      status: 400,
      detail: error.errors
        .map((issue) => `${issue.path.join('.') || '(body)'}: ${issue.message}`)
        .join('; '),
      errors: error.errors.map((issue) => ({
        path: issue.path.map(String),
        message: issue.message
      }))
    }
  }
  if (error instanceof HTTPException) {
    return {
      type: ProblemType.blank,
      title: titleForStatus(error.status),
      status: error.status,
      ...(error.message ? { detail: error.message } : {})
    }
  }
  return {
    type: ProblemType.blank,
    title: titleForStatus(500),
    status: 500
  }
}

export const sendProblemDetails = (c: Context, details: ProblemDetails) =>
  c.body(JSON.stringify(details), details.status as ContentfulStatusCode, {
    'Content-Type': PROBLEM_CONTENT_TYPE
  })

/** Hono `onError` handler. Only unmapped failures are logged as errors. */
export const createErrorHandler =
  (logger: Logger): ErrorHandler =>
  (error, c) => {
    const details = toProblemDetails(error)
    if (details.status >= 500) {
      logger.error('unhandled error', {
        err: error,
        method: c.req.method,
        path: c.req.path
      })
    }
    return sendProblemDetails(c, details)
  }

export const notFoundHandler: NotFoundHandler = (c) =>
  sendProblemDetails(c, {
    type: ProblemType.blank,
    title: titleForStatus(404),
    status: 404,
    detail: `No route for ${c.req.method} ${c.req.path}`
  })
