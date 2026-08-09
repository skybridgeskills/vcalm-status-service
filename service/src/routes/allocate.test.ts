import { beforeEach, describe, expect, test } from 'vitest'
import { readStatus } from '../status-lists/index.js'
import {
  TEST_BASE_URL,
  authedPost,
  createTestApp,
  request,
  type TestApp
} from '../test-fixtures/app.js'

let harness: TestApp

const credential = (id: string, extra: Record<string, unknown> = {}) => ({
  '@context': ['https://www.w3.org/ns/credentials/v2'],
  id,
  type: ['VerifiableCredential', 'OpenBadgeCredential'],
  issuer: 'did:example:issuer',
  credentialSubject: { id: 'did:example:learner' },
  ...extra
})

interface Entry {
  id: string
  type: string
  statusPurpose: string
  statusListIndex: string
  statusListCredential: string
}

const allocate = (body: unknown, token?: string) =>
  authedPost(harness, '/credentials/status/allocate', body, token)

const allocated = async (body: unknown) => {
  const response = await allocate(body)
  expect(response.status).toBe(200)
  return (await response.json()) as Record<string, unknown> & {
    credentialStatus: Entry | Entry[]
  }
}

beforeEach(async () => {
  harness = await createTestApp({ extraTenants: ['globex'] })
})

