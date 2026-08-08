import pg from 'pg'
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest'
import { MemoryStorage } from './storage-memory.js'
import { SqlStorage } from './storage-sql.js'
import { StorageError } from './storage.js'
import {
  testStatusList,
  testStatusListCredential
} from '../test-fixtures/records.js'
import type { StorageService } from './storage.js'

/**
 * One suite, every implementation. `StorageService` is the seam the rest of the
 * service is built on, so a behavior only one backend has is a bug in the other
 * — the contract is asserted against all of them rather than trusted to stay in
 * step.
 *
 * Postgres joins in when `TEST_DATABASE_URL` names a throwaway database;
 * without one it is reported as skipped rather than quietly dropped.
 */

const POSTGRES_URL = process.env.TEST_DATABASE_URL

let pool: pg.Pool | undefined

/** Postgres keeps its tables between cases; the other two start empty. */
const resetPostgres = async (): Promise<void> => {
  pool ??= new pg.Pool({ connectionString: POSTGRES_URL })
  await pool.query('truncate table index_allocations, status_lists')
}

afterAll(async () => {
  await pool?.end()
})

interface Backend {
  name: string
  create: () => StorageService
  reset?: () => Promise<void>
}

const backends: Backend[] = [
  { name: 'MemoryStorage', create: () => new MemoryStorage() },
  {
    name: 'SqlStorage (sqlite)',
    create: () => new SqlStorage({ dialect: 'sqlite', file: ':memory:' })
  },
  ...(POSTGRES_URL === undefined
    ? []
    : [
        {
          name: 'SqlStorage (postgres)',
          create: () =>
            new SqlStorage({ dialect: 'postgres', url: POSTGRES_URL }),
          reset: resetPostgres
        }
      ])
]

describe.skipIf(POSTGRES_URL !== undefined)('SqlStorage (postgres)', () => {
  test('runs the storage contract when TEST_DATABASE_URL names a database', () => {
    expect(POSTGRES_URL).toBeUndefined()
  })
})

