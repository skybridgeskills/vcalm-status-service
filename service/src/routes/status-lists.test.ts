import { verifyCredential } from '@skybridgeskills/vc-signer'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  TEST_BASE_URL,
  authedPost,
  createTestApp,
  request,
  type TestApp
} from '../test-fixtures/app.js'
import { EMPTY_ENCODED_LIST } from '../test-fixtures/records.js'
import type { VerifiableCredential } from '@skybridgeskills/vc-signer'

let harness: TestApp

const create = (body: unknown, token?: string) =>
  authedPost(harness, '/status-lists', body, token)

const createRevocationList = async (options?: Record<string, unknown>) => {
  const response = await create({
    statusPurpose: 'revocation',
    ...(options === undefined ? {} : { options })
  })
  expect(response.status).toBe(201)
  return (await response.json()) as {
    id: string
    verifiableCredential: VerifiableCredential
  }
}

beforeEach(async () => {
  harness = await createTestApp({ authorizedDomains: ['status.acme.test'] })
})

describe('POST /status-lists', () => {
  test('refuses an unauthenticated create', async () => {
    const response = await request(harness, '/status-lists', {
      method: 'POST',
      body: JSON.stringify({ statusPurpose: 'revocation' })
    })
    expect(response.status).toBe(401)
  })

  test('creates a signed, all-zero list and says where it lives', async () => {
    const response = await create({ statusPurpose: 'revocation' })
    expect(response.status).toBe(201)

    const body = (await response.json()) as {
      id: string
      verifiableCredential: VerifiableCredential
    }
    expect(body.id).toMatch(
      new RegExp(`^${TEST_BASE_URL}/status-lists/[0-9a-f-]{36}$`)
    )
    expect(response.headers.get('Location')).toBe(body.id)

    const credential = body.verifiableCredential
    expect(credential.id).toBe(body.id)
    expect(credential.type).toContain('BitstringStatusListCredential')
    expect(credential.credentialSubject).toMatchObject({
      type: 'BitstringStatusList',
      statusPurpose: 'revocation',
      encodedList: EMPTY_ENCODED_LIST
    })

    const verification = await verifyCredential({ credential })
    expect(verification.error).toBeUndefined()
    expect(verification.verified).toBe(true)
  })

  test('creates a suspension list too, which is a separate list', async () => {
    const revocation = await createRevocationList()
    const suspension = await create({ statusPurpose: 'suspension' })
    expect(suspension.status).toBe(201)
    expect(((await suspension.json()) as { id: string }).id).not.toBe(
      revocation.id
    )
  })

  test('copies an opted-in ttl onto the credential', async () => {
    const body = await createRevocationList({ ttl: 300_000 })
    expect(body.verifiableCredential.credentialSubject).toMatchObject({
      ttl: 300_000
    })
  })

  describe('refuses a request the contract does not allow', () => {
    test('an unknown status purpose', async () => {
      const response = await create({ statusPurpose: 'refresh' })
      expect(response.status).toBe(400)
      expect(response.headers.get('Content-Type')).toContain(
        'application/problem+json'
      )
    })

    test('an unknown top-level key', async () => {
      const response = await create({
        statusPurpose: 'revocation',
        lenght: 131072
      })
      expect(response.status).toBe(400)
    })

    test('an unknown options key, so a typo fails loudly', async () => {
      const response = await create({
        statusPurpose: 'revocation',
        options: { lenght: 131072 }
      })
      expect(response.status).toBe(400)
    })

    test('a list below the herd-privacy floor', async () => {
      const response = await create({
        statusPurpose: 'revocation',
        options: { length: 100_000 }
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'list-too-short' })
    })

    test('multi-bit entries, with a reason rather than "unknown key"', async () => {
      const response = await create({
        statusPurpose: 'revocation',
        options: { statusSize: 2 }
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        code: 'unsupported-characteristics'
      })
    })

    test('an issuer instance the tenant does not have', async () => {
      const response = await create({
        statusPurpose: 'revocation',
        options: { issuerInstance: 'nope' }
      })
      expect(response.status).toBe(400)
    })
  })

  describe('a client-supplied canonical id', () => {
    test('is honored under a domain the tenant holds', async () => {
      const url = 'https://status.acme.test/status-lists/ccp-d1'
      const response = await create({ statusPurpose: 'revocation', id: url })
      expect(response.status).toBe(201)

      const body = (await response.json()) as {
        id: string
        verifiableCredential: VerifiableCredential
      }
      expect(body.id).toBe(url)
      expect(body.verifiableCredential.id).toBe(url)
      expect(response.headers.get('Location')).toBe(url)

      // The slug is the path segment, so the GET can still find it.
      const served = await request(harness, '/status-lists/ccp-d1', {
        headers: { Host: 'status.acme.test' }
      })
      expect(served.status).toBe(200)
    })

    test('is refused under a domain it does not', async () => {
      const response = await create({
        statusPurpose: 'revocation',
        id: 'https://evil.test/status-lists/ccp-d1'
      })
      expect(response.status).toBe(400)
    })

    test('is refused when the path is not one this service serves', async () => {
      const response = await create({
        statusPurpose: 'revocation',
        id: 'https://status.acme.test/lists/ccp-d1'
      })
      expect(response.status).toBe(400)
    })

    test('cannot take an id another list already holds', async () => {
      const id = 'https://status.acme.test/status-lists/ccp-d1'
      expect((await create({ statusPurpose: 'revocation', id })).status).toBe(
        201
      )
      const second = await create({ statusPurpose: 'suspension', id })
      expect(second.status).toBe(409)
      expect(await second.json()).toMatchObject({ code: 'duplicate-list' })
    })
  })
})

