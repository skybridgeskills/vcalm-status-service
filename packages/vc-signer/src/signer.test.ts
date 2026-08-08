import { DataIntegrityProof } from '@digitalbazaar/data-integrity'
import { cryptosuite as ecdsaRdfc2019 } from '@digitalbazaar/ecdsa-rdfc-2019-cryptosuite'
import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020'
import { cryptosuite as eddsaRdfc2022 } from '@digitalbazaar/eddsa-rdfc-2022-cryptosuite'
import { verifyCredential } from '@interop/vc'
import { beforeAll, describe, expect, test } from 'vitest'
import { getCryptosuite } from './cryptosuites.js'
import { createDocumentLoader } from './document-loader.js'
import { SigningError } from './errors.js'
import { generateKeyMaterial } from './key-material.js'
import { createSigner } from './signer.js'
import type {
  Cryptosuite,
  DidMethod,
  KeyMaterial,
  Signer,
  UnsignedCredential,
  VerifiableCredential
} from './types.js'

/**
 * A seed fixed in the source, so `did:key` identifiers are reproducible across
 * runs and a regression in seed decoding shows up as a changed DID.
 */
const ED25519_SEED = 'z1Adwe2aGW4S3QVmt6ha2FwcTxfCbeNpGGWwKXC2yETHVCW'
const ED25519_DID_KEY =
  'did:key:z6Mkf2Zwdj9mpSaKsSdz7k4ECTJwr9T3iZS9VAnRabR1sksL'

const DID_WEB_URL = 'https://status.example.com'
const SUBJECT = 'did:example:subject'

/** Suites verify against the same cryptosuite, without any signing key. */
const verificationSuite = (cryptosuite: Cryptosuite): unknown => {
  switch (cryptosuite) {
    case 'eddsa-rdfc-2022':
      return new DataIntegrityProof({ cryptosuite: eddsaRdfc2022 })
    case 'ecdsa-rdfc-2019':
      return new DataIntegrityProof({ cryptosuite: ecdsaRdfc2019 })
    case 'Ed25519Signature2020':
      return new Ed25519Signature2020()
  }
}

/**
 * Verifies as an independent party would.
 *
 * `did:key` is resolved from the identifier itself — no help from the signer —
 * so a verified credential proves the published DID really carries the key
 * that signed. `did:web` has no published document in a test, so its document
 * is handed to the loader the way an HTTPS fetch would supply it.
 */
const verify = async (
  credential: VerifiableCredential,
  signer: Signer,
  cryptosuite: Cryptosuite
): Promise<{ verified: boolean; error?: Error }> =>
  (await verifyCredential({
    credential: credential as never,
    suite: verificationSuite(cryptosuite) as never,
    documentLoader: (signer.did.startsWith('did:web:')
      ? createDocumentLoader(signer.didDocument)
      : createDocumentLoader()) as never
  })) as { verified: boolean; error?: Error }

/** A VCDM 2.0 credential, except for the legacy suite which predates it. */
const credentialFor = (
  signer: Signer,
  cryptosuite: Cryptosuite
): UnsignedCredential =>
  cryptosuite === 'Ed25519Signature2020'
    ? {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        id: 'urn:uuid:38b0b6a2-6f0e-4a5f-9f6d-3a0f2b6b2f10',
        type: ['VerifiableCredential'],
        issuer: signer.did,
        issuanceDate: '2026-01-01T00:00:00Z',
        credentialSubject: { id: SUBJECT }
      }
    : {
        '@context': ['https://www.w3.org/ns/credentials/v2'],
        id: 'urn:uuid:38b0b6a2-6f0e-4a5f-9f6d-3a0f2b6b2f10',
        type: ['VerifiableCredential'],
        issuer: signer.did,
        validFrom: '2026-01-01T00:00:00Z',
        credentialSubject: { id: SUBJECT }
      }

const CRYPTOSUITES: Cryptosuite[] = [
  'eddsa-rdfc-2022',
  'ecdsa-rdfc-2019',
  'Ed25519Signature2020'
]
const DID_METHODS: DidMethod[] = ['key', 'web']

