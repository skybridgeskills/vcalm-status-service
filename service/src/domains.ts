import type { Context } from 'hono'
import type { TenantRecord } from './services/tenants.js'

/**
 * Which domains a tenant's lists may appear under.
 *
 * The same list is served through several fronts — a tenant's own domain via
 * proxy, a tenant domain pointed straight at the load balancer, and the shared
 * service domain — and tenancy is never derived from any of them. This check
 * exists so tenant A's list is not served under tenant B's brand, not as access
 * control: the GET is public wherever it is answered, so the worst a forged
 * host achieves is a 404 on a document it could have fetched anyway. It
 * narrows; it never widens.
 */

/** Hostname alone: lowercased, port dropped, brackets and schemes tolerated. */
export const hostname = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`
  try {
    const parsed = new URL(withScheme)
    return parsed.hostname === '' ? undefined : parsed.hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * The host the caller believes it reached.
 *
 * `X-Forwarded-Host` wins because in the wrapper the ALB is what knows the
 * customer domain; `Host` by then is the internal target. A chain of proxies
 * appends, so the client-facing host is the first entry. There is no trust gate
 * on the header, for the reason in this module's header comment.
 */
export const effectiveHost = (c: Context): string | undefined => {
  const forwarded = c.req.header('X-Forwarded-Host')?.split(',')[0]
  return (
    hostname(forwarded) ??
    hostname(c.req.header('Host')) ??
    // HTTP/2 carries the authority in a pseudo-header rather than `Host`, and
    // the request URL is where that ends up.
    hostname(c.req.url)
  )
}

/**
 * Every host a tenant may be served under: its own authorized domains plus the
 * service's own, which is shared by all tenants and never has to be listed.
 */
export const authorizedHosts = (
  tenant: TenantRecord,
  publicBaseUrl: string
): Set<string> => {
  const hosts = new Set<string>()
  const own = hostname(publicBaseUrl)
  if (own !== undefined) hosts.add(own)
  for (const domain of tenant.authorizedDomains ?? []) {
    const host = hostname(domain)
    if (host !== undefined) hosts.add(host)
  }
  return hosts
}

export const isAuthorizedHost = (
  tenant: TenantRecord,
  host: string | undefined,
  publicBaseUrl: string
): boolean => {
  const wanted = hostname(host)
  return wanted === undefined
    ? false
    : authorizedHosts(tenant, publicBaseUrl).has(wanted)
}

/**
 * Whether a client-supplied canonical `id` may be minted: same domain set, plus
 * the requirement that it be an absolute `https`/`http` URL. A list URL is
 * permanent, so this is the one moment it can be refused.
 */
export const isAuthorizedListUrl = (
  tenant: TenantRecord,
  url: string,
  publicBaseUrl: string
): boolean => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  return authorizedHosts(tenant, publicBaseUrl).has(
    parsed.hostname.toLowerCase()
  )
}
