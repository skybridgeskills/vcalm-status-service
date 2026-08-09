import { randomBytes } from 'node:crypto'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { createSigner, generateKeyMaterial } from '@skybridgeskills/vc-signer'
import type {
  Cryptosuite,
  DidMethod,
  KeyMaterial
} from '@skybridgeskills/vc-signer'

/**
 * The write side of the tenant registry, for as long as the registry is a file.
 *
 * Provisioning this service is never an API call — VCALM defines none, and
 * tenant-service owns the write side long-term. Today the registry is
 * `EnvTenantRegistry`, so provisioning is "append the right lines to `.env`",
 * and this module is what knows which lines those are.
 */

/**
 * Named, versioned profiles rather than free-form combinations, converging on
 * the platform registry decision: a profile is a set of options that make sense
 * *together*, changing one means minting a new name, and adding one is additive.
 *
 * `did:web` is deliberately absent. It is the better identifier for an
 * institution, but it is not atomic — a did:web instance is not usable until
 * its document is published at the domain — and the Multikey path for
 * `method: 'web'` is unverified in the signing service it has to interoperate
 * with. Offering it before both are settled would let provisioning
 * half-succeed. Legacy `Ed25519Signature2020` is not offered either: it is what
 * you get by omitting a cryptosuite, and leaving it reachable on purpose is how
 * tenants end up on it silently.
 */
export interface IssuerProfile {
  id: string
  didMethod: DidMethod
  cryptosuite: Cryptosuite
  summary: string
}

export const PROFILES: readonly IssuerProfile[] = Object.freeze([
  {
    id: 'did-key-eddsa-2022-v1',
    didMethod: 'key',
    cryptosuite: 'eddsa-rdfc-2022',
    summary: 'did:key + eddsa-rdfc-2022 — the default, and the exercised path'
  },
  {
    id: 'did-key-ecdsa-2019-v1',
    didMethod: 'key',
    cryptosuite: 'ecdsa-rdfc-2019',
    summary: 'did:key + ecdsa-rdfc-2019 — P-256, for an ecosystem that wants it'
  }
])

export const DEFAULT_PROFILE_ID = 'did-key-eddsa-2022-v1'

export class ProvisioningError extends Error {
  override readonly name = 'ProvisioningError'
}

export const getProfile = (id: string): IssuerProfile => {
  const profile = PROFILES.find((candidate) => candidate.id === id)
  if (profile === undefined) {
    throw new ProvisioningError(
      `Unknown profile "${id}". Available: ${PROFILES.map((p) => p.id).join(', ')}.`
    )
  }
  return profile
}

/**
 * The tenant id becomes an environment variable suffix, so it has to survive
 * being uppercased into one: letters, digits and underscores, starting with a
 * letter. A hyphen would produce `TENANT_TOKEN_ACME-EU`, which is not a shell
 * identifier and which some env loaders drop silently.
 */
export const normalizeTenantId = (raw: string): string => {
  const tenantId = raw.trim().toLowerCase()
  if (!/^[a-z][a-z0-9_]*$/.test(tenantId)) {
    throw new ProvisioningError(
      `"${raw}" is not a usable tenant name. Use letters, digits and underscores, starting with a letter — it becomes the suffix of TENANT_TOKEN_<NAME>.`
    )
  }
  return tenantId
}

/** 256 bits, base64url: long enough that nobody is tempted to shorten it. */
export const generateTenantToken = (): string =>
  randomBytes(32).toString('base64url')

export interface ProvisionInput {
  tenantId: string
  profile: IssuerProfile
  /** Unique within the tenant; lists bind to it at create. */
  instanceId: string
  token: string
  keyMaterial: KeyMaterial
  authorizedDomains: string[]
}

export interface ProvisionedTenant extends ProvisionInput {
  /** Derived here so the operator can register the issuer elsewhere. */
  did: string
  verificationMethod: string
}

export const provisionTenant = async (input: {
  tenantId: string
  profile: IssuerProfile
  instanceId?: string
  authorizedDomains?: string[]
  token?: string
  keyMaterial?: KeyMaterial
}): Promise<ProvisionedTenant> => {
  const keyMaterial =
    input.keyMaterial ?? (await generateKeyMaterial(input.profile.cryptosuite))
  const signer = await createSigner({
    keyMaterial,
    didMethod: input.profile.didMethod,
    cryptosuite: input.profile.cryptosuite
  })

  return {
    tenantId: input.tenantId,
    profile: input.profile,
    instanceId: input.instanceId ?? 'default',
    token: input.token ?? generateTenantToken(),
    keyMaterial,
    authorizedDomains: input.authorizedDomains ?? [],
    did: signer.did,
    verificationMethod: signer.verificationMethod
  }
}

const keyMaterialLines = (
  tenant: ProvisionedTenant,
  suffix: string
): string[] => {
  const { keyMaterial } = tenant
  const prefix = `TENANT_ISSUER_1`
  return keyMaterial.kind === 'ed25519-seed'
    ? [`${prefix}_SEED_${suffix}=${keyMaterial.seed}`]
    : [
        `${prefix}_PUBLIC_KEY_${suffix}=${keyMaterial.publicKeyMultibase}`,
        `${prefix}_SECRET_KEY_${suffix}=${keyMaterial.secretKeyMultibase}`
      ]
}

