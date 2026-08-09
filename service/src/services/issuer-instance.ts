import type {
  Cryptosuite,
  DidMethod,
  KeyMaterial
} from '@skybridgeskills/vc-signer'

/**
 * One issuance line belonging to a tenant: which key signs, under which DID,
 * with which cryptosuite. A status list binds to an instance at create time,
 * so the instance — not the request — decides who signed a list.
 *
 * The record is a superset of `dcc-transaction-service`'s `App.IssuerInstance`
 * `{id, cryptosuite, signingServiceTenant}`, so tenant provisioning stays
 * uniform across services.
 */
export interface IssuerInstance {
  /** Unique within the tenant. */
  id: string
  cryptosuite: Cryptosuite
  didMethod: DidMethod
  /** Required when `didMethod` is `web`. */
  didUrl?: string
  /** Local signing: the key this service signs with in-process. */
  keyMaterial?: KeyMaterial
  /** HTTP signing: the `dcc-signing-service` tenant that holds the key. */
  signingServiceTenant?: string
  /** HTTP signing: the Bearer token that authenticates as that tenant. */
  signingServiceToken?: string
  /** Recorded at provisioning for HTTP signing, where the remote owns the key. */
  issuerDid?: string
}
