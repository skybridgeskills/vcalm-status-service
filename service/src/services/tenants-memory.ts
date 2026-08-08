import type { TenantRecord, TenantRegistry } from './tenants.js'

/**
 * In-memory registry used by tests and by any run that configures its tenants
 * up front. Token collisions across tenants are a provisioning bug, so they
 * fail loudly at construction rather than resolving to an arbitrary tenant.
 */
export class MemoryTenantRegistry implements TenantRegistry {
  readonly #tenants = new Map<string, TenantRecord>()
  readonly #byToken = new Map<string, string>()

  constructor(tenants: TenantRecord[] = []) {
    for (const tenant of tenants) {
      this.add(tenant)
    }
  }

  add(tenant: TenantRecord): void {
    for (const token of tenant.tokens) {
      const owner = this.#byToken.get(token)
      if (owner !== undefined && owner !== tenant.tenantId) {
        throw new Error(
          `Tenant token collision: "${owner}" and "${tenant.tenantId}" share a token`
        )
      }
    }
    this.#tenants.set(tenant.tenantId, tenant)
    for (const token of tenant.tokens) {
      this.#byToken.set(token, tenant.tenantId)
    }
  }

  async getTenant(tenantId: string): Promise<TenantRecord | undefined> {
    return this.#tenants.get(tenantId)
  }

  async getTenantByToken(token: string): Promise<TenantRecord | undefined> {
    if (!token) return undefined
    const tenantId = this.#byToken.get(token)
    return tenantId === undefined ? undefined : this.#tenants.get(tenantId)
  }
}
