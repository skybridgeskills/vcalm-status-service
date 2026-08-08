import { describe, expect, test } from 'vitest'
import {
  CRYPTOSUITES,
  SUPPORTED_CRYPTOSUITES,
  assertKeyMaterialMatchesCryptosuite,
  getCryptosuite,
  isSupportedCryptosuite,
  keyMaterialMatchesCryptosuite
} from './cryptosuites.js'
import { SigningError } from './errors.js'
import type { KeyMaterial } from './types.js'

const ed25519Seed: KeyMaterial = { kind: 'ed25519-seed', seed: 'z1Aseed' }
const multikey: KeyMaterial = {
  kind: 'multikey',
  secretKeyMultibase: 'zMultikey'
}

describe('cryptosuite registry', () => {
  test('every registered suite is self-consistent', () => {
    for (const suite of SUPPORTED_CRYPTOSUITES) {
      expect(CRYPTOSUITES[suite].cryptosuite).toBe(suite)
      expect(CRYPTOSUITES[suite].requiredContexts.length).toBeGreaterThan(0)
    }
  })

  test('the Dim-1 harness suite is a Data Integrity proof over ed25519', () => {
    const descriptor = getCryptosuite('eddsa-rdfc-2022')
    expect(descriptor.proofType).toBe('DataIntegrityProof')
    expect(descriptor.keyFamily).toBe('ed25519')
  })

  test('legacy Ed25519Signature2020 keeps its own proof type', () => {
    expect(getCryptosuite('Ed25519Signature2020').proofType).toBe(
      'Ed25519Signature2020'
    )
  })

  test('unknown suites are rejected with a typed error', () => {
    expect(isSupportedCryptosuite('bbs-2023')).toBe(false)
    try {
      getCryptosuite('bbs-2023')
      expect.unreachable('expected getCryptosuite to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(SigningError)
      expect((error as SigningError).code).toBe('unsupported-cryptosuite')
    }
  })

  test('the registry is not mutable by consumers', () => {
    expect(() => {
      // @ts-expect-error deliberately probing the frozen registry
      CRYPTOSUITES['eddsa-rdfc-2022'] = undefined
    }).toThrow()
  })
})

describe('key material compatibility', () => {
  test('an ed25519 seed serves both ed25519 suites', () => {
    expect(keyMaterialMatchesCryptosuite(ed25519Seed, 'eddsa-rdfc-2022')).toBe(
      true
    )
    expect(
      keyMaterialMatchesCryptosuite(ed25519Seed, 'Ed25519Signature2020')
    ).toBe(true)
  })

  test('ecdsa-rdfc-2019 requires multikey material', () => {
    expect(keyMaterialMatchesCryptosuite(multikey, 'ecdsa-rdfc-2019')).toBe(
      true
    )
    expect(keyMaterialMatchesCryptosuite(ed25519Seed, 'ecdsa-rdfc-2019')).toBe(
      false
    )
  })

  test('a mismatch asserts as invalid-key-material', () => {
    try {
      assertKeyMaterialMatchesCryptosuite(multikey, 'eddsa-rdfc-2022')
      expect.unreachable('expected the assertion to throw')
    } catch (error) {
      expect((error as SigningError).code).toBe('invalid-key-material')
    }
  })
})