describe('POST /credentials/status/allocate', () => {
  test('refuses an unauthenticated allocate', async () => {
    const response = await request(harness, '/credentials/status/allocate', {
      method: 'POST',
      body: JSON.stringify(credential('urn:uuid:1'))
    })
    expect(response.status).toBe(401)
  })

  test('takes a bare credential and gives it back with an entry', async () => {
    const result = await allocated(credential('urn:uuid:1'))
    const entry = result.credentialStatus as Entry

    expect(entry.type).toBe('BitstringStatusListEntry')
    expect(entry.statusPurpose).toBe('revocation')
    expect(entry.statusListCredential).toMatch(
      new RegExp(`^${TEST_BASE_URL}/status-lists/`)
    )
    // BSL wants a base-10 string, and the entry id must differ from the list.
    expect(entry.statusListIndex).toMatch(/^\d+$/)
    expect(entry.id).toBe(
      `${entry.statusListCredential}#${entry.statusListIndex}`
    )

    // Credential in, credential out: nothing else was touched.
    expect(result.id).toBe('urn:uuid:1')
    expect(result['@context']).toEqual(['https://www.w3.org/ns/credentials/v2'])
    expect(result.issuer).toBe('did:example:issuer')
  })

  test('creates the tenant first list rather than demanding one exists', async () => {
    expect(
      await harness.services.storage.findStatusLists({ tenantId: 'acme' })
    ).toHaveLength(0)

    await allocated(credential('urn:uuid:1'))

    const lists = await harness.services.storage.findStatusLists({
      tenantId: 'acme'
    })
    expect(lists).toHaveLength(1)
    expect(lists[0]?.statusPurpose).toBe('revocation')
  })

  test('keeps using that list while it has room', async () => {
    const first = (await allocated(credential('urn:uuid:1')))
      .credentialStatus as Entry
    const second = (await allocated(credential('urn:uuid:2')))
      .credentialStatus as Entry

    expect(second.statusListCredential).toBe(first.statusListCredential)
    expect(second.statusListIndex).not.toBe(first.statusListIndex)
    expect(
      await harness.services.storage.findStatusLists({ tenantId: 'acme' })
    ).toHaveLength(1)
  })

  test('rolls onto a new list once one passes the fill threshold', async () => {
    // The threshold is a fraction of 131,072; filling half of that in a test
    // would be absurd, so the manager takes the fraction as a seam.
    const rolling = await createTestApp({ rollAtFill: 2 / 131072 })
    const entries: Entry[] = []
    for (const n of [1, 2, 3]) {
      const response = await authedPost(
        rolling,
        '/credentials/status/allocate',
        credential(`urn:uuid:${n}`)
      )
      entries.push(
        ((await response.json()) as { credentialStatus: Entry })
          .credentialStatus
      )
    }

    expect(entries[1]?.statusListCredential).toBe(
      entries[0]?.statusListCredential
    )
    expect(entries[2]?.statusListCredential).not.toBe(
      entries[0]?.statusListCredential
    )
    expect(
      await rolling.services.storage.findStatusLists({ tenantId: 'acme' })
    ).toHaveLength(2)
  })

  describe('the wrapped form', () => {
    test('selects a purpose, on its own list', async () => {
      const revocation = (await allocated(credential('urn:uuid:1')))
        .credentialStatus as Entry
      const suspension = (
        await allocated({
          credential: credential('urn:uuid:1'),
          options: { statusPurpose: 'suspension' }
        })
      ).credentialStatus as Entry

      expect(suspension.statusPurpose).toBe('suspension')
      expect(suspension.statusListCredential).not.toBe(
        revocation.statusListCredential
      )
    })

    test('selects a specific list', async () => {
      const created = (await (
        await authedPost(harness, '/status-lists', {
          statusPurpose: 'revocation'
        })
      ).json()) as { id: string }
      const listId = created.id.slice(created.id.lastIndexOf('/') + 1)

      const entry = (
        await allocated({
          credential: credential('urn:uuid:1'),
          options: { statusListId: listId }
        })
      ).credentialStatus as Entry
      expect(entry.statusListCredential).toBe(created.id)
    })

    test('refuses an unknown option', async () => {
      const response = await allocate({
        credential: credential('urn:uuid:1'),
        options: { statusPurpse: 'revocation' }
      })
      expect(response.status).toBe(400)
    })
  })

  describe('refuses what it cannot allocate', () => {
    test('a credential with no id to name later', async () => {
      const { id: _unused, ...withoutId } = credential('urn:uuid:1')
      const response = await allocate(withoutId)
      expect(response.status).toBe(400)
    })

    test('an empty body', async () => {
      expect((await allocate({})).status).toBe(400)
    })

    test('the same credential and purpose twice', async () => {
      await allocated(credential('urn:uuid:1'))
      const response = await allocate(credential('urn:uuid:1'))
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({
        code: 'credential-already-allocated'
      })
    })

    test('another tenant list', async () => {
      const created = (await (
        await authedPost(harness, '/status-lists', {
          statusPurpose: 'revocation'
        })
      ).json()) as { id: string }
      const listId = created.id.slice(created.id.lastIndexOf('/') + 1)

      const response = await allocate(
        {
          credential: credential('urn:uuid:1'),
          options: { statusListId: listId }
        },
        'globex-token'
      )
      expect(response.status).toBe(404)
    })

    test('a list that serves a different purpose', async () => {
      const created = (await (
        await authedPost(harness, '/status-lists', {
          statusPurpose: 'suspension'
        })
      ).json()) as { id: string }
      const listId = created.id.slice(created.id.lastIndexOf('/') + 1)

      const response = await allocate({
        credential: credential('urn:uuid:1'),
        options: { statusListId: listId }
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        code: 'list-purpose-mismatch'
      })
    })
  })

  test('keeps an entry the credential already carried', async () => {
    const existing = {
      id: 'https://elsewhere.test/lists/1#7',
      type: 'BitstringStatusListEntry',
      statusPurpose: 'suspension',
      statusListIndex: '7',
      statusListCredential: 'https://elsewhere.test/lists/1'
    }
    const result = await allocated(
      credential('urn:uuid:1', { credentialStatus: existing })
    )

    const entries = result.credentialStatus as Entry[]
    expect(Array.isArray(entries)).toBe(true)
    expect(entries[0]).toEqual(existing)
    expect(entries[1]?.statusPurpose).toBe('revocation')
  })

  test('the allocated entry is the one a later revocation flips', async () => {
    const entry = (await allocated(credential('urn:uuid:1')))
      .credentialStatus as Entry

    // The VCALM update names the credential, not the index — which is what
    // makes a dynamic index safe to bake into a fixture.
    const update = await authedPost(harness, '/credentials/status', {
      credentialId: 'urn:uuid:1',
      credentialStatus: {
        type: 'BitstringStatusList',
        statusPurpose: 'revocation'
      },
      status: true
    })
    expect(update.status).toBe(200)

    const listId = entry.statusListCredential.slice(
      entry.statusListCredential.lastIndexOf('/') + 1
    )
    const served = await request(harness, `/status-lists/${listId}`)
    const { credentialSubject } = (await served.json()) as {
      credentialSubject: { encodedList: string }
    }
    expect(
      await readStatus(
        credentialSubject.encodedList,
        Number(entry.statusListIndex)
      )
    ).toBe(true)
  })
})
