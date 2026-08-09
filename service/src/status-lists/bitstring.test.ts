import { describe, expect, test } from 'vitest'
import { createBitstring, decodeBitstring, readStatus } from './bitstring.js'
import { EMPTY_ENCODED_LIST } from '../test-fixtures/records.js'
import { MINIMUM_LIST_LENGTH } from '../services/storage.js'

describe('bitstring encoding', () => {
  test('a fresh list of the minimum size is the all-zero list from the spec', async () => {
    const list = await createBitstring(MINIMUM_LIST_LENGTH)
    // Byte-identical to the BSL §2.2 example: the encoding is `u` +
    // base64url(GZIP(bits)), and this is what a conformant verifier expects.
    expect(await list.encode()).toBe(EMPTY_ENCODED_LIST)
  })

  test('a set bit survives the encode/decode round trip, alone', async () => {
    const list = await createBitstring(MINIMUM_LIST_LENGTH)
    list.setStatus(94_321, true)
    const encoded = await list.encode()

    const decoded = await decodeBitstring(encoded)
    expect(decoded.getStatus(94_321)).toBe(true)
    expect(decoded.getStatus(94_320)).toBe(false)
    expect(decoded.length).toBe(MINIMUM_LIST_LENGTH)
  })

  test('readStatus reads one bit without the caller decoding', async () => {
    const list = await createBitstring(MINIMUM_LIST_LENGTH)
    list.setStatus(7, true)
    const encoded = await list.encode()

    expect(await readStatus(encoded, 7)).toBe(true)
    expect(await readStatus(encoded, 8)).toBe(false)
  })
})
