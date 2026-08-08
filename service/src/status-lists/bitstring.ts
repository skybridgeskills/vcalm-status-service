import {
  BitstringStatusList,
  createList,
  decodeList
} from '@interop/vc-bitstring-status-list'

/**
 * The bit-level half of a status list, kept behind a small surface so the
 * encoding stays exactly what BSL §2.2 says it is — `u` + base64url of the
 * GZIP-compressed bitstring — and stays that way if the library underneath is
 * ever swapped for its Digital Bazaar upstream.
 */

export type { BitstringStatusList }

/** An all-zero list: nothing is revoked or suspended until something says so. */
export const createBitstring = (length: number): Promise<BitstringStatusList> =>
  createList({ length })

export const decodeBitstring = (
  encodedList: string
): Promise<BitstringStatusList> => decodeList({ encodedList })

export const readStatus = async (
  encodedList: string,
  statusListIndex: number
): Promise<boolean> =>
  (await decodeBitstring(encodedList)).getStatus(statusListIndex)
