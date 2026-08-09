import { Hono } from 'hono'
import { describe, expect, test } from 'vitest'
import {
  authorizedHosts,
  effectiveHost,
  hostname,
  isAuthorizedHost,
  isAuthorizedListUrl
} from './domains.js'
import { testTenant } from './test-fixtures/records.js'

const PUBLIC_BASE_URL = 'https://status.example'
const tenant = testTenant({
  authorizedDomains: ['status.acme.test', 'https://acme.example/ignored']
})
const bare = testTenant()

describe('hostname', () => {
  test('accepts a bare domain, a host:port, and a full URL', () => {
    expect(hostname('status.acme.test')).toBe('status.acme.test')
    expect(hostname('status.acme.test:8443')).toBe('status.acme.test')
    expect(hostname('https://status.acme.test/lists?a=1')).toBe(
      'status.acme.test'
    )
  })

  test('normalizes case, since hosts are case-insensitive', () => {
    expect(hostname('Status.ACME.test')).toBe('status.acme.test')
  })

  test('is nothing for what is not a host', () => {
    expect(hostname(undefined)).toBeUndefined()
    expect(hostname('')).toBeUndefined()
    expect(hostname('   ')).toBeUndefined()
  })
})

describe('effectiveHost', () => {
  const hostSeenBy = async (headers: Record<string, string>) => {
    let seen: string | undefined
    const app = new Hono().get('/', (c) => {
      seen = effectiveHost(c)
      return c.body(null, 204)
    })
    await app.request('http://internal.local/', { headers })
    return seen
  }

  test('prefers the forwarded host, which is the one the caller dialled', async () => {
    expect(await hostSeenBy({ 'X-Forwarded-Host': 'status.acme.test' })).toBe(
      'status.acme.test'
    )
  })

  test('takes the first entry of a proxy chain', async () => {
    expect(
      await hostSeenBy({
        'X-Forwarded-Host': 'status.acme.test, internal.local'
      })
    ).toBe('status.acme.test')
  })

  test('falls back to Host when nothing forwarded one', async () => {
    expect(await hostSeenBy({})).toBe('internal.local')
  })
})

describe('authorized hosts', () => {
  test('always include the service own domain, unlisted', () => {
    expect(authorizedHosts(bare, PUBLIC_BASE_URL)).toEqual(
      new Set(['status.example'])
    )
  })

  test('add the tenant own domains, however they were written', () => {
    expect([...authorizedHosts(tenant, PUBLIC_BASE_URL)].sort()).toEqual([
      'acme.example',
      'status.acme.test',
      'status.example'
    ])
  })

  test('serve a tenant list under its own domain or the shared one', () => {
    expect(isAuthorizedHost(tenant, 'status.acme.test', PUBLIC_BASE_URL)).toBe(
      true
    )
    expect(isAuthorizedHost(tenant, 'status.example', PUBLIC_BASE_URL)).toBe(
      true
    )
  })

  test('refuse another tenant domain, which is the point of the check', () => {
    expect(isAuthorizedHost(bare, 'status.acme.test', PUBLIC_BASE_URL)).toBe(
      false
    )
    expect(isAuthorizedHost(tenant, 'evil.test', PUBLIC_BASE_URL)).toBe(false)
    expect(isAuthorizedHost(tenant, undefined, PUBLIC_BASE_URL)).toBe(false)
  })

  test('ignore the port, since a domain is authorized and not a socket', () => {
    expect(
      isAuthorizedHost(tenant, 'status.acme.test:8443', PUBLIC_BASE_URL)
    ).toBe(true)
  })
})

describe('isAuthorizedListUrl', () => {
  test('accepts a URL under an authorized domain', () => {
    expect(
      isAuthorizedListUrl(
        tenant,
        'https://status.acme.test/status-lists/ccp-d1',
        PUBLIC_BASE_URL
      )
    ).toBe(true)
  })

  test('accepts the service own base, which every tenant may mint under', () => {
    expect(
      isAuthorizedListUrl(
        bare,
        'https://status.example/status-lists/abc',
        PUBLIC_BASE_URL
      )
    ).toBe(true)
  })

  test('refuses a domain the tenant does not hold', () => {
    expect(
      isAuthorizedListUrl(
        bare,
        'https://status.acme.test/status-lists/abc',
        PUBLIC_BASE_URL
      )
    ).toBe(false)
  })

  test('refuses what is not an absolute http(s) URL', () => {
    for (const url of [
      'status.example/status-lists/abc',
      '/status-lists/abc',
      'ftp://status.example/status-lists/abc',
      'javascript:alert(1)',
      ''
    ]) {
      expect(isAuthorizedListUrl(tenant, url, PUBLIC_BASE_URL)).toBe(false)
    }
  })
})