describe.each(backends)('$name', ({ create, reset }) => {
  let storage: StorageService

  beforeEach(async () => {
    storage = create()
    await storage.init()
    await reset?.()
  })

  afterEach(async () => {
    await storage.close()
  })

  describe('status lists', () => {
    test('stores a new list at version 1 and reads it back', async () => {
      const created = await storage.createStatusList(testStatusList())
      expect(created.version).toBe(1)
      expect(await storage.getStatusList('list-1')).toEqual(created)
    })

    test('rejects a duplicate id rather than overwriting a live list', async () => {
      await storage.createStatusList(testStatusList())
      await expect(
        storage.createStatusList(testStatusList())
      ).rejects.toMatchObject({ code: 'duplicate-list' })
    })

    test('returns undefined for an unknown list', async () => {
      expect(await storage.getStatusList('nope')).toBeUndefined()
    })

    test('finds a tenant lists filtered by purpose', async () => {
      await storage.createStatusList(testStatusList({ id: 'rev' }))
      await storage.createStatusList(
        testStatusList({ id: 'sus', statusPurpose: 'suspension' })
      )
      await storage.createStatusList(
        testStatusList({ id: 'other', tenantId: 'globex' })
      )

      const acme = await storage.findStatusLists({ tenantId: 'acme' })
      expect(acme.map((list) => list.id).sort()).toEqual(['rev', 'sus'])

      const suspension = await storage.findStatusLists({
        tenantId: 'acme',
        statusPurpose: 'suspension'
      })
      expect(suspension.map((list) => list.id)).toEqual(['sus'])
    })

    test('does not expose stored state to callers by reference', async () => {
      const created = await storage.createStatusList(testStatusList())
      created.tenantId = 'attacker'
      created.characteristics.length = 1
      const reread = await storage.getStatusList('list-1')
      expect(reread?.tenantId).toBe('acme')
      expect(reread?.characteristics.length).toBe(131072)
    })
  })

  describe('updateStatusList', () => {
    test('writes the materialization and bumps the version', async () => {
      await storage.createStatusList(testStatusList())
      const credential = testStatusListCredential('https://status.example/v2')

      const result = await storage.updateStatusList('list-1', async () => ({
        materialization: { encodedList: 'uNEW', signedCredential: credential },
        result: 'flipped'
      }))

      expect(result).toBe('flipped')
      const stored = await storage.getStatusList('list-1')
      expect(stored?.encodedList).toBe('uNEW')
      expect(stored?.signedCredential).toEqual(credential)
      expect(stored?.version).toBe(2)
    })

    test('a redundant write leaves the stored credential and version alone', async () => {
      const created = await storage.createStatusList(testStatusList())
      const result = await storage.updateStatusList('list-1', async () => ({
        result: 'already-set'
      }))

      expect(result).toBe('already-set')
      const stored = await storage.getStatusList('list-1')
      expect(stored?.version).toBe(1)
      expect(stored?.signedCredential).toEqual(created.signedCredential)
    })

    test('serializes concurrent writers so no flip is lost', async () => {
      await storage.createStatusList(testStatusList())
      const flips = await Promise.all(
        Array.from({ length: 10 }, (_unused, index) =>
          storage.updateStatusList('list-1', async (current) => {
            // Yield mid-transaction: an unserialized implementation would let
            // another writer read this same `current` and clobber the write.
            await new Promise((resolve) => setTimeout(resolve, 1))
            return {
              materialization: {
                encodedList: `u${current.version}`,
                signedCredential: current.signedCredential
              },
              result: index
            }
          })
        )
      )

      expect(flips.sort((a, b) => a - b)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9
      ])
      expect((await storage.getStatusList('list-1'))?.version).toBe(11)
    })

    test('a failed mutation does not wedge the queue for later writers', async () => {
      await storage.createStatusList(testStatusList())
      const failure = storage.updateStatusList('list-1', async () => {
        throw new Error('signing failed')
      })
      await expect(failure).rejects.toThrow('signing failed')

      await expect(
        storage.updateStatusList('list-1', async () => ({ result: 'ok' }))
      ).resolves.toBe('ok')
      expect((await storage.getStatusList('list-1'))?.version).toBe(1)
    })

    test('reports an unknown list as list-not-found', async () => {
      await expect(
        storage.updateStatusList('nope', async () => ({ result: null }))
      ).rejects.toBeInstanceOf(StorageError)
    })
  })

  describe('index allocations', () => {
    const allocation = {
      credentialId: 'urn:uuid:cred-1',
      tenantId: 'acme',
      listId: 'list-1',
      statusPurpose: 'revocation' as const,
      statusListIndex: 4242
    }

    beforeEach(async () => {
      await storage.createStatusList(testStatusList())
    })

    test('records an allocation and resolves it by credential id', async () => {
      const stored = await storage.allocateIndex(allocation)
      expect(stored.allocatedAt).toBeInstanceOf(Date)
      expect(
        await storage.getAllocation({
          tenantId: 'acme',
          credentialId: 'urn:uuid:cred-1',
          statusPurpose: 'revocation'
        })
      ).toMatchObject({ statusListIndex: 4242, listId: 'list-1' })
    })

    test('refuses to hand the same index to two credentials', async () => {
      await storage.allocateIndex(allocation)
      await expect(
        storage.allocateIndex({
          ...allocation,
          credentialId: 'urn:uuid:cred-2'
        })
      ).rejects.toMatchObject({ code: 'index-taken' })
    })

    test('refuses a second index for the same credential and purpose', async () => {
      await storage.allocateIndex(allocation)
      await expect(
        storage.allocateIndex({ ...allocation, statusListIndex: 7 })
      ).rejects.toMatchObject({ code: 'credential-already-allocated' })
    })

    test('allows the same credential an index per purpose', async () => {
      await storage.createStatusList(
        testStatusList({ id: 'list-sus', statusPurpose: 'suspension' })
      )
      await storage.allocateIndex(allocation)
      await expect(
        storage.allocateIndex({
          ...allocation,
          listId: 'list-sus',
          statusPurpose: 'suspension',
          statusListIndex: 99
        })
      ).resolves.toMatchObject({ statusPurpose: 'suspension' })
    })

    test('allocating against an unknown list fails', async () => {
      await expect(
        storage.allocateIndex({ ...allocation, listId: 'nope' })
      ).rejects.toMatchObject({ code: 'list-not-found' })
    })

    test('supports pick-random-and-retry via isIndexAllocated', async () => {
      expect(await storage.isIndexAllocated('list-1', 4242)).toBe(false)
      await storage.allocateIndex(allocation)
      expect(await storage.isIndexAllocated('list-1', 4242)).toBe(true)
      expect(await storage.isIndexAllocated('list-1', 4243)).toBe(false)
      expect(await storage.countAllocations('list-1')).toBe(1)
    })
  })
})
