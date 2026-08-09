import { DataIntegrityProof } from '@digitalbazaar/data-integrity'
import { cryptosuite as ecdsaRdfc2019 } from '@digitalbazaar/ecdsa-rdfc-2019-cryptosuite'
import { Ed25519Signature2020 } from '@digitalbazaar/ed25519-signature-2020'
import { cryptosuite as eddsaRdfc2022 } from '@digitalbazaar/eddsa-rdfc-2022-cryptosuite'
import { SigningError } from './errors.js'
import type {
  Cryptosuite,
  CryptosuiteDescriptor,
  KeyMaterial,
  SuiteOptions
} from './types.js'

const DATA_INTEGRITY_V2 = 'https://w3id.org/security/data-integrity/v2'
const ED25519_SIGNATURE_2020_V1 =
  'https://w3id.org/security/suites/ed25519-2020/v1'

/**
 * A Data Integrity suite is built per signing call rather than memoized with
 * the signer, because `date` — which pins `proof.created` — is a constructor
 * argument. Key derivation, the expensive part, is memoized in `createSigner`.
 */
const dataIntegrity =
  (cryptosuite: unknown) =>
  ({ keyPair, date }: SuiteOptions) =>
    new DataIntegrityProof({ signer: keyPair.signer(), cryptosuite, date })

/** The same suite with no key: verification reads the key off the proof. */
const dataIntegrityVerifier = (cryptosuite: unknown) => () =>
  new DataIntegrityProof({ cryptosuite })

/**
 * The suites this module signs with. Adding a suite (`ecdsa-sd-2023`,
 * `bbs-2023`) is a new row here plus its `createSuite` implementation — the
 * rest of the module and every consumer is driven off this registry.
 */
export const CRYPTOSUITES: Readonly<
  Record<Cryptosuite, CryptosuiteDescriptor>
> = Object.freeze({
  'eddsa-rdfc-2022': {
    cryptosuite: 'eddsa-rdfc-2022',
    proofType: 'DataIntegrityProof',
    keyFamily: 'ed25519',
    requiredContexts: [DATA_INTEGRITY_V2],
    createSuite: dataIntegrity(eddsaRdfc2022),
    createVerificationSuite: dataIntegrityVerifier(eddsaRdfc2022)
  },
  'ecdsa-rdfc-2019': {
    cryptosuite: 'ecdsa-rdfc-2019',
    proofType: 'DataIntegrityProof',
    keyFamily: 'p256',
    requiredContexts: [DATA_INTEGRITY_V2],
    createSuite: dataIntegrity(ecdsaRdfc2019),
    createVerificationSuite: dataIntegrityVerifier(ecdsaRdfc2019)
  },
  Ed25519Signature2020: {
    cryptosuite: 'Ed25519Signature2020',
    proofType: 'Ed25519Signature2020',
    keyFamily: 'ed25519',
    requiredContexts: [ED25519_SIGNATURE_2020_V1],
    // `signer` + `verificationMethod` rather than `key`: the key pair exports
    // Multikey, which this legacy suite would not accept as a `key`.
    createSuite: ({ keyPair, verificationMethod, date }: SuiteOptions) =>
      new Ed25519Signature2020({
        signer: keyPair.signer(),
        verificationMethod,
        date
      }),
    createVerificationSuite: () => new Ed25519Signature2020()
  }
})

export const SUPPORTED_CRYPTOSUITES = Object.freeze(
  Object.keys(CRYPTOSUITES) as Cryptosuite[]
)

export const isSupportedCryptosuite = (value: unknown): value is Cryptosuite =>
  typeof value === 'string' &&
  Object.prototype.hasOwnProperty.call(CRYPTOSUITES, value)

/** Looks up suite metadata, throwing `unsupported-cryptosuite` when unknown. */
export const getCryptosuite = (value: string): CryptosuiteDescriptor => {
  if (!isSupportedCryptosuite(value)) {
    throw new SigningError(
      'unsupported-cryptosuite',
      `Unsupported cryptosuite "${value}". Supported: ${SUPPORTED_CRYPTOSUITES.join(', ')}.`
    )
  }
  return CRYPTOSUITES[value]
}

/**
 * Whether the key material can back the suite. Ed25519 seeds serve both
 * `eddsa-rdfc-2022` and legacy `Ed25519Signature2020`; P-256 suites need
 * multikey material.
 */
export const keyMaterialMatchesCryptosuite = (
  keyMaterial: KeyMaterial,
  cryptosuite: Cryptosuite
): boolean => {
  const { keyFamily } = getCryptosuite(cryptosuite)
  return keyFamily === 'ed25519'
    ? keyMaterial.kind === 'ed25519-seed'
    : keyMaterial.kind === 'multikey'
}

/** Throws `invalid-key-material` when the material cannot back the suite. */
export const assertKeyMaterialMatchesCryptosuite = (
  keyMaterial: KeyMaterial,
  cryptosuite: Cryptosuite
): void => {
  if (!keyMaterialMatchesCryptosuite(keyMaterial, cryptosuite)) {
    const { keyFamily } = getCryptosuite(cryptosuite)
    throw new SigningError(
      'invalid-key-material',
      `Cryptosuite "${cryptosuite}" requires ${keyFamily} key material, got "${keyMaterial.kind}".`
    )
  }
}