/** One generated key per suite, reused across cells to keep the matrix quick. */
const keyMaterial = new Map<Cryptosuite, KeyMaterial>()

beforeAll(async () => {
  for (const cryptosuite of CRYPTOSUITES) {
    keyMaterial.set(cryptosuite, await generateKeyMaterial(cryptosuite))
  }
})

const signerFor = (cryptosuite: Cryptosuite, didMethod: DidMethod) =>
  createSigner({
    keyMaterial: keyMaterial.get(cryptosuite)!,
    didMethod,
    cryptosuite,
    ...(didMethod === 'web' ? { didUrl: DID_WEB_URL } : {})
  })

describe.each(DID_METHODS)('did:%s', (didMethod) => {
  describe.each(CRYPTOSUITES)('%s', (cryptosuite) => {
    test('signs a credential that verifies', async () => {
      const signer = await signerFor(cryptosuite, didMethod)
      const signed = await signer.signCredential(
        credentialFor(signer, cryptosuite)
      )

      const result = await verify(signed, signer, cryptosuite)
      expect(result.error).toBeUndefined()
      expect(result.verified).toBe(true)
    })

    test('the proof names the suite and the signing key', async () => {
      const signer = await signerFor(cryptosuite, didMethod)
      const signed = await signer.signCredential(
        credentialFor(signer, cryptosuite)
      )
      const proof = signed.proof as Record<string, unknown>
      const descriptor = getCryptosuite(cryptosuite)

      expect(proof.type).toBe(descriptor.proofType)
      if (descriptor.proofType === 'DataIntegrityProof') {
        expect(proof.cryptosuite).toBe(cryptosuite)
      }
      expect(proof.proofPurpose).toBe('assertionMethod')
      expect(proof.verificationMethod).toBe(signer.verificationMethod)
      expect(signer.verificationMethod.startsWith(`${signer.did}#`)).toBe(true)
    })

    test('a tampered credential no longer verifies', async () => {
      const signer = await signerFor(cryptosuite, didMethod)
      const signed = await signer.signCredential(
        credentialFor(signer, cryptosuite)
      )
      ;(signed.credentialSubject as { id: string }).id = 'did:example:attacker'

      const result = await verify(signed, signer, cryptosuite)
      expect(result.verified).toBe(false)
    })
  })
})

describe('DID binding', () => {
  test('did:key is derived from the seed, and stays derived from it', async () => {
    const signer = await createSigner({
      keyMaterial: { kind: 'ed25519-seed', seed: ED25519_SEED },
      didMethod: 'key',
      cryptosuite: 'eddsa-rdfc-2022'
    })
    expect(signer.did).toBe(ED25519_DID_KEY)
    expect(signer.didDocument.id).toBe(ED25519_DID_KEY)
  })

  test('the same seed signs under one DID for both ed25519 suites', async () => {
    const [modern, legacy] = await Promise.all(
      (['eddsa-rdfc-2022', 'Ed25519Signature2020'] as const).map((suite) =>
        createSigner({
          keyMaterial: { kind: 'ed25519-seed', seed: ED25519_SEED },
          didMethod: 'key',
          cryptosuite: suite
        })
      )
    )
    expect(legacy!.did).toBe(modern!.did)
    expect(legacy!.verificationMethod).toBe(modern!.verificationMethod)
  })

  test('did:web takes its identifier from the URL and publishes a document', async () => {
    const signer = await createSigner({
      keyMaterial: { kind: 'ed25519-seed', seed: ED25519_SEED },
      didMethod: 'web',
      didUrl: DID_WEB_URL,
      cryptosuite: 'eddsa-rdfc-2022'
    })
    expect(signer.did).toBe('did:web:status.example.com')
    expect(signer.didDocument.verificationMethod).toBeDefined()
    expect(
      (signer.didDocument.assertionMethod as unknown[]).length
    ).toBeGreaterThan(0)
  })

  test('did:web without a URL is a configuration error', async () => {
    await expect(
      createSigner({
        keyMaterial: { kind: 'ed25519-seed', seed: ED25519_SEED },
        didMethod: 'web',
        cryptosuite: 'eddsa-rdfc-2022'
      })
    ).rejects.toMatchObject({ code: 'invalid-key-material' })
  })
})

