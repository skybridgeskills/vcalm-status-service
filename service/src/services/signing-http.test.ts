import { describe, expect, test } from 'vitest'
import { HttpSigningService } from './signing-http.js'
import { testIssuerInstance } from '../test-fixtures/records.js'
import type { UnsignedCredential } from '@skybridgeskills/vc-signer'

const URL_UNDER_TEST = 'http://signing.internal:4006'

const instance = testIssuerInstance({
  id: 'remote',
  signingServiceTenant: 'acme',
  signingServiceToken: 'signing-secret',
  issuerDid: 'did:web:acme.test'
})

const unsigned: UnsignedCredential = {
  '@context': ['https://www.w3.org/ns/credentials/v2'],
  id: 'https://status.example/status-lists/list-1',
  type: ['VerifiableCredential', 'BitstringStatusListCredential'],
  issuer: 'did:web:acme.test',
  credentialSubject: { type: 'BitstringStatusList' }
}

const signed = { ...unsigned, proof: { type: 'DataIntegrityProof' } }

/** Records the one request made, and answers with whatever the test wants. */
const stubFetch = (
  respond: (calls: Request[]) => Response | Promise<Response> | never
) => {
  const calls: Request[] = []
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input as string, init))
    return await respond(calls)
  }) as typeof globalThis.fetch
  return { calls, fetchStub }
}

const serviceWith = (fetchStub: typeof globalThis.fetch) =>
  new HttpSigningService({ url: `${URL_UNDER_TEST}/`, fetch: fetchStub })

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })

describe('HttpSigningService', () => {
  test('posts the credential to the VCALM issue endpoint as its tenant', async () => {
    const { calls, fetchStub } = stubFetch(() => jsonResponse(signed))
    const result = await serviceWith(fetchStub).sign(instance, unsigned)

    const request = calls[0]!
    expect(request.url).toBe(`${URL_UNDER_TEST}/credentials/issue`)
    expect(request.method).toBe('POST')
    expect(request.headers.get('Authorization')).toBe('Bearer signing-secret')
    expect(await request.json()).toEqual({ credential: unsigned })
    expect(result).toEqual(signed)
  })

  test('accepts the VCALM envelope as well as a bare credential', async () => {
    const { fetchStub } = stubFetch(() =>
      jsonResponse({ verifiableCredential: signed })
    )
    expect(await serviceWith(fetchStub).sign(instance, unsigned)).toEqual(
      signed
    )
  })

  test('reads the issuer DID recorded at provisioning', async () => {
    const { fetchStub } = stubFetch(() => jsonResponse(signed))
    expect(await serviceWith(fetchStub).issuerDid(instance)).toBe(
      'did:web:acme.test'
    )
  })

  describe('refuses rather than storing something unsigned', () => {
    test('when the remote returns no proof', async () => {
      const { fetchStub } = stubFetch(() => jsonResponse(unsigned))
      await expect(
        serviceWith(fetchStub).sign(instance, unsigned)
      ).rejects.toMatchObject({ code: 'signing-rejected' })
    })

    test('when the remote rejects the request', async () => {
      const { fetchStub } = stubFetch(() =>
        jsonResponse({ message: 'bad credential' }, 400)
      )
      await expect(
        serviceWith(fetchStub).sign(instance, unsigned)
      ).rejects.toMatchObject({ code: 'signing-rejected' })
    })

    test('when the remote fails, which is not the caller fault', async () => {
      const { fetchStub } = stubFetch(() => jsonResponse({}, 502))
      await expect(
        serviceWith(fetchStub).sign(instance, unsigned)
      ).rejects.toMatchObject({ code: 'signing-unavailable' })
    })

    test('when the remote cannot be reached at all', async () => {
      const { fetchStub } = stubFetch(() => {
        throw new TypeError('fetch failed')
      })
      await expect(
        serviceWith(fetchStub).sign(instance, unsigned)
      ).rejects.toMatchObject({ code: 'signing-unavailable' })
    })
  })

  describe('refuses an instance HTTP signing cannot use', () => {
    test('with no signing-service token', async () => {
      const { calls, fetchStub } = stubFetch(() => jsonResponse(signed))
      await expect(
        serviceWith(fetchStub).sign(
          testIssuerInstance({ issuerDid: 'did:web:acme.test' }),
          unsigned
        )
      ).rejects.toMatchObject({ code: 'signing-misconfigured' })
      // Refused before the network, so a misconfigured instance cannot leak a
      // credential to a service that would not have signed it.
      expect(calls).toHaveLength(0)
    })

    test('with no recorded issuer DID, which only provisioning knows', async () => {
      const { fetchStub } = stubFetch(() => jsonResponse(signed))
      await expect(
        serviceWith(fetchStub).issuerDid(testIssuerInstance())
      ).rejects.toMatchObject({ code: 'signing-misconfigured' })
    })
  })
})
