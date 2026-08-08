import { createHash } from 'node:crypto'
import { SigningError, createSigner } from '@skybridgeskills/vc-signer'
import type {
  Signer,
  UnsignedCredential,
  VerifiableCredential
} from '@skybridgeskills/vc-signer'
import type { IssuerInstance } from './issuer-instance.js'
import type { SigningService } from './signing.js'

/**
 * Signs in-process with `@skybridgeskills/vc-signer`. This is the default for
 * tests and for local/ngrok runs: no second process to provision, and a
 * bit-flip re-signs without an HTTP hop inside the write transaction.
 *
 * The alternative — calling a provisioned `dcc-signing-service` over HTTP —
 * arrives with the tenancy work that configures its per-tenant tokens.
 */
export class LocalSigningService implements SigningService {
  readonly #signers = new Map<string, Promise<Signer>>()

  /**
   * Signers are keyed by what they are made of, not by `instance.id`: instance
   * ids are unique only within a tenant, so keying on one would let a second
   * tenant's `default` instance be signed by the first tenant's key.
   */
  #cacheKey(instance: IssuerInstance): string {
    return createHash('sha256')
      .update(
        JSON.stringify([
          instance.cryptosuite,
          instance.didMethod,
          instance.didUrl ?? null,
          instance.keyMaterial
        ])
      )
      .digest('hex')
  }

  #signerFor(instance: IssuerInstance): Promise<Signer> {
    const { keyMaterial } = instance
    if (!keyMaterial) {
      return Promise.reject(
        new SigningError(
          'invalid-key-material',
          `Issuer instance "${instance.id}" has no key material to sign with`
        )
      )
    }

    const key = this.#cacheKey(instance)
    const cached = this.#signers.get(key)
    if (cached) return cached

    // A failed derivation is not cached — configuration gets fixed and retried.
    const pending = createSigner({
      keyMaterial,
      didMethod: instance.didMethod,
      cryptosuite: instance.cryptosuite,
      ...(instance.didUrl ? { didUrl: instance.didUrl } : {})
    }).catch((error: unknown) => {
      this.#signers.delete(key)
      throw error
    })
    this.#signers.set(key, pending)
    return pending
  }

  async issuerDid(instance: IssuerInstance): Promise<string> {
    return (await this.#signerFor(instance)).did
  }

  async sign(
    instance: IssuerInstance,
    unsigned: UnsignedCredential
  ): Promise<VerifiableCredential> {
    return (await this.#signerFor(instance)).signCredential(unsigned)
  }

  /**
   * The DID document an instance signs under. `did:web` instances have to
   * publish this at their `didUrl` before anyone can verify what they sign.
   */
  async didDocument(instance: IssuerInstance) {
    return (await this.#signerFor(instance)).didDocument
  }
}