describe('signing contract', () => {
  const signerPromise = createSigner({
    keyMaterial: { kind: 'ed25519-seed', seed: ED25519_SEED },
    didMethod: 'key',
    cryptosuite: 'eddsa-rdfc-2022'
  })

  test('an issuer that is not the signer is rejected, not rewritten', async () => {
    const signer = await signerPromise
    const credential = credentialFor(signer, 'eddsa-rdfc-2022')
    credential.issuer = 'did:example:someone-else'

    await expect(signer.signCredential(credential)).rejects.toMatchObject({
      code: 'issuer-mismatch'
    })
  })

  test('an issuer object matching the DID is accepted', async () => {
    const signer = await signerPromise
    const credential = credentialFor(signer, 'eddsa-rdfc-2022')
    credential.issuer = { id: signer.did, name: 'Example Issuer' }

    const signed = await signer.signCredential(credential)
    const result = await verify(signed, signer, 'eddsa-rdfc-2022')
    expect(result.verified).toBe(true)
  })

  test('a credential without a VCDM base context is rejected', async () => {
    const signer = await signerPromise
    const credential = credentialFor(signer, 'eddsa-rdfc-2022')
    credential['@context'] = ['https://example.com/some/other/context']

    await expect(signer.signCredential(credential)).rejects.toMatchObject({
      code: 'missing-context'
    })
  })

  test('the suite context is added without disturbing the caller order', async () => {
    const signer = await signerPromise
    const signed = await signer.signCredential(
      credentialFor(signer, 'eddsa-rdfc-2022')
    )
    expect(signed['@context']).toEqual([
      'https://www.w3.org/ns/credentials/v2',
      'https://w3id.org/security/data-integrity/v2'
    ])
  })

  test('the caller keeps an unsigned credential', async () => {
    const signer = await signerPromise
    const credential = credentialFor(signer, 'eddsa-rdfc-2022')
    await signer.signCredential(credential)

    expect('proof' in credential).toBe(false)
    expect(credential['@context']).toEqual([
      'https://www.w3.org/ns/credentials/v2'
    ])
  })

  test('`now` pins proof.created, so a re-sign of the same bytes is stable', async () => {
    const signer = await signerPromise
    const now = new Date('2026-03-04T05:06:07Z')
    const [first, second] = await Promise.all([
      signer.signCredential(credentialFor(signer, 'eddsa-rdfc-2022'), { now }),
      signer.signCredential(credentialFor(signer, 'eddsa-rdfc-2022'), { now })
    ])

    expect((first!.proof as { created: string }).created).toBe(
      '2026-03-04T05:06:07Z'
    )
    expect(second!.proof).toEqual(first!.proof)
  })
})

describe('configuration errors', () => {
  test('an unknown cryptosuite is refused before any crypto runs', async () => {
    await expect(
      createSigner({
        keyMaterial: { kind: 'ed25519-seed', seed: ED25519_SEED },
        didMethod: 'key',
        cryptosuite: 'bbs-2023' as Cryptosuite
      })
    ).rejects.toMatchObject({ code: 'unsupported-cryptosuite' })
  })

  test('key material of the wrong family is refused', async () => {
    await expect(
      createSigner({
        keyMaterial: { kind: 'ed25519-seed', seed: ED25519_SEED },
        didMethod: 'key',
        cryptosuite: 'ecdsa-rdfc-2019'
      })
    ).rejects.toMatchObject({ code: 'invalid-key-material' })
  })

  test('a malformed seed is refused', async () => {
    const attempt = createSigner({
      keyMaterial: { kind: 'ed25519-seed', seed: 'zNotASeed' },
      didMethod: 'key',
      cryptosuite: 'eddsa-rdfc-2022'
    })
    await expect(attempt).rejects.toBeInstanceOf(SigningError)
    await expect(attempt).rejects.toMatchObject({
      code: 'invalid-key-material'
    })
  })
})
