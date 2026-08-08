import { describe, expect, test } from 'vitest'
import { createSigner } from './signer.js'
import { proofCryptosuite, verifyCredential } from './verify.js'
import type { Cryptosuite, UnsignedCredential } from './types.js'

const ED25519_SEED = 'z1Adwe2aGW4S3QVmt6ha2FwcTxfCbeNpGGWwKXC2yETHVCW'
const DID_WEB_URL = 'https://status.example.com'

const unsignedCredential = (issuer: string): UnsignedCredential => ({
  '@context': ['https://www.w3.org/ns/credentials/v2'],
  id: 'urn:uuid:0d1b0a9a-4b5f-4f9f-9d0a-2b2f8a1c7e11',
  type: ['VerifiableCredential'],
  issuer,
  validFrom: '2026-01-01T00:00:00Z',
  credentialSubject: { id: 'did:example:subject' }
})

const signerFor = (cryptosuite: Cryptosuite, didUrl?: string) =>
  createSigner({
    keyMaterial: { kind: 'ed25519-seed', seed: ED25519_SEED },
    didMethod: didUrl === undefined ? 'key' : 'web',
    cryptosuite,
    ...(didUrl === undefined ? {} : { didUrl })
  })

describe('verifyCredential', () => {
  test('verifies a did:key credential with no help from the signer', async () => {
    const signer = await signerFor('eddsa-rdfc-2022')
    const credential = await signer.signCredential(
      unsignedCredential(signer.did)
    )

    const result = await verifyCredential({ credential })
    expect(result.error).toBeUndefined()
    expect(result.verified).toBe(true)
  })

  test('rejects a tampered credential', async () => {
    const signer = await signerFor('eddsa-rdfc-2022')
    const credential = await signer.signCredential(
      unsignedCredential(signer.did)
    )
    ;(credential.credentialSubject as { id: string }).id = 'did:example:someone'

    expect((await verifyCredential({ credential })).verified).toBe(false)
  })

  // Without the document the loader would go to the network for it, which no
  // test should do — a did:web credential is verified by supplying it.
  test('takes an unpublished did:web document the way a fetch would supply it', async () => {
    const signer = await signerFor('eddsa-rdfc-2022', DID_WEB_URL)
    const credential = await signer.signCredential(
      unsignedCredential(signer.did)
    )

    const result = await verifyCredential({
      credential,
      didDocument: signer.didDocument
    })
    expect(result.error).toBeUndefined()
    expect(result.verified).toBe(true)
  })

  test('reads the suite off the proof, including the legacy one', async () => {
    const legacy = await signerFor('Ed25519Signature2020')
    const credential = await legacy.signCredential({
      ...unsignedCredential(legacy.did),
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      issuanceDate: '2026-01-01T00:00:00Z'
    })

    expect(proofCryptosuite(credential)).toBe('Ed25519Signature2020')
    expect((await verifyCredential({ credential })).verified).toBe(true)
  })

  test('refuses a credential whose proof names no suite it knows', async () => {
    const credential = {
      ...unsignedCredential('did:example:issuer'),
      proof: { type: 'FakeProof', proofValue: 'z0' }
    }

    await expect(verifyCredential({ credential })).rejects.toMatchObject({
      code: 'unsupported-cryptosuite'
    })
  })
})