describe('GET /status-lists/:id', () => {
  const slugOf = (url: string) => url.slice(url.lastIndexOf('/') + 1)

  test('serves the stored credential to anyone, unauthenticated', async () => {
    const created = await createRevocationList()
    const response = await request(
      harness,
      `/status-lists/${slugOf(created.id)}`
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('application/json')
    const credential = (await response.json()) as VerifiableCredential
    expect(credential).toEqual(created.verifiableCredential)
    expect((await verifyCredential({ credential })).verified).toBe(true)
  })

  test('is revalidatable by default, so a flip can never be masked', async () => {
    const created = await createRevocationList()
    const response = await request(
      harness,
      `/status-lists/${slugOf(created.id)}`
    )
    expect(response.headers.get('Cache-Control')).toBe('no-cache')
    expect(response.headers.get('ETag')).toBe('"1"')
  })

  test('aligns max-age with a list ttl, as BSL asks', async () => {
    const created = await createRevocationList({ ttl: 300_000 })
    const response = await request(
      harness,
      `/status-lists/${slugOf(created.id)}`
    )
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300')
  })

  test('answers a revalidation with 304 and no body', async () => {
    const created = await createRevocationList()
    const path = `/status-lists/${slugOf(created.id)}`
    const etag = (await request(harness, path)).headers.get('ETag')!

    const response = await request(harness, path, {
      headers: { 'If-None-Match': etag }
    })
    expect(response.status).toBe(304)
    expect(await response.text()).toBe('')
    expect(response.headers.get('ETag')).toBe(etag)
  })

  test('honors Accept: application/vc with the same body', async () => {
    const created = await createRevocationList()
    const response = await request(
      harness,
      `/status-lists/${slugOf(created.id)}`,
      { headers: { Accept: 'application/vc' } }
    )
    expect(response.headers.get('Content-Type')).toContain('application/vc')
    expect(await response.json()).toEqual(created.verifiableCredential)
  })

  test('is a problem document for a list that does not exist', async () => {
    const response = await request(harness, '/status-lists/nope')
    expect(response.status).toBe(404)
    expect(response.headers.get('Content-Type')).toContain(
      'application/problem+json'
    )
  })

  describe('authorized domains', () => {
    test('serve under a domain the owning tenant holds', async () => {
      const created = await createRevocationList()
      const response = await request(
        harness,
        `/status-lists/${slugOf(created.id)}`,
        { headers: { 'X-Forwarded-Host': 'status.acme.test' } }
      )
      expect(response.status).toBe(200)
    })

    test('refuse under a domain it does not, as if the list were not there', async () => {
      const created = await createRevocationList()
      const response = await request(
        harness,
        `/status-lists/${slugOf(created.id)}`,
        { headers: { 'X-Forwarded-Host': 'someone-else.test' } }
      )
      expect(response.status).toBe(404)
    })

    test('always serve under the service own domain', async () => {
      const created = await createRevocationList()
      const response = await request(
        harness,
        `/status-lists/${slugOf(created.id)}`,
        { headers: { 'X-Forwarded-Host': 'status.example' } }
      )
      expect(response.status).toBe(200)
    })
  })
})
