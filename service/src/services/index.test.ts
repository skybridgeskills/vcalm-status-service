import { describe, expect, test } from 'vitest'
import { createServices } from './index.js'
import { FakeSigningService } from './signing-fake.js'
import { HttpSigningService } from './signing-http.js'
import { LocalSigningService } from './signing-local.js'
import { MemoryStorage } from './storage-memory.js'
import { SqlStorage } from './storage-sql.js'
import { EnvTenantRegistry } from './tenants-env.js'
import { MemoryTenantRegistry } from './tenants-memory.js'
import { parseConfig } from '../config.js'
import { StatusListManager } from '../status-lists/index.js'

describe('createServices', () => {
  test('builds the in-memory graph selected by config', () => {
    const services = createServices(parseConfig({}))
    expect(services.storage).toBeInstanceOf(MemoryStorage)
    expect(services.signing).toBeInstanceOf(FakeSigningService)
    expect(services.tenants).toBeInstanceOf(MemoryTenantRegistry)
    expect(services.statusLists).toBeInstanceOf(StatusListManager)
  })

  test('selects one SQL implementation for both dialects', () => {
    // Constructed, not connected: nothing talks to a database until init().
    expect(
      createServices(parseConfig({ STORAGE_MODE: 'sqlite' })).storage
    ).toBeInstanceOf(SqlStorage)
    expect(
      createServices(
        parseConfig({
          STORAGE_MODE: 'postgres',
          DATABASE_URL: 'postgres://localhost/status'
        })
      ).storage
    ).toBeInstanceOf(SqlStorage)
  })

  test('selects the in-process signer by configuration alone', () => {
    const services = createServices(parseConfig({ SIGNING_MODE: 'local' }))
    expect(services.signing).toBeInstanceOf(LocalSigningService)
  })

  test('selects the remote signer, which needs no key material here', () => {
    const services = createServices(
      parseConfig({
        SIGNING_MODE: 'http',
        SIGNING_SERVICE_URL: 'http://signing.internal:4006'
      })
    )
    expect(services.signing).toBeInstanceOf(HttpSigningService)
  })

  test('selects the environment registry', () => {
    const services = createServices(
      parseConfig({ TENANT_REGISTRY_MODE: 'env' })
    )
    expect(services.tenants).toBeInstanceOf(EnvTenantRegistry)
  })

  test('reports the chosen implementations to the logger', () => {
    const lines: string[] = []
    createServices(parseConfig({}), {
      debug: () => {},
      info: (message, fields) =>
        lines.push(`${message} ${JSON.stringify(fields)}`),
      warn: () => {},
      error: () => {},
      child: function () {
        return this
      }
    })
    expect(lines[0]).toContain('"storage":"memory"')
  })
})
