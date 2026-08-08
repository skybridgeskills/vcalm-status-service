import { createHash } from 'node:crypto'
import { SigningError } from '@skybridgeskills/vc-signer'
import type {
  UnsignedCredential,
  VerifiableCredential
} from '@skybridgeskills/vc-signer'
import type { IssuerInstance } from './issuer-instance.js'
import { credentialIssuerId, type SigningService } from './signing.js'

/**
 * Test-only signer. It produces a `FakeProof` — deterministic, verifiable by
 * nobody — so tests can exercise the sign-on-update path without real crypto.
 * Config refuses `SIGNING_MODE=fake` under `NODE_ENV=production`; the proof
 * type is also deliberately not a real one, so a leaked credential fails any
 * verifier immediately rather than looking plausible.
 *
 * It enforces the same issuer contract as the real signer, so code written
 * against it keeps working when the real implementation lands.
 */
export class FakeSigningService implements SigningService {
  /** Every credential signed, in order — assertion material for tests. */
  readonly signed: VerifiableCredential[] = []

  async issuerDid(instance: IssuerInstance): Promise<string> {
    return instance.issuerDid ?? `did:example:${instance.id}`
  }

  async sign(
    instance: IssuerInstance,
    unsigned: UnsignedCredential
  ): Promise<VerifiableCredential> {
    const did = await this.issuerDid(instance)
    const issuer = credentialIssuerId(unsigned)
    if (issuer !== did) {
      throw new SigningError(
        'issuer-mismatch',
        `Credential issuer "${issuer ?? '(none)'}" does not match instance DID "${did}"`
      )
    }

    const digest = createHash('sha256')
      .update(JSON.stringify(unsigned))
      .digest('hex')

    const signedCredential: VerifiableCredential = {
      ...unsigned,
      proof: {
        type: 'FakeProof',
        cryptosuite: instance.cryptosuite,
        proofPurpose: 'assertionMethod',
        verificationMethod: `${did}#fake`,
        proofValue: `z${digest}`
      }
    }
    this.signed.push(signedCredential)
    return signedCredential
  }
}
