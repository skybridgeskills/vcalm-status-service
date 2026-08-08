import { SigningError } from './errors.js'
import type { UnsignedCredential } from './types.js'

/** Base contexts VCDM requires as the first entry of `@context`. */
export const VCDM_BASE_CONTEXTS = Object.freeze([
  'https://www.w3.org/2018/credentials/v1',
  'https://www.w3.org/ns/credentials/v2'
])

/** `credential.issuer` is either a DID string or an object carrying one. */
export const credentialIssuerId = (
  credential: UnsignedCredential
): string | undefined =>
  typeof credential.issuer === 'string'
    ? credential.issuer
    : credential.issuer?.id

/**
 * Rejects a credential whose issuer is not the signing DID.
 *
 * Deliberately unlike DCC's `addIssuerId`, which silently overwrites whatever
 * the caller sent: a caller that names the wrong issuer has a bug, and a
 * signature is the wrong place to paper over it. Callers set the issuer from
 * `signer.did`; the signing-service adapter keeps its legacy overwrite by
 * doing so before it calls.
 */
export const assertIssuerMatches = (
  credential: UnsignedCredential,
  did: string
): void => {
  const issuer = credentialIssuerId(credential)
  if (issuer !== did) {
    throw new SigningError(
      'issuer-mismatch',
      `Credential issuer "${issuer ?? '(none)'}" does not match signer DID "${did}"`
    )
  }
}

const contextEntries = (
  credential: UnsignedCredential
): (string | Record<string, unknown>)[] => {
  const context = credential['@context']
  if (context === undefined || context === null) return []
  return Array.isArray(context) ? context : [context]
}

/**
 * Rejects a credential that does not lead with a VCDM base context. Without
 * one the JSON-LD terms a credential is made of are undefined, and the proof
 * would cover a document that says nothing — which the underlying libraries
 * report, if at all, as an opaque canonicalization failure.
 */
export const assertCredentialContext = (
  credential: UnsignedCredential
): void => {
  const [first] = contextEntries(credential)
  if (typeof first !== 'string' || !VCDM_BASE_CONTEXTS.includes(first)) {
    throw new SigningError(
      'missing-context',
      `Credential "@context" must begin with one of: ${VCDM_BASE_CONTEXTS.join(', ')}`
    )
  }
}

/**
 * Returns a copy of the credential with the suite's contexts appended, keeping
 * caller-supplied contexts first and in order. The copy matters twice over:
 * the underlying `issue()` attaches the proof to the object it is given, and
 * callers hand us records they still hold.
 */
export const withRequiredContexts = (
  credential: UnsignedCredential,
  requiredContexts: readonly string[]
): UnsignedCredential => {
  const copy = structuredClone(credential)
  const merged = contextEntries(copy)
  for (const context of requiredContexts) {
    if (!merged.includes(context)) merged.push(context)
  }
  copy['@context'] = merged
  return copy
}
