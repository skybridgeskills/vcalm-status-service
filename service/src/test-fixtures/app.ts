import { generateKeyMaterial } from '@skybridgeskills/vc-signer'
import { createApp } from '../app.js'
import { parseConfig } from '../config.js'
import { createLogger } from '../logger.js'
import { LocalSigningService } from '../services/signing-local.js'
import { MemoryStorage } from '../services/storage-memory.js'
import { MemoryTenantRegistry } from '../services/tenants-memory.js'
import { StatusListManager } from '../status-lists/index.js'
import type { Config } from '../config.js'
import type { Services } from '../services/index.js'
import type { TenantRecord } from '../services/tenants.js'

/**
 * A real app over in-memory backends and a **real signer**, so an HTTP test
 * asserts what a verifier would see rather than what a double agreed to say.
 */

export const TEST_BASE_URL = 'https://status.example'
export const TEST_TOKEN = 'acme-token'

export interface TestApp {
  app: ReturnType<typeof createApp>
  services: Services
  config: Config
  tenants: MemoryTenantRegistry
}

export const createTestApp = async (
  options: {
    /** Extra domains the tenant's lists may be served under. */
    authorizedDomains?: string[]
    /** Added alongside `acme`, sharing the same key material. */
    extraTenants?: string[]
  } = {}
): Promise<TestApp> => {
  const keyMaterial = await generateKeyMaterial('eddsa-rdfc-2022')
  const instances = [
    {
      id: 'default',
      cryptosuite: 'eddsa-rdfc-2022' as const,
      didMethod: 'key' as const,
      keyMaterial
    }
  ]

  const tenantFor = (tenantId: string): TenantRecord => ({
    tenantId,
    tokens: [`${tenantId}-token`],
    issuerInstances: instances,
    defaultInstanceId: 'default',
    ...(tenantId === 'acme' && options.authorizedDomains !== undefined
      ? { authorizedDomains: options.authorizedDomains }
      : {})
  })

  const config = parseConfig({ PUBLIC_BASE_URL: TEST_BASE_URL })
  const tenants = new MemoryTenantRegistry([
    tenantFor('acme'),
    ...(options.extraTenants ?? []).map(tenantFor)
  ])
  const storage = new MemoryStorage()
  await storage.init()
  const signing = new LocalSigningService()

  const services: Services = {
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

  return {
    app: createApp({
      config,
      services,
      logger: createLogger({ write: () => {} })
    }),
    services,
    config,
    tenants
  }
}

/**
 * Requests arrive at the service's own base URL, as they do in a deployment.
 * The host matters: a list is only served under a domain its tenant holds.
 */
export const request = async (
  { app }: TestApp,
  path: string,
  init?: RequestInit
): Promise<Response> => await app.request(`${TEST_BASE_URL}${path}`, init)

/** An authenticated JSON request, the way every write to this service looks. */
export const authedPost = (
  harness: TestApp,
  path: string,
  body: unknown,
  token: string = TEST_TOKEN
) =>
  request(harness, path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })
