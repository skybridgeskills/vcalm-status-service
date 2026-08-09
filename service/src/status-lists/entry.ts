import type { StatusPurpose } from '../services/storage.js'

/**
 * The `credentialStatus` object an issued credential carries, per BSL §2.1.
 *
 * The service builds it and callers never assemble their own: the index is the
 * service's to allocate and the URL is the service's to know, so a caller
 * stitching one together from a create response is a caller that can get it
 * wrong forever — the entry is baked into a signed credential.
 */
export interface BitstringStatusListEntry {
  /** Must differ from `statusListCredential`, so it carries the index. */
  id: string
  type: 'BitstringStatusListEntry'
  statusPurpose: StatusPurpose
  /** BSL requires a base-10 string, not a number. */
  statusListIndex: string
  statusListCredential: string
}

export const bitstringStatusListEntry = (input: {
  statusListCredential: string
  statusListIndex: number
  statusPurpose: StatusPurpose
}): BitstringStatusListEntry => ({
  id: `${input.statusListCredential}#${input.statusListIndex}`,
  type: 'BitstringStatusListEntry',
  statusPurpose: input.statusPurpose,
  statusListIndex: String(input.statusListIndex),
  statusListCredential: input.statusListCredential
})
