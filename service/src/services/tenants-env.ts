import {
  SUPPORTED_CRYPTOSUITES,
  isSupportedCryptosuite
} from '@skybridgeskills/vc-signer'
import { MemoryTenantRegistry } from './tenants-memory.js'
import type {
  Cryptosuite,
  DidMethod,
  KeyMaterial
} from '@skybridgeskills/vc-signer'
import type { IssuerInstance } from './issuer-instance.js'
import type { TenantRecord, TenantRegistry } from './tenants.js'

/**
 * Tenants from environment variables, in the `dcc-transaction-service`
 * convention so one provisioning act writes the same shape for every service:
 *
 * ```
 * TENANT_TOKEN_ACME=secret[,second-secret]   # defines the tenant "acme"
 * TENANT_DOMAINS_ACME=status.acme.test       # optional, comma-separated
 * TENANT_DEFAULT_INSTANCE_ACME=default       # optional when there is one
 * TENANT_ISSUER_1_ID_ACME=default            # defines instance 1
 * TENANT_ISSUER_1_CRYPTOSUITE_ACME=eddsa-rdfc-2022
 * TENANT_ISSUER_1_DID_METHOD_ACME=key
 * TENANT_ISSUER_1_DID_URL_ACME=https://acme.test      # did:web only
 * TENANT_ISSUER_1_SEED_ACME=z1Adw…                    # ed25519 material
 * TENANT_ISSUER_1_PUBLIC_KEY_ACME=zDna…               # P-256 material,
 * TENANT_ISSUER_1_SECRET_KEY_ACME=z…                  #   both halves
 * TENANT_ISSUER_1_SIGNING_TENANT_ACME=acme            # SIGNING_MODE=http
 * TENANT_ISSUER_1_SIGNING_TOKEN_ACME=…                # SIGNING_MODE=http
 * TENANT_ISSUER_1_ISSUER_DID_ACME=did:web:acme.test   # SIGNING_MODE=http
 * ```
 *
 * Instances are numbered from 1 and read until a gap. Structural mistakes —
 * an unknown cryptosuite, `did:web` with no URL, half a key pair — fail the
 * boot rather than surfacing later as an unsignable list. What a *particular
 * signing mode* additionally needs is not checked here: the registry does not
 * know which mode is configured, and each `SigningService` already rejects an
 * instance it cannot use.
 */

export class TenantEnvError extends Error {
  override readonly name = 'TenantEnvError'
}

/** Tenant ids are lowercase; the env suffix is the uppercase form. */
const tenantIdFromTokenKey = (key: string): string =>
  key.slice('TENANT_TOKEN_'.length).toLowerCase()

const list = (value: string | undefined): string[] =>
  value === undefined
    ? []
    : value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)

const parseCryptosuite = (
  raw: string | undefined,
  where: string
): Cryptosuite => {
  const value = raw?.trim() ?? 'eddsa-rdfc-2022'
  if (!isSupportedCryptosuite(value)) {
    throw new TenantEnvError(
      `${where}: unknown cryptosuite "${value}". Supported: ${SUPPORTED_CRYPTOSUITES.join(', ')}.`
    )
  }
  return value
}

const parseDidMethod = (raw: string | undefined, where: string): DidMethod => {
  const value = raw?.trim() ?? 'key'
  if (value !== 'key' && value !== 'web') {
    throw new TenantEnvError(
      `${where}: unknown DID method "${value}". Supported: key, web.`
    )
  }
  return value
}

const parseKeyMaterial = (
  seed: string | undefined,
  publicKeyMultibase: string | undefined,
  secretKeyMultibase: string | undefined,
  where: string
): KeyMaterial | undefined => {
  if (seed) {
    if (publicKeyMultibase || secretKeyMultibase) {
      throw new TenantEnvError(
        `${where}: set either a seed or a multikey pair, not both.`
      )
    }
    return { kind: 'ed25519-seed', seed }
  }
  if (publicKeyMultibase && secretKeyMultibase) {
    return { kind: 'multikey', publicKeyMultibase, secretKeyMultibase }
  }
  if (publicKeyMultibase || secretKeyMultibase) {
    // The public half cannot be recovered from the secret one through the
    // WebCrypto import path, so a half-configured pair is unusable.
    throw new TenantEnvError(
      `${where}: multikey material needs both PUBLIC_KEY and SECRET_KEY.`
    )
  }
  return undefined
}

