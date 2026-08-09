import { SigningServiceError } from './signing.js'
import type {
  UnsignedCredential,
  VerifiableCredential
} from '@skybridgeskills/vc-signer'
import type { IssuerInstance } from './issuer-instance.js'
import type { SigningService } from './signing.js'

/**
 * Signs by calling a provisioned `dcc-signing-service`, which holds the key.
 *
 * It targets the VCALM `POST /credentials/issue` endpoint rather than the
 * legacy `/instance/{id}/credentials/sign` path: the VCALM one is
 * authenticated, it is the maintained one, and the Bearer token it takes is
 * what identifies the signing tenant — so the instance names no id in the URL.
 *
 * This runs inside the write transaction that flips a bit, per the
 * sign-on-update decision. A slow signer therefore holds a row lock, which is
 * why the request has a deadline rather than waiting on the default socket
 * timeout.
 */

const DEFAULT_TIMEOUT_MS = 10_000

export interface HttpSigningServiceOptions {
  /** Origin of the signing service, e.g. `http://signing:4006`. */
  url: string
  timeoutMs?: number
  /** Test seam. */
  fetch?: typeof globalThis.fetch
}

/**
 * `res.json(signedVC)` from today's `dcc-signing-service`, or the
 * `{verifiableCredential}` envelope VCALM describes. Accepting both keeps this
 * working across the signing-service upgrade rather than pinning it to one
 * side of it.
 */
const credentialFromResponse = (body: unknown): VerifiableCredential => {
  const envelope = body as { verifiableCredential?: unknown } | null
  const candidate =
    envelope !== null &&
    typeof envelope === 'object' &&
    envelope.verifiableCredential !== undefined
      ? envelope.verifiableCredential
      : body

  const credential = candidate as VerifiableCredential | null
  if (
    credential === null ||
    typeof credential !== 'object' ||
    credential.proof === undefined
  ) {
    throw new SigningServiceError(
      'signing-rejected',
      'The signing service returned no signed credential'
    )
  }
  return credential
}

export class HttpSigningService implements SigningService {
  readonly #url: string
  readonly #timeoutMs: number
  readonly #fetch: typeof globalThis.fetch

  constructor(options: HttpSigningServiceOptions) {
    this.#url = options.url.replace(/\/+$/, '')
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#fetch = options.fetch ?? globalThis.fetch
  }

  /**
   * The remote owns the key, so the DID cannot be derived here — it is recorded
   * on the instance at provisioning time, and its absence is a provisioning
   * bug, not a signing failure.
   */
  async issuerDid(instance: IssuerInstance): Promise<string> {
    if (!instance.issuerDid) {
      throw new SigningServiceError(
        'signing-misconfigured',
        `Issuer instance "${instance.id}" has no issuerDid recorded, which SIGNING_MODE=http requires`
      )
    }
    return instance.issuerDid
  }

  async sign(
    instance: IssuerInstance,
    unsigned: UnsignedCredential
  ): Promise<VerifiableCredential> {
    if (!instance.signingServiceToken) {
      throw new SigningServiceError(
        'signing-misconfigured',
        `Issuer instance "${instance.id}" has no signing-service token, which SIGNING_MODE=http requires`
      )
    }

    let response: Response
    try {
      response = await this.#fetch(`${this.#url}/credentials/issue`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${instance.signingServiceToken}`
        },
        body: JSON.stringify({ credential: unsigned }),
        signal: AbortSignal.timeout(this.#timeoutMs)
      })
    } catch (error) {
      throw new SigningServiceError(
        'signing-unavailable',
        `The signing service at ${this.#url} did not answer`,
        { cause: error }
      )
    }

    if (!response.ok) {
      // The body may carry the remote's own problem detail; it is for the log,
      // not for the caller, who gets our own transport-neutral code.
      const detail = await response.text().catch(() => '')
      throw new SigningServiceError(
        response.status >= 500 ? 'signing-unavailable' : 'signing-rejected',
        `The signing service refused to sign for instance "${instance.id}" (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`
      )
    }

    return credentialFromResponse(await response.json())
  }
}
