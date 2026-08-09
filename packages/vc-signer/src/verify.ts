import { verifyCredential as verifyDataIntegrityCredential } from '@interop/vc'
import { getCryptosuite } from './cryptosuites.js'
import { createDocumentLoader } from './document-loader.js'
import { SigningError } from './errors.js'
import type { Cryptosuite, DidDocument, VerifiableCredential } from './types.js'

/**
 * Proof checking, as an independent party would do it.
 *
 * This is the other half of `createSigner`, and it exists in the module rather
 * than in each consumer's tests so that "this credential verifies" means the
 * same thing everywhere — a service asserting its own output, a provisioning
 * check, an end-to-end run against a deployed instance.
 */

export interface VerificationResult {
  verified: boolean
  error?: unknown
}

const firstProof = (
  credential: VerifiableCredential
): Record<string, unknown> => {
  const { proof } = credential
  const first = Array.isArray(proof) ? proof[0] : proof
  if (first === undefined) {
    throw new SigningError('invalid-credential', 'Credential has no proof')
  }
  return first
}

/**
 * The suite a proof was made with, read off the proof itself: `cryptosuite` for
 * a Data Integrity proof, and the proof type for the legacy suite that predates
 * them.
 */
export const proofCryptosuite = (
  credential: VerifiableCredential
): Cryptosuite => {
  const proof = firstProof(credential)
  const named =
    proof.type === 'DataIntegrityProof' ? proof.cryptosuite : proof.type
  if (typeof named !== 'string') {
    throw new SigningError(
      'invalid-credential',
      'Credential proof names no cryptosuite'
    )
  }
  return getCryptosuite(named).cryptosuite
}

export const verifyCredential = async (input: {
  credential: VerifiableCredential
  /**
   * The issuer's DID document, for a `did:web` identifier whose document is not
   * published where a verifier could fetch it. `did:key` needs nothing: the key
   * is in the identifier.
   */
  didDocument?: DidDocument
}): Promise<VerificationResult> => {
  const suite = getCryptosuite(
    proofCryptosuite(input.credential)
  ).createVerificationSuite()

  return (await verifyDataIntegrityCredential({
    credential: input.credential as never,
    suite: suite as never,
    documentLoader: createDocumentLoader(input.didDocument) as never
  })) as VerificationResult
}
