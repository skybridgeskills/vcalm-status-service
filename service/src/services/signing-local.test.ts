import { beforeAll, describe, expect, test } from 'vitest'
import { generateKeyMaterial } from '@skybridgeskills/vc-signer'
import type { KeyMaterial } from '@skybridgeskills/vc-signer'
import { LocalSigningService } from './signing-local.js'
import { testIssuerInstance } from '../test-fixtures/records.js'

const unsigned = (issuer: string) => ({
  '@context': ['https://www.w3.org/ns/credentials/v2'],
  id: 'https://status.example/status-lists/list-1',
  type: ['VerifiableCredential', 'BitstringStatusListCredential'],
  issuer,
  validFrom: '2026-08-08T00:00:00Z',
  credentialSubject: {
    id: 'https://status.example/status-lists/list-1#list',
    type: 'BitstringStatusList',
    statusPurpose: 'revocation',
    encodedList:
      'uH4sIAAAAAAAAA-3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAIC3AYbSVKsAQAAA'
  }
})

let keyMaterial: KeyMaterial
let otherKeyMaterial: KeyMaterial

beforeAll(async () => {
  keyMaterial = await generateKeyMaterial('eddsa-rdfc-2022')
  otherKeyMaterial = await generateKeyMaterial('eddsa-rdfc-2022')
})

const instance = () => testIssuerInstance({ keyMaterial })

describe('LocalSigningService', () => {
  test('signs a status list credential with a real proof', async () => {
    const signing = new LocalSigningService()
    const did = await signing.issuerDid(instance())
    expect(did.startsWith('did:key:z6Mk')).toBe(true)

    const signed = await signing.sign(instance(), unsigned(did))
    expect(signed.proof).toMatchObject({
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-rdfc-2022',
      proofPurpose: 'assertionMethod'
    })
  })

  test('rejects an issuer mismatch instead of rewriting the issuer', async () => {
    const signing = new LocalSigningService()
    await expect(
      signing.sign(instance(), unsigned('did:example:someone-else'))
    ).rejects.toMatchObject({ code: 'issuer-mismatch' })
  })

  test('refuses an instance with no key material to sign with', async () => {
    const signing = new LocalSigningService()
    await expect(
      signing.issuerDid(testIssuerInstance({ id: 'unprovisioned' }))
    ).rejects.toMatchObject({ code: 'invalid-key-material' })
  })

  test('two tenants sharing an instance id do not share a key', async () => {
    const signing = new LocalSigningService()
    const acme = await signing.issuerDid(testIssuerInstance({ keyMaterial }))
    const other = await signing.issuerDid(
      testIssuerInstance({ keyMaterial: otherKeyMaterial })
    )
    expect(other).not.toBe(acme)
  })

  test('a failed derivation is not cached, so a fix takes effect', async () => {
    const signing = new LocalSigningService()
    const broken = testIssuerInstance({
      keyMaterial: { kind: 'ed25519-seed', seed: 'zNotASeed' }
    })
    await expect(signing.issuerDid(broken)).rejects.toMatchObject({
      code: 'invalid-key-material'
    })
    await expect(
      signing.issuerDid(testIssuerInstance({ keyMaterial }))
    ).resolves.toContain('did:key:')
  })

  test('exposes the DID document a did:web instance has to publish', async () => {
    const signing = new LocalSigningService()
    const webInstance = testIssuerInstance({
      keyMaterial,
      didMethod: 'web',
      didUrl: 'https://status.example.com'
    })
    expect(await signing.issuerDid(webInstance)).toBe(
      'did:web:status.example.com'
    )
    expect((await signing.didDocument(webInstance)).id).toBe(
      'did:web:status.example.com'
    )
  })

  test('signs under each supported cryptosuite', async () => {
    const signing = new LocalSigningService()
    for (const cryptosuite of [
      'eddsa-rdfc-2022',
      'ecdsa-rdfc-2019',
      'Ed25519Signature2020'
    ] as const) {
      const suiteInstance = testIssuerInstance({
        cryptosuite,
        keyMaterial: await generateKeyMaterial(cryptosuite)
      })
      const did = await signing.issuerDid(suiteInstance)
      const signed = await signing.sign(suiteInstance, unsigned(did))
      expect(signed.proof).toBeDefined()
    }
  })
})
