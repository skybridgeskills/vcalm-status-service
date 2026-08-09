import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  DEFAULT_PROFILE_ID,
  PROFILES,
  appendEnvBlock,
  baseUrlFromEnvFile,
  generateTenantToken,
  getProfile,
  hasTenant,
  normalizeTenantId,
  provisionTenant,
  renderCrossServiceBlock,
  renderEnvBlock,
  renderReadyCurl
} from './provisioning.js'
import { createApp } from '../app.js'
import { parseConfig } from '../config.js'
import { createLogger } from '../logger.js'
import { LocalSigningService } from '../services/signing-local.js'
import { MemoryStorage } from '../services/storage-memory.js'
import {
  EnvTenantRegistry,
  parseTenantsFromEnv
} from '../services/tenants-env.js'
import { StatusListManager } from '../status-lists/index.js'
import type { ProvisionedTenant } from './provisioning.js'

/** The block is `KEY=value` lines and comments — enough of dotenv for a test. */
const parseEnvFile = (contents: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {}
  for (const line of contents.split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (match) env[match[1]!] = match[2]
  }
  return env
}

const provision = (
  overrides: Partial<Parameters<typeof provisionTenant>[0]> = {}
) =>
  provisionTenant({
    tenantId: 'acme',
    profile: getProfile(DEFAULT_PROFILE_ID),
    ...overrides
  })

describe('issuer profiles', () => {
  test('the default is the exercised did:key + eddsa combination', () => {
    expect(getProfile(DEFAULT_PROFILE_ID)).toMatchObject({
      didMethod: 'key',
      cryptosuite: 'eddsa-rdfc-2022'
    })
  })

  test('offers no did:web profile, which could half-succeed', () => {
    expect(PROFILES.every((profile) => profile.didMethod === 'key')).toBe(true)
  })

  test('does not offer the legacy suite, which must be chosen deliberately', () => {
    expect(
      PROFILES.some((profile) => profile.cryptosuite === 'Ed25519Signature2020')
    ).toBe(false)
  })

  test('refuses a profile it does not have, listing the ones it does', () => {
    expect(() => getProfile('did-web-eddsa-2022-v1')).toThrow(
      /Available: did-key-eddsa-2022-v1/
    )
  })
})

describe('normalizeTenantId', () => {
  test('lowercases, because the id is lowercase and the suffix is not', () => {
    expect(normalizeTenantId(' ACME ')).toBe('acme')
  })

  test('refuses anything that would not survive becoming an env suffix', () => {
    for (const bad of ['acme-eu', '1acme', '', 'acme corp', 'acme.eu']) {
      expect(() => normalizeTenantId(bad)).toThrow(/not a usable tenant name/)
    }
  })

  test('allows underscores, which an env name can carry', () => {
    expect(normalizeTenantId('acme_eu')).toBe('acme_eu')
  })
})

describe('generateTenantToken', () => {
  test('is long and never the same twice', () => {
    const tokens = new Set(
      Array.from({ length: 50 }, () => generateTenantToken())
    )
    expect(tokens.size).toBe(50)
    expect([...tokens][0]!.length).toBeGreaterThanOrEqual(43)
  })
})

describe('provisionTenant', () => {
  test('mints a token, a key, and the DID they add up to', async () => {
    const tenant = await provision()
    expect(tenant.did).toMatch(/^did:key:z6Mk/)
    expect(tenant.verificationMethod.startsWith(`${tenant.did}#`)).toBe(true)
    expect(tenant.keyMaterial).toMatchObject({ kind: 'ed25519-seed' })
    expect(tenant.instanceId).toBe('default')
    expect(tenant.token.length).toBeGreaterThanOrEqual(43)
  })

  test('mints both halves for P-256, which cannot be re-derived', async () => {
    const tenant = await provision({
      profile: getProfile('did-key-ecdsa-2019-v1')
    })
    expect(tenant.keyMaterial).toMatchObject({ kind: 'multikey' })
    expect(tenant.did).toMatch(/^did:key:zDna/)
  })
})

describe('renderEnvBlock', () => {
  let tenant: ProvisionedTenant

  beforeEach(async () => {
    tenant = await provision({
      authorizedDomains: ['status.acme.test'],
      instanceId: 'default'
    })
  })

  test('is exactly what the registry reads back', async () => {
    const env = parseEnvFile(renderEnvBlock(tenant))
    const [parsed] = parseTenantsFromEnv(env)

    expect(parsed).toMatchObject({
      tenantId: 'acme',
      tokens: [tenant.token],
      defaultInstanceId: 'default',
      authorizedDomains: ['status.acme.test']
    })
    expect(parsed?.issuerInstances[0]).toMatchObject({
      id: 'default',
      cryptosuite: 'eddsa-rdfc-2022',
      didMethod: 'key',
      keyMaterial: tenant.keyMaterial
    })
  })

  test('round-trips P-256 material, both halves', async () => {
    const p256 = await provision({
      profile: getProfile('did-key-ecdsa-2019-v1')
    })
    const [parsed] = parseTenantsFromEnv(parseEnvFile(renderEnvBlock(p256)))
    expect(parsed?.issuerInstances[0]?.keyMaterial).toEqual(p256.keyMaterial)
  })

  test('omits the domains line when there are none to authorize', async () => {
    const block = renderEnvBlock(await provision())
    expect(block).not.toContain('TENANT_DOMAINS_')
  })

  test('names the tenant and its DID in a comment, for a human reading .env', () => {
    expect(renderEnvBlock(tenant)).toContain(
      `# Tenant "acme" — profile ${DEFAULT_PROFILE_ID} — ${tenant.did}`
    )
  })
})

