import { createCredential } from '@interop/vc-bitstring-status-list'
import type { UnsignedCredential } from '@skybridgeskills/vc-signer'
import type { StatusPurpose } from '../services/storage.js'
import type { BitstringStatusList } from './bitstring.js'

/**
 * The canonical URL of a list: `{publicBaseUrl}/status-lists/{id}`. It is the
 * credential's `id`, the `Location` of the create response, and the
 * `statusListCredential` of every entry pointing at it — written once at create
 * and never rewritten, because issued credentials carry it forever.
 */
export const statusListUrl = (publicBaseUrl: string, id: string): string =>
  `${publicBaseUrl}/status-lists/${encodeURIComponent(id)}`

export interface StatusListCredentialInput {
  /** The list's canonical URL. */
  url: string
  /** DID of the issuer instance the list is bound to. */
  issuer: string
  statusPurpose: StatusPurpose
  list: BitstringStatusList
  /** Milliseconds; BSL §2.2, mirrored by the GET's `Cache-Control`. */
  ttl?: number
  validFrom: Date
}

/** An unsigned list credential and the encoding that produced it. */
export interface StatusListMaterial {
  encodedList: string
  unsigned: UnsignedCredential
}

/** XSD dateTime, seconds precision — the form the proof's `created` takes. */
const asDateTime = (date: Date): string =>
  date.toISOString().replace(/\.\d{3}Z$/, 'Z')

/**
 * Builds the BitstringStatusListCredential that publishes a list's current
 * bits. The encoding comes back alongside it because storage and the served
 * credential must agree on the bytes by construction, not by a second encode.
 */
export const buildStatusListCredential = async (
  input: StatusListCredentialInput
): Promise<StatusListMaterial> => {
  const base = await createCredential({
    id: input.url,
    list: input.list,
    statusPurpose: input.statusPurpose
  })

  return {
    encodedList: base.credentialSubject.encodedList,
    unsigned: {
      '@context': base['@context'],
      id: base.id,
      type: base.type,
      issuer: input.issuer,
      validFrom: asDateTime(input.validFrom),
      credentialSubject: {
        ...base.credentialSubject,
        ...(input.ttl === undefined ? {} : { ttl: input.ttl })
      }
    }
  }
}
