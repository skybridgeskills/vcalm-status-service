export {
  CRYPTOSUITES,
  SUPPORTED_CRYPTOSUITES,
  assertKeyMaterialMatchesCryptosuite,
  getCryptosuite,
  isSupportedCryptosuite,
  keyMaterialMatchesCryptosuite
} from './cryptosuites.js'
export { SigningError, isSigningError } from './errors.js'
export type { SigningErrorCode } from './errors.js'
export type {
  Cryptosuite,
  CryptosuiteDescriptor,
  DidMethod,
  KeyFamily,
  KeyMaterial,
  Signer,
  SignerConfig,
  UnsignedCredential,
  VerifiableCredential
} from './types.js'
