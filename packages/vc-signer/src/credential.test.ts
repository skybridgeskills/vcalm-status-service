import { describe, expect, test } from 'vitest'
import {
  assertCredentialContext,
  assertIssuerMatches,
  credentialIssuerId,
  withRequiredContexts
} from './credential.js'
import type { SigningError } from './errors.js'
import type { UnsignedCredential } from './types.js'

const DID = 'did:key:z6MkExample'

const credential = (
  overrides: Partial<UnsignedCredential> = {}
): UnsignedCredential => ({
  '@context': ['https://www.w3.org/ns/credentials/v2'],
  type: ['VerifiableCredential'],
  issuer: DID,
  credentialSubject: { id: 'did:example:subject' },
  ...overrides
})

const codeOf = (fn: () => void): string | undefined => {
  try {
    fn()
    return undefined
  } catch (error) {
    return (error as SigningError).code
  }
}

describe('credentialIssuerId', () => {
  test('reads a string issuer', () => {
    expect(credentialIssuerId(credential())).toBe(DID)
  })

  test('reads an object issuer', () => {
    expect(
      credentialIssuerId(credential({ issuer: { id: DID, name: 'Example' } }))
    ).toBe(DID)
  })
})

describe('assertIssuerMatches', () => {
  test('accepts either issuer form when it names the signer', () => {
    expect(codeOf(() => assertIssuerMatches(credential(), DID))).toBeUndefined()
    expect(
      codeOf(() =>
        assertIssuerMatches(credential({ issuer: { id: DID } }), DID)
      )
    ).toBeUndefined()
  })

  test('rejects a different issuer instead of rewriting it', () => {
    const other = credential({ issuer: 'did:key:z6MkSomeoneElse' })
    expect(codeOf(() => assertIssuerMatches(other, DID))).toBe(
      'issuer-mismatch'
    )
    expect(other.issuer).toBe('did:key:z6MkSomeoneElse')
  })

  test('rejects a missing issuer', () => {
    const missing = credential()
    delete (missing as { issuer?: unknown }).issuer
    expect(codeOf(() => assertIssuerMatches(missing, DID))).toBe(
      'issuer-mismatch'
    )
  })
})

describe('assertCredentialContext', () => {
  test.each([
    'https://www.w3.org/2018/credentials/v1',
    'https://www.w3.org/ns/credentials/v2'
  ])('accepts %s as the base context', (base) => {
    expect(
      codeOf(() => assertCredentialContext(credential({ '@context': [base] })))
    ).toBeUndefined()
  })

  test('accepts a bare string context', () => {
    expect(
      codeOf(() =>
        assertCredentialContext(
          credential({ '@context': 'https://www.w3.org/ns/credentials/v2' })
        )
      )
    ).toBeUndefined()
  })

  test('rejects a base context that is not first', () => {
    expect(
      codeOf(() =>
        assertCredentialContext(
          credential({
            '@context': [
              'https://example.com/other',
              'https://www.w3.org/ns/credentials/v2'
            ]
          })
        )
      )
    ).toBe('missing-context')
  })

  test('rejects an absent or empty context', () => {
    const none = credential()
    delete (none as { '@context'?: unknown })['@context']
    expect(codeOf(() => assertCredentialContext(none))).toBe('missing-context')
    expect(
      codeOf(() => assertCredentialContext(credential({ '@context': [] })))
    ).toBe('missing-context')
  })
})

describe('withRequiredContexts', () => {
  const DI_V2 = 'https://w3id.org/security/data-integrity/v2'

  test('appends the suite context after the caller’s own', () => {
    const result = withRequiredContexts(credential(), [DI_V2])
    expect(result['@context']).toEqual([
      'https://www.w3.org/ns/credentials/v2',
      DI_V2
    ])
  })

  test('does not duplicate a context the caller already declared', () => {
    const already = credential({
      '@context': ['https://www.w3.org/ns/credentials/v2', DI_V2]
    })
    expect(withRequiredContexts(already, [DI_V2])['@context']).toEqual([
      'https://www.w3.org/ns/credentials/v2',
      DI_V2
    ])
  })

  test('normalizes a bare string context into a list', () => {
    const bare = credential({
      '@context': 'https://www.w3.org/ns/credentials/v2'
    })
    expect(withRequiredContexts(bare, [DI_V2])['@context']).toEqual([
      'https://www.w3.org/ns/credentials/v2',
      DI_V2
    ])
  })

  test('leaves the caller’s credential untouched, nested values included', () => {
    const original = credential()
    const copy = withRequiredContexts(original, [DI_V2])
    ;(copy.credentialSubject as { id: string }).id = 'did:example:mutated'

    expect(original['@context']).toEqual([
      'https://www.w3.org/ns/credentials/v2'
    ])
    expect((original.credentialSubject as { id: string }).id).toBe(
      'did:example:subject'
    )
  })
})
