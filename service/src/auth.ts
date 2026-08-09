import { createMiddleware } from 'hono/factory'
import { verify } from 'hono/jwt'
import { problem } from './problem-details.js'
import type { Config } from './config.js'
import type { TenantRecord, TenantRegistry } from './services/tenants.js'

/**
 * Request authentication for the two write operations. `GET /status-lists/{id}`
 * is public per VCALM and never reaches this.
 *
 * **Bearer only.** VCALM's authorization section forbids long-lived static
 * credentials of the HTTP Basic kind, so — unlike `dcc-transaction-service`,
 * whose conventions this service otherwise copies — `Basic` is not accepted and
 * must not be added.
 *
 * Two credential forms, tried in the order transaction-service uses:
 *
 * 1. An **HS256 JWT** whose `sub` names the tenant. This is the
 *    VCALM-conforming path; the token endpoint that mints them is deliberately
 *    deferred, so only verification ships.
 * 2. A **static tenant token**, the DCC convention, kept so one provisioning
 *    act works across transaction-service, the signing service and this one.
 *
 * Authentication never switches itself off. transaction-service disables tenant
 * auth when no tenants are configured; here an empty registry means every
 * authenticated request is refused, because the failure mode of the other
 * choice is an open service that looks configured.
 */

export interface AuthVariables {
  Variables: { tenant: TenantRecord }
}

/** What the `WWW-Authenticate` challenge and the problem detail both say. */
const CHALLENGE = 'Bearer realm="vcalm-status-service"'

const unauthorized = (detail: string) =>
  problem(401, detail, { extensions: { wwwAuthenticate: CHALLENGE } })

/** `Authorization: Bearer <token>`, or nothing. Scheme match is case-insensitive. */
export const bearerToken = (
  authorization: string | undefined
): string | undefined => {
  if (!authorization) return undefined
  const [scheme, ...rest] = authorization.split(' ')
  if (scheme?.toLowerCase() !== 'bearer') return undefined
  const token = rest.join(' ').trim()
  return token === '' ? undefined : token
}

export interface AccessTokenPayload {
  sub?: unknown
}

/**
 * Verifies an HS256 access token and returns the tenant id it names.
 *
 * No scope is required. VCALM's scope vocabulary is `read`/`write` against a
 * path, but nothing mints these tokens yet, so demanding a claim whose exact
 * spelling is unsettled would reject the only tokens that can exist. When the
 * token endpoint lands it brings the scope check with it.
 */
export const tenantIdFromAccessToken = async (
  token: string,
  secret: string | undefined
): Promise<string | undefined> => {
  if (!secret) return undefined
  try {
    const payload = (await verify(token, secret, 'HS256')) as AccessTokenPayload
    const sub = payload?.sub
    return typeof sub === 'string' && sub !== '' ? sub.toLowerCase() : undefined
  } catch {
    // Expired, wrong signature, or not a JWT at all — fall through to the
    // static-token path, which is what an opaque token looks like here.
    return undefined
  }
}

export const resolveTenant = async (
  token: string,
  deps: { tenants: TenantRegistry; accessJwtSecret?: string }
): Promise<TenantRecord | undefined> => {
  const tenantId = await tenantIdFromAccessToken(token, deps.accessJwtSecret)
  if (tenantId !== undefined) {
    return await deps.tenants.getTenant(tenantId)
  }
  return await deps.tenants.getTenantByToken(token)
}

/**
 * Authenticates the caller and puts the tenant on the context. Everything
 * downstream reads ownership from `c.var.tenant`, never from the request's
 * host or path — tenancy binds to the list, not to the URL.
 */
export const createTenantAuth = (deps: {
  tenants: TenantRegistry
  config: Pick<Config, 'accessJwtSecret'>
}) =>
  createMiddleware<AuthVariables>(async (c, next) => {
    const token = bearerToken(c.req.header('Authorization'))
    if (token === undefined) {
      throw unauthorized('Authenticate with `Authorization: Bearer <token>`.')
    }

    const tenant = await resolveTenant(token, {
      tenants: deps.tenants,
      ...(deps.config.accessJwtSecret === undefined
        ? {}
        : { accessJwtSecret: deps.config.accessJwtSecret })
    })
    if (tenant === undefined) {
      // Deliberately the same message either way: which half of a credential
      // was wrong is not the caller's business.
      throw unauthorized('The bearer token is not valid for any tenant.')
    }

    c.set('tenant', tenant)
    await next()
  })
