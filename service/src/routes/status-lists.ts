import { z } from 'zod'
import {
  effectiveHost,
  isAuthorizedHost,
  isAuthorizedListUrl
} from '../domains.js'
import { problem } from '../problem-details.js'
import { resolveIssuerInstance } from '../services/tenants.js'
import { statusListUrl } from '../status-lists/index.js'
import type { Context } from 'hono'
import type { AuthVariables } from '../auth.js'
import type { AppDeps } from '../app.js'
import type { StatusListRecord } from '../services/storage.js'
import type { TenantRecord } from '../services/tenants.js'

/**
 * `POST /status-lists` and the public `GET /status-lists/{id}`, per the pinned
 * VCALM contract. Both are thin: creation resolves who signs and where the list
 * will live and hands the rest to `StatusListManager`, and the GET is a read of
 * bytes that were signed when they were written.
 */

export const STATUS_LISTS_PATH = '/status-lists'

/** BSL defines more purposes; multi-bit entries are what stops us offering them. */
const statusPurposeSchema = z.enum(['revocation', 'suspension'])

/**
 * The `options` vocabulary, mirroring BSL property names. Unknown keys are
 * refused so a typo fails loudly instead of being silently ignored — the VCALM
 * request object is `additionalProperties: false` and this matches it.
 *
 * `statusSize` and `statusMessage` are recognized only to refuse them with a
 * useful message: v1 publishes single-bit entries, and a caller asking for more
 * deserves better than "unknown key".
 */
const optionsSchema = z
  .object({
    length: z.number().int().positive().optional(),
    statusSize: z.number().int().positive().optional(),
    statusMessage: z
      .array(z.object({ status: z.string(), message: z.string() }))
      .optional(),
    ttl: z.number().int().positive().optional(),
    issuerInstance: z.string().min(1).optional()
  })
  .strict()

export const createStatusListSchema = z
  .object({
    statusPurpose: statusPurposeSchema,
    id: z.string().url().optional(),
    options: optionsSchema.optional()
  })
  .strict()

/**
 * A client-supplied `id` is a full canonical URL, and it has to be one this
 * service could serve: the path is where the GET will look for the list, so it
 * must be exactly `/status-lists/{slug}`.
 */
const slugFromListUrl = (url: string): string | undefined => {
  const { pathname } = new URL(url)
  const segments = pathname.split('/').filter((segment) => segment !== '')
  if (segments.length !== 2 || segments[0] !== 'status-lists') return undefined
  return decodeURIComponent(segments[1]!)
}

const issuerInstanceFor = (
  tenant: TenantRecord,
  wanted: string | undefined
) => {
  const instance = resolveIssuerInstance(tenant, wanted)
  if (instance !== undefined) return instance
  if (wanted !== undefined) {
    throw problem(
      400,
      `Tenant "${tenant.tenantId}" has no issuer instance "${wanted}"`
    )
  }
  // No instance was named and none could be defaulted: the tenant was
  // provisioned without one, which the caller cannot fix.
  throw problem(
    500,
    `Tenant "${tenant.tenantId}" has no issuer instance to sign with`
  )
}

export const createStatusListHandler =
  (deps: AppDeps) => async (c: Context<AuthVariables>) => {
    const tenant = c.var.tenant
    const body = createStatusListSchema.parse(await c.req.json())
    const instance = issuerInstanceFor(tenant, body.options?.issuerInstance)

    let id: string | undefined
    let url: string | undefined
    if (body.id !== undefined) {
      if (!isAuthorizedListUrl(tenant, body.id, deps.config.publicBaseUrl)) {
        throw problem(
          400,
          `"${body.id}" is not under a base URL authorized for tenant "${tenant.tenantId}"`
        )
      }
      id = slugFromListUrl(body.id)
      if (id === undefined) {
        throw problem(
          400,
          `"${body.id}" is not a status list URL; the path must be /status-lists/{id}`
        )
      }
      url = body.id
    }

    const record = await deps.services.statusLists.createList({
      tenantId: tenant.tenantId,
      instance,
      statusPurpose: body.statusPurpose,
      ...(id === undefined ? {} : { id }),
      ...(url === undefined ? {} : { url }),
      ...(body.options === undefined
        ? {}
        : {
            characteristics: {
              ...(body.options.length === undefined
                ? {}
                : { length: body.options.length }),
              ...(body.options.statusSize === undefined
                ? {}
                : { statusSize: body.options.statusSize }),
              ...(body.options.statusMessage === undefined
                ? {}
                : { statusMessage: body.options.statusMessage }),
              ...(body.options.ttl === undefined
                ? {}
                : { ttl: body.options.ttl })
            }
          })
    })

    const canonicalUrl = canonicalUrlOf(record, deps.config.publicBaseUrl)
    c.header('Location', canonicalUrl)
    return c.json(
      { verifiableCredential: record.signedCredential, id: canonicalUrl },
      201
    )
  }

/** The URL the list was created under, which is inside the credential itself. */
const canonicalUrlOf = (
  record: StatusListRecord,
  publicBaseUrl: string
): string =>
  record.signedCredential.id ?? statusListUrl(publicBaseUrl, record.id)

/** BSL §2.2: align HTTP caching with `ttl`, and stay revalidatable without one. */
const cacheControlFor = (record: StatusListRecord): string =>
  record.characteristics.ttl === undefined
    ? // Caches may store it, but must revalidate — so a bit flip is never
      // masked by one, which is what makes revocation observable.
      'no-cache'
    : `public, max-age=${Math.floor(record.characteristics.ttl / 1000)}`

/** Strong, because a given version is byte-identical wherever it is served. */
const etagFor = (record: StatusListRecord): string => `"${record.version}"`

/** BSL contemplates `application/vc`; the VCALM OAS declares only JSON. */
const contentTypeFor = (accept: string | undefined): string =>
  accept?.toLowerCase().includes('application/vc')
    ? 'application/vc'
    : 'application/json'

export const getStatusListHandler = (deps: AppDeps) => async (c: Context) => {
  const record = await deps.services.storage.getStatusList(
    c.req.param('id') ?? ''
  )
  if (record === undefined) {
    throw problem(404, 'No such status list')
  }

  // A list is served only under a domain its own tenant holds. A tenant that
  // has left the registry keeps the service's own domain and nothing else.
  const tenant = (await deps.services.tenants.getTenant(record.tenantId)) ?? {
    tenantId: record.tenantId,
    tokens: [],
    issuerInstances: []
  }
  if (!isAuthorizedHost(tenant, effectiveHost(c), deps.config.publicBaseUrl)) {
    // 404 rather than 403: under this domain, there is no such list.
    throw problem(404, 'No such status list')
  }

  const etag = etagFor(record)
  c.header('ETag', etag)
  c.header('Cache-Control', cacheControlFor(record))
  if (c.req.header('If-None-Match') === etag) {
    return c.body(null, 304)
  }

  return c.body(JSON.stringify(record.signedCredential), 200, {
    'Content-Type': contentTypeFor(c.req.header('Accept'))
  })
}
