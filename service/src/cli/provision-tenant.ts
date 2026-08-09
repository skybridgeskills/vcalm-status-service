import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  CROSS_SERVICE_TARGETS,
  DEFAULT_PROFILE_ID,
  PROFILES,
  ProvisioningError,
  appendEnvBlock,
  getProfile,
  normalizeTenantId,
  provisionTenant,
  renderCrossServiceBlock,
  renderEnvBlock,
  renderReadyCurl,
  type CrossServiceTarget
} from './provisioning.js'

/**
 * `pnpm provision-tenant --tenant acme`
 *
 * Onboards a tenant end to end: a token, key material, an issuer instance, the
 * env block the service reads back, and a curl that proves it works. The
 * service itself never provisions anything — this is the local stand-in for
 * tenant-service's write side, and when that arrives this CLI is what it
 * replaces.
 *
 * Everything it prints is a secret. It is meant for a terminal, not a log.
 */

const DEFAULT_BASE_URL = 'http://localhost:4008'

const USAGE = `
Usage: pnpm provision-tenant --tenant <name> [options]

  --tenant <name>      Tenant to create. Becomes the lowercase tenant id and
                       the uppercase env suffix; letters, digits, underscores.
  --profile <id>       Issuer profile (default: ${DEFAULT_PROFILE_ID}).
  --instance <id>      Issuer instance id (default: default).
  --domains <a,b>      Domains this tenant's lists may also be served under.
  --env <path>         Env file to append to (default: .env beside the service).
  --emit <service>     Also print a block for another service, repeatable:
                       ${CROSS_SERVICE_TARGETS.join(', ')}.
  --print-only         Print everything; write nothing.
  --force              Append even if the env file already names this tenant.
  --list-profiles      Show the available profiles and exit.
  --help
`.trimStart()

const listProfiles = (): void => {
  console.log('Available issuer profiles:\n')
  for (const profile of PROFILES) {
    const marker = profile.id === DEFAULT_PROFILE_ID ? ' (default)' : ''
    console.log(`  ${profile.id}${marker}\n    ${profile.summary}`)
  }
  console.log(
    '\ndid:web is not offered yet: it needs its document published before the\ninstance works, and the Multikey web path is unverified in the signing service.'
  )
}

const parseEmitTargets = (values: string[]): CrossServiceTarget[] =>
  values.map((value) => {
    if (!(CROSS_SERVICE_TARGETS as readonly string[]).includes(value)) {
      throw new ProvisioningError(
        `Unknown --emit target "${value}". Available: ${CROSS_SERVICE_TARGETS.join(', ')}.`
      )
    }
    return value as CrossServiceTarget
  })

const run = async (): Promise<void> => {
  const { values } = parseArgs({
    options: {
      tenant: { type: 'string' },
      profile: { type: 'string', default: DEFAULT_PROFILE_ID },
      instance: { type: 'string', default: 'default' },
      domains: { type: 'string' },
      env: { type: 'string', default: '.env' },
      emit: { type: 'string', multiple: true, default: [] },
      'print-only': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      'list-profiles': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false }
    },
    strict: true
  })

  if (values.help) {
    console.log(USAGE)
    return
  }
  if (values['list-profiles']) {
    listProfiles()
    return
  }
  if (values.tenant === undefined) {
    throw new ProvisioningError(`--tenant is required.\n\n${USAGE}`)
  }

  const emit = parseEmitTargets(values.emit)
  const tenant = await provisionTenant({
    tenantId: normalizeTenantId(values.tenant),
    profile: getProfile(values.profile),
    instanceId: values.instance,
    authorizedDomains:
      values.domains
        ?.split(',')
        .map((domain) => domain.trim())
        .filter((domain) => domain !== '') ?? []
  })

  const block = renderEnvBlock(tenant)
  const envPath = resolve(values.env)

  let baseUrl = DEFAULT_BASE_URL
  if (values['print-only']) {
    console.log(`# Nothing was written. Append this to ${envPath}:\n`)
    console.log(block)
  } else {
    const written = await appendEnvBlock(envPath, block, {
      tenantId: tenant.tenantId,
      force: values.force
    })
    baseUrl = written.baseUrl ?? DEFAULT_BASE_URL
    console.log(
      `${written.created ? 'Created' : 'Updated'} ${written.path}:\n\n${block}`
    )
  }

  console.log(`Issuer DID:          ${tenant.did}`)
  console.log(`Verification method: ${tenant.verificationMethod}`)
  if (tenant.authorizedDomains.length > 0) {
    console.log(`Authorized domains:  ${tenant.authorizedDomains.join(', ')}`)
  }

  for (const target of emit) {
    console.log(`\n${renderCrossServiceBlock(tenant, target)}`)
  }

  console.log(`\nCreate this tenant's first status list:\n`)
  console.log(renderReadyCurl(tenant, baseUrl))
  console.log(
    `\nRestart the service first — the registry is read at startup. The token\nabove is not recoverable from anywhere else; it is only in that env file.`
  )
}

run().catch((error: unknown) => {
  if (error instanceof ProvisioningError) {
    console.error(error.message)
    process.exit(1)
  }
  console.error(error)
  process.exit(1)
})