/** The block `EnvTenantRegistry` reads back. Instance 1, because it is new. */
export const renderEnvBlock = (tenant: ProvisionedTenant): string => {
  const suffix = tenant.tenantId.toUpperCase()
  const lines = [
    `# Tenant "${tenant.tenantId}" — profile ${tenant.profile.id} — ${tenant.did}`,
    `TENANT_TOKEN_${suffix}=${tenant.token}`,
    ...(tenant.authorizedDomains.length === 0
      ? []
      : [`TENANT_DOMAINS_${suffix}=${tenant.authorizedDomains.join(',')}`]),
    `TENANT_DEFAULT_INSTANCE_${suffix}=${tenant.instanceId}`,
    `TENANT_ISSUER_1_ID_${suffix}=${tenant.instanceId}`,
    `TENANT_ISSUER_1_CRYPTOSUITE_${suffix}=${tenant.profile.cryptosuite}`,
    `TENANT_ISSUER_1_DID_METHOD_${suffix}=${tenant.profile.didMethod}`,
    ...keyMaterialLines(tenant, suffix)
  ]
  return `${lines.join('\n')}\n`
}

/**
 * The same tenant, in the conventions two sibling services already read. These
 * are printed for the operator to paste, never written: one provisioning act,
 * one env file per service, and no tool of ours reaching across repositories.
 */
export const CROSS_SERVICE_TARGETS = [
  'signing-service',
  'transaction-service'
] as const

export type CrossServiceTarget = (typeof CROSS_SERVICE_TARGETS)[number]

export const renderCrossServiceBlock = (
  tenant: ProvisionedTenant,
  target: CrossServiceTarget
): string => {
  const suffix = tenant.tenantId.toUpperCase()

  if (target === 'transaction-service') {
    return [
      `# ${tenant.tenantId} — paste into dcc-transaction-service`,
      `TENANT_TOKEN_${suffix}=${tenant.token}`,
      `TENANT_ISSUER_1_ID_${suffix}=${tenant.instanceId}`,
      `TENANT_ISSUER_1_CRYPTOSUITE_${suffix}=${tenant.profile.cryptosuite}`,
      `TENANT_ISSUER_1_SIGNING_TENANT_${suffix}=${tenant.tenantId}`,
      ''
    ].join('\n')
  }

  if (tenant.keyMaterial.kind !== 'ed25519-seed') {
    throw new ProvisioningError(
      `dcc-signing-service takes an ed25519 seed (TENANT_SEED_<NAME>) and cannot hold ${tenant.profile.cryptosuite} material yet. Provision this tenant for the status service only, or use ${DEFAULT_PROFILE_ID}.`
    )
  }
  return [
    `# ${tenant.tenantId} — paste into dcc-signing-service`,
    `TENANT_SEED_${suffix}=${tenant.keyMaterial.seed}`,
    `TENANT_CRYPTOSUITE_${suffix}=${tenant.profile.cryptosuite}`,
    `TENANT_AUTH_TOKEN_${suffix}=${tenant.token}`,
    ''
  ].join('\n')
}

/** A working authenticated call, so a fresh tenant is provably usable. */
export const renderReadyCurl = (
  tenant: ProvisionedTenant,
  baseUrl: string
): string =>
  [
    `curl -X POST ${baseUrl}/status-lists \\`,
    `  -H "Authorization: Bearer ${tenant.token}" \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '{"statusPurpose":"revocation"}'`
  ].join('\n')

/**
 * Reads `PUBLIC_BASE_URL` out of the env file being written, so the printed
 * curl points at the service the operator is actually about to run.
 */
export const baseUrlFromEnvFile = (contents: string): string | undefined => {
  const match = /^\s*PUBLIC_BASE_URL\s*=\s*(.+?)\s*$/m.exec(contents)
  const value = match?.[1]?.replace(/^["']|["']$/g, '')
  return value === undefined || value === '' ? undefined : value
}

export const hasTenant = (contents: string, tenantId: string): boolean =>
  new RegExp(`^\\s*TENANT_TOKEN_${tenantId.toUpperCase()}\\s*=`, 'm').test(
    contents
  )

export interface EnvFileWrite {
  path: string
  created: boolean
  baseUrl: string | undefined
}

const NEW_FILE_HEADER =
  '# Written by `pnpm provision-tenant`. Secrets — never commit this file.\n'

/**
 * Appends the block, creating the file if it is not there. Appending rather
 * than rewriting is deliberate: this file is hand-edited too, and a tool that
 * reformats an operator's env is a tool they stop trusting.
 */
export const appendEnvBlock = async (
  path: string,
  block: string,
  options: { tenantId: string; force?: boolean } = { tenantId: '' }
): Promise<EnvFileWrite> => {
  let contents: string | undefined
  try {
    contents = await readFile(path, 'utf8')
  } catch {
    contents = undefined
  }

  if (
    contents !== undefined &&
    options.tenantId !== '' &&
    hasTenant(contents, options.tenantId) &&
    options.force !== true
  ) {
    throw new ProvisioningError(
      `${path} already has a TENANT_TOKEN_${options.tenantId.toUpperCase()}. Remove it, or pass --force to append a second block that will shadow it.`
    )
  }

  if (contents === undefined) {
    await writeFile(path, `${NEW_FILE_HEADER}\n${block}`, { mode: 0o600 })
    return { path, created: true, baseUrl: undefined }
  }

  const separator = contents.endsWith('\n') || contents === '' ? '\n' : '\n\n'
  await appendFile(path, `${separator}${block}`)
  return { path, created: false, baseUrl: baseUrlFromEnvFile(contents) }
}
