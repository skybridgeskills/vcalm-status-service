import { describe, expect, test } from 'vitest'
import { createServices } from './index.js'
import { FakeSigningService } from './signing-fake.js'
import { LocalSigningService } from './signing-local.js'
import { MemoryStorage } from './storage-memory.js'
import { MemoryTenantRegistry } from './tenants-memory.js'
import { parseConfig } from '../config.js'

describe('createServices', () => {
  test('builds the in-memory graph selected by config', () => {
    const services = createServices(parseConfig({}))
    expect(services.storage).toBeInstanceOf(MemoryStorage)
    expect(services.signing).toBeInstanceOf(FakeSigningService)
    expect(services.tenants).toBeInstanceOf(MemoryTenantRegistry)
  })

  test('selects the in-process signer by configuration alone', () => {
    const services = createServices(parseConfig({ SIGNING_MODE: 'local' }))
    expect(services.signing).toBeInstanceOf(LocalSigningService)
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
