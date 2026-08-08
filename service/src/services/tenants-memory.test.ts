import { describe, expect, test } from 'vitest'
import { MemoryTenantRegistry } from './tenants-memory.js'
import { resolveIssuerInstance } from './tenants.js'
import { testIssuerInstance, testTenant } from '../test-fixtures/records.js'

describe('MemoryTenantRegistry', () => {
  test('resolves a tenant by id and by any of its tokens', async () => {
    const registry = new MemoryTenantRegistry([
      testTenant({ tokens: ['token-a', 'token-b'] })
    ])
    expect((await registry.getTenant('acme'))?.tenantId).toBe('acme')
    expect((await registry.getTenantByToken('token-a'))?.tenantId).toBe('acme')
    expect((await registry.getTenantByToken('token-b'))?.tenantId).toBe('acme')
  })

  test('returns undefined for unknown or empty lookups', async () => {
    const registry = new MemoryTenantRegistry([testTenant()])
    expect(await registry.getTenant('globex')).toBeUndefined()
    expect(await registry.getTenantByToken('guess')).toBeUndefined()
    expect(await registry.getTenantByToken('')).toBeUndefined()
  })

  test('refuses to register two tenants sharing a token', () => {
    const registry = new MemoryTenantRegistry([testTenant()])
    expect(() =>
      registry.add(testTenant({ tenantId: 'globex', tokens: ['acme-token'] }))
    ).toThrow(/token collision/)
  })

  test('re-adding a tenant replaces its record', async () => {
    const registry = new MemoryTenantRegistry([testTenant()])
    registry.add(testTenant({ defaultInstanceId: 'other' }))
    expect((await registry.getTenant('acme'))?.defaultInstanceId).toBe('other')
  })
})

describe('resolveIssuerInstance', () => {
  const tenant = testTenant({
    issuerInstances: [
      testIssuerInstance(),
      testIssuerInstance({
        id: 'web',
        didMethod: 'web',
        didUrl: 'did:web:acme'
      })
    ]
  })

  test('honors an explicitly named instance', () => {
    expect(resolveIssuerInstance(tenant, 'web')?.didMethod).toBe('web')
  })

  test('falls back to the tenant default when none is named', () => {
    expect(resolveIssuerInstance(tenant)?.id).toBe('default')
  })

  test('is undefined for an unknown instance rather than silently defaulting', () => {
    expect(resolveIssuerInstance(tenant, 'nope')).toBeUndefined()
  })

  test('uses the only instance when a tenant has one and no default', () => {
    const single = testTenant({ defaultInstanceId: undefined })
    expect(resolveIssuerInstance(single)?.id).toBe('default')
  })

  test('is undefined when a tenant has several instances and no default', () => {
    expect(
      resolveIssuerInstance(
        testTenant({
          issuerInstances: tenant.issuerInstances,
          defaultInstanceId: undefined
        })
      )
    ).toBeUndefined()
  })
})
