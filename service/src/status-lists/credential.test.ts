import { describe, expect, test } from 'vitest'
import { createBitstring } from './bitstring.js'
import { buildStatusListCredential, statusListUrl } from './credential.js'
import { MINIMUM_LIST_LENGTH } from '../services/storage.js'

const URL_UNDER_TEST = 'https://status.example/status-lists/list-1'
const ISSUER = 'did:example:issuer'

const build = async (ttl?: number) =>
  buildStatusListCredential({
    url: URL_UNDER_TEST,
    issuer: ISSUER,
    statusPurpose: 'revocation',
    list: await createBitstring(MINIMUM_LIST_LENGTH),
    validFrom: new Date('2026-08-08T01:02:03.456Z'),
    ...(ttl === undefined ? {} : { ttl })
  })

describe('statusListUrl', () => {
  test('is the base plus the flat status-lists path', () => {
    expect(statusListUrl('https://status.example', 'abc123')).toBe(
      'https://status.example/status-lists/abc123'
    )
  })

  test('escapes an id that would otherwise change the path', () => {
    expect(statusListUrl('https://status.example', 'a/../b')).toBe(
      'https://status.example/status-lists/a%2F..%2Fb'
    )
  })
})

describe('buildStatusListCredential', () => {
  test('is a BitstringStatusListCredential per BSL §2.2', async () => {
    const { unsigned, encodedList } = await build()

    expect(unsigned['@context']).toEqual([
      'https://www.w3.org/ns/credentials/v2'
    ])
    expect(unsigned.id).toBe(URL_UNDER_TEST)
    expect(unsigned.type).toEqual([
      'VerifiableCredential',
      'BitstringStatusListCredential'
    ])
    expect(unsigned.issuer).toBe(ISSUER)
    expect(unsigned.credentialSubject).toEqual({
      id: `${URL_UNDER_TEST}#list`,
      type: 'BitstringStatusList',
      statusPurpose: 'revocation',
      encodedList
    })
  })

  test('carries validFrom at second precision, as the proof does', async () => {
    const { unsigned } = await build()
    expect(unsigned.validFrom).toBe('2026-08-08T01:02:03Z')
  })

  test('omits ttl unless the list opted into one', async () => {
    const withoutTtl = await build()
    expect(withoutTtl.unsigned.credentialSubject).not.toHaveProperty('ttl')

    const withTtl = await build(300_000)
    expect(withTtl.unsigned.credentialSubject).toMatchObject({ ttl: 300_000 })
  })

  test('returns the same encoding the credential publishes', async () => {
    const { unsigned, encodedList } = await build()
    const subject = unsigned.credentialSubject as { encodedList: string }
    expect(subject.encodedList).toBe(encodedList)
  })
})
