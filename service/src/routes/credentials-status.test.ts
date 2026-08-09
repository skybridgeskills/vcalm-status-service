import { verifyCredential } from '@skybridgeskills/vc-signer'
import { beforeEach, describe, expect, test } from 'vitest'
import { MINIMUM_LIST_LENGTH } from '../services/storage.js'
import { readStatus } from '../status-lists/index.js'
import {
  authedPost,
  createTestApp,
  request,
  type TestApp
} from '../test-fixtures/app.js'
import type { VerifiableCredential } from '@skybridgeskills/vc-signer'

let harness: TestApp
let listUrl: string
let listId: string

const slugOf = (url: string) => url.slice(url.lastIndexOf('/') + 1)

const update = (body: unknown, token?: string) =>
  authedPost(harness, '/credentials/status', body, token)

/** The explicit selector: index and list, no allocation record needed. */
const flip = (
  statusListIndex: number,
  status: boolean,
  overrides: Record<string, unknown> = {}
) =>
  update({
    credentialId: 'urn:uuid:cred-1',
    credentialStatus: {
      type: 'BitstringStatusList',
      statusPurpose: 'revocation',
      statusListIndex: String(statusListIndex),
      statusListCredential: listUrl,
      ...overrides
    },
    status
  })

const storedList = async () => {
  const record = await harness.services.storage.getStatusList(listId)
  if (record === undefined) throw new Error('the fixture list vanished')
  return record
}

beforeEach(async () => {
  harness = await createTestApp({ extraTenants: ['globex'] })
  const created = (await (
    await authedPost(harness, '/status-lists', {
      statusPurpose: 'revocation'
    })
  ).json()) as { id: string }
  listUrl = created.id
  listId = slugOf(listUrl)
})

describe('POST /credentials/status', () => {
  test('refuses an unauthenticated update', async () => {
    const response = await request(harness, '/credentials/status', {
      method: 'POST',
      body: JSON.stringify({ credentialId: 'x' })
    })
    expect(response.status).toBe(401)
  })

  test('sets a bit, re-signs, and says which entry moved', async () => {
    const response = await flip(4242, true)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      credentialId: 'urn:uuid:cred-1',
      credentialStatus: {
        type: 'BitstringStatusListEntry',
        statusPurpose: 'revocation',
        statusListIndex: '4242',
        statusListCredential: listUrl
      },
      status: true
    })

    const record = await storedList()
    expect(record.version).toBe(2)
    expect(await readStatus(record.encodedList, 4242)).toBe(true)
  })

  test('the flip is visible on the public GET the moment it returns', async () => {
    await flip(4242, true)

    const response = await request(harness, `/status-lists/${listId}`)
    const credential = (await response.json()) as VerifiableCredential
    const { encodedList } = credential.credentialSubject as {
      encodedList: string
    }

    expect(await readStatus(encodedList, 4242)).toBe(true)
    expect(response.headers.get('ETag')).toBe('"2"')
    expect((await verifyCredential({ credential })).verified).toBe(true)
  })

  test('clears a bit again', async () => {
    await flip(4242, true)
    expect((await flip(4242, false)).status).toBe(200)

    const record = await storedList()
    expect(await readStatus(record.encodedList, 4242)).toBe(false)
    expect(record.version).toBe(3)
  })

  test('a redundant write is an idempotent 200 that re-signs nothing', async () => {
    await flip(4242, true)
    const before = await storedList()

    expect((await flip(4242, true)).status).toBe(200)

    const after = await storedList()
    expect(after.version).toBe(before.version)
    expect(after.signedCredential).toEqual(before.signedCredential)
  })

  describe('resolving by credential id', () => {
    test('flips the index that credential was allocated', async () => {
      const allocation = await harness.services.statusLists.allocateIndex({
        tenantId: 'acme',
        credentialId: 'urn:uuid:allocated',
        statusPurpose: 'revocation',
        listId
      })

      const response = await update({
        credentialId: 'urn:uuid:allocated',
        credentialStatus: {
          type: 'BitstringStatusList',
          statusPurpose: 'revocation'
        },
        status: true
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        credentialStatus: {
          statusListIndex: String(allocation.statusListIndex)
        }
      })
      const record = await storedList()
      expect(
        await readStatus(record.encodedList, allocation.statusListIndex)
      ).toBe(true)
    })

    test('is a 404 for a credential that was never allocated one', async () => {
      const response = await update({
        credentialId: 'urn:uuid:never-issued',
        credentialStatus: {
          type: 'BitstringStatusList',
          statusPurpose: 'revocation'
        },
        status: true
      })
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({
        code: 'credential-not-allocated'
      })
    })

    test('will not reach another tenant allocation', async () => {
      await harness.services.statusLists.allocateIndex({
        tenantId: 'acme',
        credentialId: 'urn:uuid:allocated',
        statusPurpose: 'revocation',
        listId
      })

      const response = await update(
        {
          credentialId: 'urn:uuid:allocated',
          credentialStatus: {
            type: 'BitstringStatusList',
            statusPurpose: 'revocation'
          },
          status: true
        },
        'globex-token'
      )
      expect(response.status).toBe(404)
    })
  })

  describe('refuses what the contract does not allow', () => {
    test('an unknown key', async () => {
      const response = await update({
        credentialId: 'urn:uuid:cred-1',
        credentialStatus: {
          type: 'BitstringStatusList',
          statusPurpose: 'revocation'
        },
        status: true,
        revoked: true
      })
      expect(response.status).toBe(400)
    })

    test("DCC's array-and-verb shape, which predates this schema", async () => {
      const response = await update({
        credentialId: 'urn:uuid:cred-1',
        credentialStatus: [
          { type: 'BitstringStatusListCredential', status: 'revoked' }
        ]
      })
      expect(response.status).toBe(400)
    })

    test('an entry type that is not a bitstring status list entry', async () => {
      const response = await flip(1, true, { type: 'RevocationList2020' })
      expect(response.status).toBe(400)
    })

    test('an index outside the list', async () => {
      const response = await flip(MINIMUM_LIST_LENGTH, true)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        code: 'index-out-of-range'
      })
    })

    test('an index that is not a base-10 integer string', async () => {
      const response = await flip(0, true, { statusListIndex: '4_242' })
      expect(response.status).toBe(400)
    })

    test('half an explicit selector, which names no bit', async () => {
      const response = await update({
        credentialId: 'urn:uuid:cred-1',
        credentialStatus: {
          type: 'BitstringStatusList',
          statusPurpose: 'revocation',
          statusListIndex: '7'
        },
        status: true
      })
      expect(response.status).toBe(400)
    })

    test('a purpose the addressed list does not serve', async () => {
      const response = await flip(7, true, { statusPurpose: 'suspension' })
      expect(response.status).toBe(400)
    })

    test('a status list URL that is not one of ours', async () => {
      const response = await flip(7, true, {
        statusListCredential: 'https://status.example/status-lists/nope'
      })
      expect(response.status).toBe(404)
    })

    test("another tenant's list, as if it were not there", async () => {
      const response = await flip(7, true, {}).then(() =>
        update(
          {
            credentialId: 'urn:uuid:cred-1',
            credentialStatus: {
              type: 'BitstringStatusList',
              statusPurpose: 'revocation',
              statusListIndex: '7',
              statusListCredential: listUrl
            },
            status: true
          },
          'globex-token'
        )
      )
      expect(response.status).toBe(404)
    })
  })
})
