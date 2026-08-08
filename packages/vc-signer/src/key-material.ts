import { decodeSecretKeySeed, generateSecretKeySeed } from '@interop/bnid'
import * as EcdsaMultikey from '@interop/ecdsa-multikey'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import {
  assertKeyMaterialMatchesCryptosuite,
  getCryptosuite
} from './cryptosuites.js'
import { SigningError } from './errors.js'
import type { Cryptosuite, KeyMaterial, SigningKeyPair } from './types.js'

/** P-256. The other ECDSA curves are out of scope until a campaign needs one. */
const ECDSA_CURVE = 'P-256'

const SEED_BYTES = 32

/**
 * Decodes a `TENANT_SEED_*`-style seed to the 32 bytes the Ed25519 suite wants.
 *
 * Two accepted forms, both inherited from DCC so existing tenant seeds keep
 * working: a multibase-encoded secret key seed (what `generateKeyMaterial` and
 * DCC's `did-cli` emit), or a raw string of at least 32 characters, of which
 * the first 32 bytes are used.
 */
export const decodeSeed = (seed: string): Uint8Array => {
  if (seed.startsWith('z')) {
    try {
      return decodeSecretKeySeed({ secretKeySeed: seed })
    } catch (cause) {
      throw new SigningError(
        'invalid-key-material',
        'Seed is not a decodable multibase secret key seed',
        { cause }
      )
    }
  }
  if (seed.length >= SEED_BYTES) {
    return new TextEncoder().encode(seed).slice(0, SEED_BYTES)
  }
  throw new SigningError(
    'invalid-key-material',
    `Seed must be multibase-encoded or at least ${SEED_BYTES} characters long`
  )
}

/**
 * Turns stored key material into a live key pair. Rejects material the suite
 * cannot use before touching any crypto, so the caller gets
 * `invalid-key-material` rather than a library's internal error.
 */
export const loadKeyPair = async (
  keyMaterial: KeyMaterial,
  cryptosuite: Cryptosuite
): Promise<SigningKeyPair> => {
  assertKeyMaterialMatchesCryptosuite(keyMaterial, cryptosuite)

  if (keyMaterial.kind === 'ed25519-seed') {
    return (await Ed25519VerificationKey.generate({
      seed: decodeSeed(keyMaterial.seed)
    })) as SigningKeyPair
  }

  try {
    return (await EcdsaMultikey.from({
      type: 'Multikey',
      publicKeyMultibase: keyMaterial.publicKeyMultibase,
      secretKeyMultibase: keyMaterial.secretKeyMultibase
    })) as SigningKeyPair
  } catch (cause) {
    throw new SigningError(
      'invalid-key-material',
      'Multikey material is not a usable P-256 key pair',
      { cause }
    )
  }
}

/**
 * Mints fresh key material for a suite. This replaces DCC's `'generate'` magic
 * seed value and its `did-*-generator` endpoints: provisioning calls this once
 * and persists the result.
 */
export const generateKeyMaterial = async (
  cryptosuite: Cryptosuite
): Promise<KeyMaterial> => {
  const { keyFamily } = getCryptosuite(cryptosuite)

  if (keyFamily === 'ed25519') {
    return { kind: 'ed25519-seed', seed: await generateSecretKeySeed() }
  }

  const keyPair = await EcdsaMultikey.generate({ curve: ECDSA_CURVE })
  const { publicKeyMultibase, secretKeyMultibase } = (await keyPair.export({
    publicKey: true,
    secretKey: true
  })) as { publicKeyMultibase?: string; secretKeyMultibase?: string }
  if (!publicKeyMultibase || !secretKeyMultibase) {
    throw new SigningError(
      'invalid-key-material',
      'Generated P-256 key pair did not export both halves'
    )
  }
  return { kind: 'multikey', publicKeyMultibase, secretKeyMultibase }
}
