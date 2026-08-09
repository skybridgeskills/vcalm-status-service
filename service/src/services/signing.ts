import type {
  UnsignedCredential,
  VerifiableCredential
} from '@skybridgeskills/vc-signer'
import type { IssuerInstance } from './issuer-instance.js'

/**
 * Signing is a service so the choice between signing in-process and calling a
 * provisioned `dcc-signing-service` is pure configuration. Status list
 * credentials are ordinary VCs, so this is the whole contract.
 *
 * Signing happens on update, inside the write transaction — never on the
 * public GET.
 */
export interface SigningService {
  /**
   * `credential.issuer` must already equal {@link issuerDid} for the instance;
   * implementations reject a mismatch rather than rewriting it.
   */
  sign(
    instance: IssuerInstance,
    unsigned: UnsignedCredential
  ): Promise<VerifiableCredential>

  /** The DID callers set as `credential.issuer` before signing. */
  issuerDid(instance: IssuerInstance): Promise<string>
}

export type SigningServiceErrorCode =
  /** The remote signer could not be reached, or answered too slowly. */
  | 'signing-unavailable'
  /** The remote signer answered, and refused. */
  | 'signing-rejected'
  /** The instance is missing something its signing mode needs. */
  | 'signing-misconfigured'

/**
 * Failures of the *service around* the signer, as distinct from `SigningError`,
 * which is about a credential and a key. `vc-signer` makes no network calls, so
 * "the remote signer is down" has no business being one of its codes.
 */
export class SigningServiceError extends Error {
  override readonly name = 'SigningServiceError'
  readonly code: SigningServiceErrorCode

  constructor(
    code: SigningServiceErrorCode,
    message?: string,
    options?: { cause?: unknown }
  ) {
    super(message ?? code, options)
    this.code = code
  }
}

/**
 * Re-exported from the signing module so routes and services read the issuer
 * the same way the signer validates it.
 */
export { credentialIssuerId } from '@skybridgeskills/vc-signer'