describe('cross-service blocks', () => {
  test('give the signing service a seed in its own convention', async () => {
    const tenant = await provision()
    const block = renderCrossServiceBlock(tenant, 'signing-service')
    expect(block).toContain(`TENANT_SEED_ACME=`)
    expect(block).toContain(`TENANT_AUTH_TOKEN_ACME=${tenant.token}`)
    expect(block).toContain('TENANT_CRYPTOSUITE_ACME=eddsa-rdfc-2022')
  })

  test('refuse P-256 for the signing service, which cannot hold it yet', async () => {
    const tenant = await provision({
      profile: getProfile('did-key-ecdsa-2019-v1')
    })
    expect(() => renderCrossServiceBlock(tenant, 'signing-service')).toThrow(
      /cannot hold ecdsa-rdfc-2019 material yet/
    )
  })

  test('give the transaction service its issuer-instance rows', async () => {
    const tenant = await provision()
    const block = renderCrossServiceBlock(tenant, 'transaction-service')
    expect(block).toContain(`TENANT_TOKEN_ACME=${tenant.token}`)
    expect(block).toContain('TENANT_ISSUER_1_SIGNING_TENANT_ACME=acme')
  })
})

describe('renderReadyCurl', () => {
  test('is a working authenticated create against the configured base', async () => {
    const tenant = await provision()
    const curl = renderReadyCurl(tenant, 'https://status.example')
    expect(curl).toContain('POST https://status.example/status-lists')
    expect(curl).toContain(`Bearer ${tenant.token}`)
    expect(curl).toContain('"statusPurpose":"revocation"')
  })
})

describe('reading an existing env file', () => {
  test('finds the base URL the curl should point at', () => {
    expect(
      baseUrlFromEnvFile('PORT=4008\nPUBLIC_BASE_URL=https://a.test\n')
    ).toBe('https://a.test')
    expect(baseUrlFromEnvFile('PUBLIC_BASE_URL="https://b.test"')).toBe(
      'https://b.test'
    )
    expect(baseUrlFromEnvFile('PORT=4008')).toBeUndefined()
  })

  test('notices a tenant that is already there', () => {
    expect(hasTenant('TENANT_TOKEN_ACME=x\n', 'acme')).toBe(true)
    expect(hasTenant('TENANT_TOKEN_ACME=x\n', 'globex')).toBe(false)
  })
})

describe('appendEnvBlock', () => {
  let directory: string
  let path: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'vcalm-provision-'))
    path = join(directory, '.env')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  test('creates the file, owner-readable only, with a warning header', async () => {
    const result = await appendEnvBlock(path, 'TENANT_TOKEN_ACME=x\n', {
      tenantId: 'acme'
    })

    expect(result.created).toBe(true)
    const contents = await readFile(path, 'utf8')
    expect(contents).toContain('never commit this file')
    expect(contents).toContain('TENANT_TOKEN_ACME=x')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  test('appends to an existing file without disturbing it', async () => {
    await writeFile(path, 'PUBLIC_BASE_URL=https://a.test\nPORT=4008\n')
    const result = await appendEnvBlock(path, 'TENANT_TOKEN_ACME=x\n', {
      tenantId: 'acme'
    })

    expect(result.created).toBe(false)
    expect(result.baseUrl).toBe('https://a.test')
    const contents = await readFile(path, 'utf8')
    expect(contents).toContain('PUBLIC_BASE_URL=https://a.test')
    expect(contents).toContain('TENANT_TOKEN_ACME=x')
  })

  test('separates a block from a file that does not end in a newline', async () => {
    await writeFile(path, 'PORT=4008')
    await appendEnvBlock(path, 'TENANT_TOKEN_ACME=x\n', { tenantId: 'acme' })
    expect(await readFile(path, 'utf8')).toBe(
      'PORT=4008\n\nTENANT_TOKEN_ACME=x\n'
    )
  })

  test('refuses to shadow a tenant that is already provisioned', async () => {
    await writeFile(path, 'TENANT_TOKEN_ACME=first\n')
    await expect(
      appendEnvBlock(path, 'TENANT_TOKEN_ACME=second\n', { tenantId: 'acme' })
    ).rejects.toThrow(/already has a TENANT_TOKEN_ACME/)
  })

  test('appends anyway when told to', async () => {
    await writeFile(path, 'TENANT_TOKEN_ACME=first\n')
    await appendEnvBlock(path, 'TENANT_TOKEN_ACME=second\n', {
      tenantId: 'acme',
      force: true
    })
    expect(await readFile(path, 'utf8')).toContain('TENANT_TOKEN_ACME=second')
  })
})

describe('a provisioned tenant can use the service', () => {
  test('the emitted token creates a status list, signed by the emitted key', async () => {
    const tenant = await provision({ authorizedDomains: ['status.acme.test'] })
    const env = parseEnvFile(renderEnvBlock(tenant))

    // Exactly the path a real run takes: block → .env → registry → service.
    const tenants = new EnvTenantRegistry(env)
    const config = parseConfig({ PUBLIC_BASE_URL: 'https://status.example' })
    const storage = new MemoryStorage()
    await storage.init()
    const signing = new LocalSigningService()
    const app = createApp({
      config,
      logger: createLogger({ write: () => {} }),
      services: {
        storage,
        signing,
        tenants,
        statusLists: new StatusListManager({
          storage,
          signing,
          tenants,
          publicBaseUrl: config.publicBaseUrl
        })
      }
    })

    const response = await app.request('https://status.example/status-lists', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tenant.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ statusPurpose: 'revocation' })
    })

    expect(response.status).toBe(201)
    const body = (await response.json()) as {
      verifiableCredential: { issuer: string }
    }
    expect(body.verifiableCredential.issuer).toBe(tenant.did)
  })
})