const parseIssuerInstances = (
  env: NodeJS.ProcessEnv,
  tenantId: string
): IssuerInstance[] => {
  const suffix = tenantId.toUpperCase()
  const instances: IssuerInstance[] = []

  for (let n = 1; ; n += 1) {
    const at = (field: string): string | undefined => {
      const value = env[`TENANT_ISSUER_${n}_${field}_${suffix}`]
      return value === undefined || value.trim() === ''
        ? undefined
        : value.trim()
    }

    const id = at('ID')
    if (id === undefined) break
    const where = `TENANT_ISSUER_${n}_*_${suffix}`

    const didMethod = parseDidMethod(at('DID_METHOD'), where)
    const didUrl = at('DID_URL')
    if (didMethod === 'web' && didUrl === undefined) {
      throw new TenantEnvError(
        `${where}: DID method "web" requires TENANT_ISSUER_${n}_DID_URL_${suffix}.`
      )
    }

    const keyMaterial = parseKeyMaterial(
      at('SEED'),
      at('PUBLIC_KEY'),
      at('SECRET_KEY'),
      where
    )

    if (instances.some((instance) => instance.id === id)) {
      throw new TenantEnvError(
        `${where}: issuer instance id "${id}" is used twice for tenant "${tenantId}".`
      )
    }

    instances.push({
      id,
      cryptosuite: parseCryptosuite(at('CRYPTOSUITE'), where),
      didMethod,
      ...(didUrl === undefined ? {} : { didUrl }),
      ...(keyMaterial === undefined ? {} : { keyMaterial }),
      // Defaults to the tenant id, matching transaction-service.
      signingServiceTenant: at('SIGNING_TENANT') ?? tenantId,
      ...(at('SIGNING_TOKEN') === undefined
        ? {}
        : { signingServiceToken: at('SIGNING_TOKEN') }),
      ...(at('ISSUER_DID') === undefined ? {} : { issuerDid: at('ISSUER_DID') })
    })
  }

  return instances
}

export const parseTenantsFromEnv = (env: NodeJS.ProcessEnv): TenantRecord[] => {
  const tenants: TenantRecord[] = []

  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('TENANT_TOKEN_')) continue
    const tenantId = tenantIdFromTokenKey(key)
    const suffix = tenantId.toUpperCase()
    const tokens = list(value)
    if (tokens.length === 0) {
      throw new TenantEnvError(`${key}: a tenant needs at least one token.`)
    }

    const issuerInstances = parseIssuerInstances(env, tenantId)
    const defaultInstanceId = env[`TENANT_DEFAULT_INSTANCE_${suffix}`]?.trim()
    if (
      defaultInstanceId &&
      !issuerInstances.some((instance) => instance.id === defaultInstanceId)
    ) {
      throw new TenantEnvError(
        `TENANT_DEFAULT_INSTANCE_${suffix}: no issuer instance "${defaultInstanceId}" is configured for tenant "${tenantId}".`
      )
    }
    const authorizedDomains = list(env[`TENANT_DOMAINS_${suffix}`])

    tenants.push({
      tenantId,
      tokens,
      issuerInstances,
      ...(defaultInstanceId === undefined ? {} : { defaultInstanceId }),
      ...(authorizedDomains.length === 0 ? {} : { authorizedDomains })
    })
  }

  return tenants.sort((a, b) => a.tenantId.localeCompare(b.tenantId))
}

/**
 * The registry for local runs and the first deploy: env vars are the registry,
 * so provisioning is a write to `.env` rather than a call to this service.
 * `HttpTenantRegistry`, which pulls from tenant-service, replaces it without
 * touching a caller — that is what the async interface is for.
 */
export class EnvTenantRegistry implements TenantRegistry {
  readonly #tenants: MemoryTenantRegistry

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.#tenants = new MemoryTenantRegistry(parseTenantsFromEnv(env))
  }

  async getTenant(tenantId: string): Promise<TenantRecord | undefined> {
    return await this.#tenants.getTenant(tenantId)
  }

  async getTenantByToken(token: string): Promise<TenantRecord | undefined> {
    return await this.#tenants.getTenantByToken(token)
  }
}
