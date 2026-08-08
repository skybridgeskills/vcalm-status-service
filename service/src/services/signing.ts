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

/**
 * Re-exported from the signing module so routes and services read the issuer
 * the same way the signer validates it.
 */
export { credentialIssuerId } from '@skybridgeskills/vc-signer'
