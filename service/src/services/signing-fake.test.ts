import { describe, expect, test } from 'vitest'
import { SigningError } from '@skybridgeskills/vc-signer'
import { FakeSigningService } from './signing-fake.js'
import { testIssuerInstance } from '../test-fixtures/records.js'

const unsigned = (issuer: string) => ({
  '@context': ['https://www.w3.org/ns/credentials/v2'],
  type: ['VerifiableCredential', 'BitstringStatusListCredential'],
  issuer,
  credentialSubject: { type: 'BitstringStatusList', encodedList: 'uAAA' }
})

describe('FakeSigningService', () => {
  const instance = testIssuerInstance()

  test('derives a placeholder DID from the instance', async () => {
    const signing = new FakeSigningService()
    expect(await signing.issuerDid(instance)).toBe('did:example:default')
    expect(
      await signing.issuerDid(
        testIssuerInstance({ issuerDid: 'did:web:acme.example' })
      )
    ).toBe('did:web:acme.example')
  })

  test('attaches a proof that no verifier will accept', async () => {
    const signing = new FakeSigningService()
    const signed = await signing.sign(instance, unsigned('did:example:default'))
    expect(signed.proof).toMatchObject({
      type: 'FakeProof',
      cryptosuite: 'eddsa-rdfc-2022',
      verificationMethod: 'did:example:default#fake'
    })
    expect(signing.signed).toHaveLength(1)
  })

  test('is deterministic for identical input', async () => {
    const signing = new FakeSigningService()
    const first = await signing.sign(instance, unsigned('did:example:default'))
    const second = await signing.sign(instance, unsigned('did:example:default'))
    expect(first.proof).toEqual(second.proof)
  })

  test('rejects an issuer mismatch instead of rewriting the issuer', async () => {
    const signing = new FakeSigningService()
    await expect(
      signing.sign(instance, unsigned('did:example:someone-else'))
    ).rejects.toBeInstanceOf(SigningError)
    await expect(
      signing.sign(instance, unsigned('did:example:someone-else'))
    ).rejects.toMatchObject({ code: 'issuer-mismatch' })
    expect(signing.signed).toHaveLength(0)
  })

  test('accepts an object-form issuer that carries the right DID', async () => {
    const signing = new FakeSigningService()
    const signed = await signing.sign(instance, {
      ...unsigned('unused'),
      issuer: { id: 'did:example:default', name: 'Acme' }
    })
    expect(signed.proof).toBeDefined()
  })
})
