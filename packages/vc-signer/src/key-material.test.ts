import { describe, expect, test } from 'vitest'
import { SigningError } from './errors.js'
import { decodeSeed, generateKeyMaterial, loadKeyPair } from './key-material.js'

/** A multibase secret key seed, of the shape `TENANT_SEED_*` values carry. */
const MULTIBASE_SEED = 'z1Adwe2aGW4S3QVmt6ha2FwcTxfCbeNpGGWwKXC2yETHVCW'

describe('decodeSeed', () => {
  test('decodes a multibase seed to 32 bytes', () => {
    expect(decodeSeed(MULTIBASE_SEED)).toHaveLength(32)
  })

  test('is deterministic — the same seed is the same key, forever', () => {
    expect(decodeSeed(MULTIBASE_SEED)).toEqual(decodeSeed(MULTIBASE_SEED))
  })

  test('accepts a long raw string, taking its first 32 bytes', () => {
    const raw = 'a'.repeat(40)
    expect(decodeSeed(raw)).toEqual(new TextEncoder().encode('a'.repeat(32)))
  })

  test('rejects a short raw string rather than padding it', () => {
    expect(() => decodeSeed('too short')).toThrowError(SigningError)
    try {
      decodeSeed('too short')
    } catch (error) {
      expect((error as SigningError).code).toBe('invalid-key-material')
    }
  })

  test('rejects a multibase-looking value that does not decode', () => {
    try {
      decodeSeed('zNotARealSeed')
      expect.unreachable('expected decodeSeed to throw')
    } catch (error) {
      expect((error as SigningError).code).toBe('invalid-key-material')
      expect((error as SigningError).cause).toBeDefined()
    }
  })
})

describe('generateKeyMaterial', () => {
  test('mints a multibase seed for the ed25519 suites', async () => {
    for (const suite of ['eddsa-rdfc-2022', 'Ed25519Signature2020'] as const) {
      const material = await generateKeyMaterial(suite)
      expect(material.kind).toBe('ed25519-seed')
      expect(decodeSeed((material as { seed: string }).seed)).toHaveLength(32)
    }
  })

  test('mints both halves of a P-256 multikey', async () => {
    const material = await generateKeyMaterial('ecdsa-rdfc-2019')
    expect(material.kind).toBe('multikey')
    if (material.kind !== 'multikey') return
    // P-256 public keys carry the `zDna` multibase-multikey header.
    expect(material.publicKeyMultibase.startsWith('zDna')).toBe(true)
    expect(material.secretKeyMultibase.startsWith('z')).toBe(true)
  })

  test('every call mints fresh material', async () => {
    const [first, second] = await Promise.all([
      generateKeyMaterial('eddsa-rdfc-2022'),
      generateKeyMaterial('eddsa-rdfc-2022')
    ])
    expect(first).not.toEqual(second)
  })

  test('refuses to mint for a suite it cannot sign with', async () => {
    await expect(
      generateKeyMaterial('bbs-2023' as never)
    ).rejects.toMatchObject({ code: 'unsupported-cryptosuite' })
  })
})

describe('loadKeyPair', () => {
  test('generated material round-trips into a usable key pair', async () => {
    for (const suite of [
      'eddsa-rdfc-2022',
      'ecdsa-rdfc-2019',
      'Ed25519Signature2020'
    ] as const) {
      const keyPair = await loadKeyPair(await generateKeyMaterial(suite), suite)
      expect(typeof keyPair.signer).toBe('function')
    }
  })

  test('rejects material from the wrong key family', async () => {
    await expect(
      loadKeyPair(
        { kind: 'ed25519-seed', seed: MULTIBASE_SEED },
        'ecdsa-rdfc-2019'
      )
    ).rejects.toMatchObject({ code: 'invalid-key-material' })
  })

  test('rejects multikey material that is not a P-256 pair', async () => {
    await expect(
      loadKeyPair(
        {
          kind: 'multikey',
          publicKeyMultibase: 'zDnaNotAKey',
          secretKeyMultibase: 'zNotASecret'
        },
        'ecdsa-rdfc-2019'
      )
    ).rejects.toMatchObject({ code: 'invalid-key-material' })
  })
})
