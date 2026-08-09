import { Hono } from 'hono'
import { sign } from 'hono/jwt'
import { describe, expect, test } from 'vitest'
import { bearerToken, createTenantAuth } from './auth.js'
import { createLogger } from './logger.js'
import { createErrorHandler } from './problem-details.js'
import { MemoryTenantRegistry } from './services/tenants-memory.js'
import { testTenant } from './test-fixtures/records.js'
import type { TenantRegistry } from './services/tenants.js'

const SECRET = 'test-access-jwt-secret'

const appWith = (
  tenants: TenantRegistry,
  config: { accessJwtSecret?: string } = {}
) =>
  new Hono()
    .onError(createErrorHandler(createLogger({ write: () => {} })))
    .use('/lists', createTenantAuth({ tenants, config }))
    .post('/lists', (c) => c.json({ tenantId: c.var.tenant.tenantId }))

const registry = () =>
  new MemoryTenantRegistry([
    testTenant(),
    testTenant({ tenantId: 'globex', tokens: ['globex-token'] })
  ])

const post = (app: Hono, authorization?: string) =>
  app.request('/lists', {
    method: 'POST',
    ...(authorization === undefined
      ? {}
      : { headers: { Authorization: authorization } })
  })

describe('bearerToken', () => {
  test('reads the token, whatever case the scheme is written in', () => {
    expect(bearerToken('Bearer abc')).toBe('abc')
    expect(bearerToken('bearer abc')).toBe('abc')
  })

  test('is nothing without a Bearer scheme and a value', () => {
    expect(bearerToken(undefined)).toBeUndefined()
    expect(bearerToken('')).toBeUndefined()
    expect(bearerToken('Bearer')).toBeUndefined()
    expect(bearerToken('Bearer   ')).toBeUndefined()
  })

  test('never reads Basic, which VCALM forbids', () => {
    const basic = Buffer.from('acme:acme-token').toString('base64')
    expect(bearerToken(`Basic ${basic}`)).toBeUndefined()
  })
})

describe('tenant authentication', () => {
  test('a static tenant token identifies its tenant', async () => {
    const response = await post(appWith(registry()), 'Bearer acme-token')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ tenantId: 'acme' })
  })

  test('an HS256 access token identifies the tenant in its subject', async () => {
    const token = await sign(
      { sub: 'globex', exp: Math.floor(Date.now() / 1000) + 60 },
      SECRET,
      'HS256'
    )
    const response = await post(
      appWith(registry(), { accessJwtSecret: SECRET }),
      `Bearer ${token}`
    )
    expect(await response.json()).toEqual({ tenantId: 'globex' })
  })

  test('a subject is matched case-insensitively, as tenant ids are lowercase', async () => {
    const token = await sign({ sub: 'ACME' }, SECRET, 'HS256')
    const response = await post(
      appWith(registry(), { accessJwtSecret: SECRET }),
      `Bearer ${token}`
    )
    expect(await response.json()).toEqual({ tenantId: 'acme' })
  })

  describe('refuses with 401 and a problem document', () => {
    const cases: [string, string | undefined][] = [
      ['no Authorization header', undefined],
      [
        'a Basic credential',
        `Basic ${Buffer.from('acme:acme-token').toString('base64')}`
      ],
      ['an unknown bearer token', 'Bearer nope'],
      ['an empty bearer token', 'Bearer ']
    ]

    test.each(cases)('%s', async (_label, authorization) => {
      const response = await post(appWith(registry()), authorization)
      expect(response.status).toBe(401)
      expect(response.headers.get('Content-Type')).toContain(
        'application/problem+json'
      )
      expect(await response.json()).toMatchObject({
        status: 401,
        title: 'Unauthorized'
      })
    })
  })

  test('an expired access token is refused, not accepted as a static one', async () => {
    const token = await sign(
      { sub: 'acme', exp: Math.floor(Date.now() / 1000) - 60 },
      SECRET,
      'HS256'
    )
    const response = await post(
      appWith(registry(), { accessJwtSecret: SECRET }),
      `Bearer ${token}`
    )
    expect(response.status).toBe(401)
  })

  test('a token signed with the wrong secret is refused', async () => {
    const token = await sign({ sub: 'acme' }, 'some-other-secret', 'HS256')
    const response = await post(
      appWith(registry(), { accessJwtSecret: SECRET }),
      `Bearer ${token}`
    )
    expect(response.status).toBe(401)
  })

  test('a valid token for an unknown tenant is refused', async () => {
    const token = await sign({ sub: 'stranger' }, SECRET, 'HS256')
    const response = await post(
      appWith(registry(), { accessJwtSecret: SECRET }),
      `Bearer ${token}`
    )
    expect(response.status).toBe(401)
  })

  test('without a configured secret, only static tokens work', async () => {
    const token = await sign({ sub: 'acme' }, SECRET, 'HS256')
    const app = appWith(registry())
    expect((await post(app, `Bearer ${token}`)).status).toBe(401)
    expect((await post(app, 'Bearer acme-token')).status).toBe(200)
  })

  test('an empty registry authenticates nobody, rather than everybody', async () => {
    const app = appWith(new MemoryTenantRegistry())
    expect((await post(app, 'Bearer acme-token')).status).toBe(401)
    expect((await post(app)).status).toBe(401)
  })
})
