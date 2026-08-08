import type { IssuerInstance } from './issuer-instance.js'

/**
 * A tenant owns its status lists, its issuer instances and its credentials.
 * `tenantId` is an opaque string (tenant-service style); env-provisioned
 * tenants use the lowercased tenant name, which is also the DCC convention.
 */
export interface TenantRecord {
  tenantId: string
  /** Static bearer tokens accepted for this tenant. */
  tokens: string[]
  issuerInstances: IssuerInstance[]
  /** Used when a create request names no instance. */
  defaultInstanceId?: string
}

/**
 * Read-only view of the tenant registry. Async from day one so the HTTP
 * implementation that pulls from tenant-service slots in without touching
 * callers.
 */
export interface TenantRegistry {
  getTenant(tenantId: string): Promise<TenantRecord | undefined>
  getTenantByToken(token: string): Promise<TenantRecord | undefined>
}

/** Resolves the instance a list should bind to, or `undefined` if unknown. */
export const resolveIssuerInstance = (
  tenant: TenantRecord,
  instanceId?: string
): IssuerInstance | undefined => {
  const wanted = instanceId ?? tenant.defaultInstanceId
  if (wanted === undefined) {
    return tenant.issuerInstances.length === 1
      ? tenant.issuerInstances[0]
      : undefined
  }
  return tenant.issuerInstances.find((instance) => instance.id === wanted)
}
