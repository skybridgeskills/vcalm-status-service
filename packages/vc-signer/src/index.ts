export {
  VCDM_BASE_CONTEXTS,
  assertCredentialContext,
  assertIssuerMatches,
  credentialIssuerId,
  withRequiredContexts
} from './credential.js'
export {
  CRYPTOSUITES,
  SUPPORTED_CRYPTOSUITES,
  assertKeyMaterialMatchesCryptosuite,
  getCryptosuite,
  isSupportedCryptosuite,
  keyMaterialMatchesCryptosuite
} from './cryptosuites.js'
export { createDocumentLoader } from './document-loader.js'
export { SigningError, isSigningError } from './errors.js'
export type { SigningErrorCode } from './errors.js'
export { decodeSeed, generateKeyMaterial } from './key-material.js'
export { createSigner } from './signer.js'
export type {
  Cryptosuite,
  CryptosuiteDescriptor,
  DidDocument,
  DidMethod,
  KeyFamily,
  KeyMaterial,
  Signer,
  SignerConfig,
  SigningKeyPair,
  SuiteOptions,
  UnsignedCredential,
  VerifiableCredential
} from './types.js'
