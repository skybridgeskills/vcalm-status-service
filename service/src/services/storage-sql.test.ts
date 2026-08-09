import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { SqlStorage } from './storage-sql.js'
import { testStatusList } from '../test-fixtures/records.js'

/**
 * What the SQL backend adds over the in-memory one, which the shared contract
 * suite in `storage-contract.test.ts` cannot see: the rows outlive the process.
 * That is the whole reason local and ngrok runs use SQLite — a status list URL
 * is issued into credentials that keep resolving it long after a restart.
 */

let directory: string
let file: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'vcalm-status-'))
  // Deliberately a subdirectory that does not exist yet: a container mounts an
  // empty volume, and the file's parent has to be created for it.
  file = join(directory, 'data', 'status-lists.db')
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

const open = async (): Promise<SqlStorage> => {
  const storage = new SqlStorage({ dialect: 'sqlite', file })
  await storage.init()
  return storage
}

describe('SqlStorage on a file', () => {
  test('keeps lists and allocations across a restart', async () => {
    const first = await open()
    const created = await first.createStatusList(testStatusList())
    await first.allocateIndex({
      credentialId: 'urn:uuid:cred-1',
      tenantId: 'acme',
      listId: 'list-1',
      statusPurpose: 'revocation',
      statusListIndex: 4242
    })
    await first.close()

    const second = await open()
    expect(await second.getStatusList('list-1')).toEqual(created)
    expect(
      await second.getAllocation({
        tenantId: 'acme',
        credentialId: 'urn:uuid:cred-1',
        statusPurpose: 'revocation'
      })
    ).toMatchObject({ statusListIndex: 4242 })
    await second.close()
  })

  test('migrating an already-migrated database is a no-op', async () => {
    const first = await open()
    await first.createStatusList(testStatusList())
    await first.close()

    const second = await open()
    expect(await second.getStatusList('list-1')).toBeDefined()
    await second.close()
  })

  test('answers a health probe once open, and not before', async () => {
    const storage = new SqlStorage({ dialect: 'sqlite', file })
    await expect(storage.ping()).rejects.toThrow(/init/)

    await storage.init()
    await expect(storage.ping()).resolves.toBeUndefined()
    await storage.close()
  })

  test('an allocation cannot outlive the list it points at', async () => {
    const storage = await open()
    await expect(
      storage.allocateIndex({
        credentialId: 'urn:uuid:cred-1',
        tenantId: 'acme',
        listId: 'ghost',
        statusPurpose: 'revocation',
        statusListIndex: 1
      })
    ).rejects.toMatchObject({ code: 'list-not-found' })
    await storage.close()
  })
})
