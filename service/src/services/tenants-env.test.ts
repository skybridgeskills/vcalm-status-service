import { describe, expect, test } from 'vitest'
import { EnvTenantRegistry, parseTenantsFromEnv } from './tenants-env.js'

const ACME = {
  TENANT_TOKEN_ACME: 'acme-token',
  TENANT_ISSUER_1_ID_ACME: 'default',
  TENANT_ISSUER_1_SEED_ACME: 'z1Adwe2aGW4S3QVmt6ha2FwcTxfCbeNpGGWwKXC2yETHVCW'
}

describe('parseTenantsFromEnv', () => {
  test('reads nothing from an empty environment', () => {
    expect(parseTenantsFromEnv({})).toEqual([])
  })

  test('a token defines a tenant, lowercased', () => {
    expect(parseTenantsFromEnv({ TENANT_TOKEN_ACME: 'secret' })).toEqual([
      { tenantId: 'acme', tokens: ['secret'], issuerInstances: [] }
    ])
  })

  test('accepts several tokens for one tenant, so a rotation overlaps', () => {
    const [tenant] = parseTenantsFromEnv({
      TENANT_TOKEN_ACME: 'current, next '
    })
    expect(tenant?.tokens).toEqual(['current', 'next'])
  })

  test('rejects a tenant declared with no token at all', () => {
    expect(() => parseTenantsFromEnv({ TENANT_TOKEN_ACME: ' , ' })).toThrow(
      /at least one token/
    )
  })

  test('reads issuer instances until the numbering stops', () => {
    const [tenant] = parseTenantsFromEnv({
      ...ACME,
      TENANT_ISSUER_2_ID_ACME: 'p256',
      TENANT_ISSUER_2_CRYPTOSUITE_ACME: 'ecdsa-rdfc-2019',
      TENANT_ISSUER_2_PUBLIC_KEY_ACME: 'zDnaPublic',
      TENANT_ISSUER_2_SECRET_KEY_ACME: 'zSecret',
      // Numbering has a gap, so this one is not reached.
      TENANT_ISSUER_4_ID_ACME: 'unreachable'
    })

    expect(tenant?.issuerInstances.map((i) => i.id)).toEqual([
      'default',
      'p256'
    ])
    expect(tenant?.issuerInstances[0]).toMatchObject({
      cryptosuite: 'eddsa-rdfc-2022',
      didMethod: 'key',
      keyMaterial: { kind: 'ed25519-seed' },
      signingServiceTenant: 'acme'
    })
    expect(tenant?.issuerInstances[1]?.keyMaterial).toEqual({
      kind: 'multikey',
      publicKeyMultibase: 'zDnaPublic',
      secretKeyMultibase: 'zSecret'
    })
  })

  test('carries what HTTP signing needs, when provisioning recorded it', () => {
    const [tenant] = parseTenantsFromEnv({
      TENANT_TOKEN_ACME: 'acme-token',
      TENANT_ISSUER_1_ID_ACME: 'remote',
      TENANT_ISSUER_1_SIGNING_TENANT_ACME: 'acme-prod',
      TENANT_ISSUER_1_SIGNING_TOKEN_ACME: 'signing-secret',
      TENANT_ISSUER_1_ISSUER_DID_ACME: 'did:web:acme.test'
    })
    expect(tenant?.issuerInstances[0]).toMatchObject({
      signingServiceTenant: 'acme-prod',
      signingServiceToken: 'signing-secret',
      issuerDid: 'did:web:acme.test'
    })
  })

  test('carries authorized domains and a default instance', () => {
    const [tenant] = parseTenantsFromEnv({
      ...ACME,
      TENANT_DOMAINS_ACME: 'status.acme.test, acme.example ',
      TENANT_DEFAULT_INSTANCE_ACME: 'default'
    })
    expect(tenant?.authorizedDomains).toEqual([
      'status.acme.test',
      'acme.example'
    ])
    expect(tenant?.defaultInstanceId).toBe('default')
  })

  describe('refuses configuration that could not sign', () => {
    test('an unknown cryptosuite', () => {
      expect(() =>
        parseTenantsFromEnv({
          ...ACME,
          TENANT_ISSUER_1_CRYPTOSUITE_ACME: 'bbs-2023'
        })
      ).toThrow(/unknown cryptosuite/)
    })

    test('an unknown DID method', () => {
      expect(() =>
        parseTenantsFromEnv({ ...ACME, TENANT_ISSUER_1_DID_METHOD_ACME: 'ion' })
      ).toThrow(/unknown DID method/)
    })

    test('did:web with no URL to publish under', () => {
      expect(() =>
        parseTenantsFromEnv({ ...ACME, TENANT_ISSUER_1_DID_METHOD_ACME: 'web' })
      ).toThrow(/requires TENANT_ISSUER_1_DID_URL_ACME/)
    })

    test('half a multikey pair, which cannot be completed', () => {
      expect(() =>
        parseTenantsFromEnv({
          TENANT_TOKEN_ACME: 'acme-token',
          TENANT_ISSUER_1_ID_ACME: 'p256',
          TENANT_ISSUER_1_SECRET_KEY_ACME: 'zSecret'
        })
      ).toThrow(/both PUBLIC_KEY and SECRET_KEY/)
    })

    test('a seed and a multikey pair at once', () => {
      expect(() =>
        parseTenantsFromEnv({
          ...ACME,
          TENANT_ISSUER_1_PUBLIC_KEY_ACME: 'zDnaPublic',
          TENANT_ISSUER_1_SECRET_KEY_ACME: 'zSecret'
        })
      ).toThrow(/either a seed or a multikey pair/)
    })

    test('two instances sharing an id', () => {
      expect(() =>
        parseTenantsFromEnv({
          ...ACME,
          TENANT_ISSUER_2_ID_ACME: 'default'
        })
      ).toThrow(/used twice/)
    })

    test('a default instance that does not exist', () => {
      expect(() =>
        parseTenantsFromEnv({ ...ACME, TENANT_DEFAULT_INSTANCE_ACME: 'other' })
      ).toThrow(/no issuer instance "other"/)
    })
  })

  test('keeps tenants apart, and ignores an unrelated environment', () => {
    const tenants = parseTenantsFromEnv({
      ...ACME,
      TENANT_TOKEN_GLOBEX: 'globex-token',
      TENANT_ISSUER_1_ID_GLOBEX: 'default',
      PATH: '/usr/bin',
      TENANT_SOMETHING_ELSE: 'ignored'
    })
    expect(tenants.map((tenant) => tenant.tenantId)).toEqual(['acme', 'globex'])
    expect(tenants[1]?.issuerInstances[0]?.signingServiceTenant).toBe('globex')
  })
})

describe('EnvTenantRegistry', () => {
  test('resolves a tenant by id and by token', async () => {
    const registry = new EnvTenantRegistry(ACME)
    expect((await registry.getTenant('acme'))?.tokens).toEqual(['acme-token'])
    expect((await registry.getTenantByToken('acme-token'))?.tenantId).toBe(
      'acme'
    )
    expect(await registry.getTenantByToken('wrong')).toBeUndefined()
  })

  test('fails construction rather than booting a half-configured tenant', () => {
    expect(
      () =>
        new EnvTenantRegistry({
          ...ACME,
          TENANT_ISSUER_1_CRYPTOSUITE_ACME: 'nonsense'
        })
    ).toThrow(/unknown cryptosuite/)
  })
})
