import {
  generateKeyMaterial,
  verifyCredential
} from '@skybridgeskills/vc-signer'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from 'vitest'
import { decodeBitstring, readStatus } from './bitstring.js'
import { StatusListError } from './errors.js'
import { StatusListManager } from './manager.js'
import { LocalSigningService } from '../services/signing-local.js'
import { MemoryStorage } from '../services/storage-memory.js'
import { SqlStorage } from '../services/storage-sql.js'
import { MINIMUM_LIST_LENGTH } from '../services/storage.js'
import { MemoryTenantRegistry } from '../services/tenants-memory.js'
import { EMPTY_ENCODED_LIST, testTenant } from '../test-fixtures/records.js'
import type { KeyMaterial } from '@skybridgeskills/vc-signer'
import type { StorageService } from '../services/storage.js'

/**
 * The sign-on-update path, end to end and for real: `LocalSigningService` with
 * generated key material, so every assertion about a stored credential is an
 * assertion a verifier would agree with. Run against both storage backends,
 * because the invariant under test — bits and signature change together, in one
 * transaction — is exactly where they could differ.
 */

const PUBLIC_BASE_URL = 'https://status.example'
const TENANT_ID = 'acme'

let keyMaterial: KeyMaterial

beforeAll(async () => {
  keyMaterial = await generateKeyMaterial('eddsa-rdfc-2022')
})

const backends: { name: string; create: () => StorageService }[] = [
  { name: 'MemoryStorage', create: () => new MemoryStorage() },
  {
    name: 'SqlStorage (sqlite)',
    create: () => new SqlStorage({ dialect: 'sqlite', file: ':memory:' })
  }
]

describe.each(backends)('StatusListManager over $name', ({ create }) => {
  let storage: StorageService
  let signing: LocalSigningService
  let tenants: MemoryTenantRegistry
  let manager: StatusListManager

  const tenant = () =>
    testTenant({
      tenantId: TENANT_ID,
      issuerInstances: [
        {
          id: 'default',
          cryptosuite: 'eddsa-rdfc-2022',
          didMethod: 'key',
          keyMaterial
        }
      ]
    })

  const instance = () => tenant().issuerInstances[0]!

  const createList = (
    overrides: Partial<Parameters<StatusListManager['createList']>[0]> = {}
  ) =>
    manager.createList({
      tenantId: TENANT_ID,
      instance: instance(),
      statusPurpose: 'revocation',
      id: 'list-1',
      ...overrides
    })

  beforeEach(async () => {
    storage = create()
    await storage.init()
    signing = new LocalSigningService()
    tenants = new MemoryTenantRegistry([tenant()])
    manager = new StatusListManager({
      storage,
      signing,
      tenants,
      publicBaseUrl: PUBLIC_BASE_URL
    })
  })

  afterEach(async () => {
    await storage.close()
  })

  describe('createList', () => {
    test('stores an all-zero list whose credential verifies', async () => {
      const record = await createList()

      expect(record.version).toBe(1)
      expect(record.encodedList).toBe(EMPTY_ENCODED_LIST)
      expect(record.characteristics).toEqual({
        length: MINIMUM_LIST_LENGTH,
        statusSize: 1
      })
      expect(record.signedCredential.id).toBe(
        `${PUBLIC_BASE_URL}/status-lists/list-1`
      )
      expect(record.signedCredential.issuer).toBe(
        await signing.issuerDid(instance())
      )

      const result = await verifyCredential({
        credential: record.signedCredential
      })
      expect(result.error).toBeUndefined()
      expect(result.verified).toBe(true)
    })

    test('generates an opaque id when the caller supplies none', async () => {
      const record = await manager.createList({
        tenantId: TENANT_ID,
        instance: instance(),
        statusPurpose: 'suspension'
      })
      expect(record.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(record.signedCredential.id).toBe(
        `${PUBLIC_BASE_URL}/status-lists/${record.id}`
      )
    })

    test('honors a canonical URL the caller owns', async () => {
      const url = 'https://lit-exchanges.ngrok.io/status-lists/ccp-d1'
      const record = await createList({ id: 'ccp-d1', url })
      expect(record.signedCredential.id).toBe(url)
    })

    test('refuses a list below the herd-privacy floor', async () => {
      await expect(
        createList({ characteristics: { length: 100_000 } })
      ).rejects.toMatchObject({ code: 'list-too-short' })
    })

    test('refuses multi-bit entries, which v1 cannot publish', async () => {
      await expect(
        createList({ characteristics: { statusSize: 2 } })
      ).rejects.toMatchObject({ code: 'unsupported-characteristics' })
      await expect(
        createList({
          characteristics: {
            statusMessage: [{ status: '0x0', message: 'unset' }]
          }
        })
      ).rejects.toMatchObject({ code: 'unsupported-characteristics' })
    })

    test('copies an opted-in ttl onto the signed credential', async () => {
      const record = await createList({ characteristics: { ttl: 300_000 } })
      expect(record.characteristics.ttl).toBe(300_000)
      expect(record.signedCredential.credentialSubject).toMatchObject({
        ttl: 300_000
      })
      expect(
        (await verifyCredential({ credential: record.signedCredential }))
          .verified
      ).toBe(true)
    })
  })

  describe('setStatus', () => {
    beforeEach(async () => {
      await createList()
    })

    test('flips a bit and re-signs, in one version bump', async () => {
      const change = await manager.setStatus({
        listId: 'list-1',
        statusListIndex: 4242,
        status: true
      })

      expect(change.changed).toBe(true)
      expect(change.record.version).toBe(2)

      const stored = await storage.getStatusList('list-1')
      expect(stored?.version).toBe(2)
      expect(await readStatus(stored!.encodedList, 4242)).toBe(true)
      expect(await readStatus(stored!.encodedList, 4241)).toBe(false)

      // The served bytes carry the flip and still verify — this is the whole
      // point of signing on update rather than on GET.
      const credential = stored!.signedCredential
      const subject = credential.credentialSubject as { encodedList: string }
      expect(subject.encodedList).toBe(stored?.encodedList)
      expect((await verifyCredential({ credential })).verified).toBe(true)
    })

    test('a redundant write changes nothing and re-signs nothing', async () => {
      const created = await storage.getStatusList('list-1')
      const change = await manager.setStatus({
        listId: 'list-1',
        statusListIndex: 4242,
        status: false
      })

      expect(change.changed).toBe(false)
      const stored = await storage.getStatusList('list-1')
      expect(stored?.version).toBe(1)
      expect(stored?.signedCredential).toEqual(created?.signedCredential)
    })

    test('unsets a bit again, bumping the version once more', async () => {
      await manager.setStatus({
        listId: 'list-1',
        statusListIndex: 9,
        status: true
      })
      const change = await manager.setStatus({
        listId: 'list-1',
        statusListIndex: 9,
        status: false
      })

      expect(change.changed).toBe(true)
      expect(change.record.version).toBe(3)
      const stored = await storage.getStatusList('list-1')
      expect(stored?.encodedList).toBe(EMPTY_ENCODED_LIST)
      expect(
        (await verifyCredential({ credential: stored!.signedCredential }))
          .verified
      ).toBe(true)
    })

    test('refuses an index outside the list', async () => {
      for (const statusListIndex of [-1, MINIMUM_LIST_LENGTH, 1.5]) {
        await expect(
          manager.setStatus({ listId: 'list-1', statusListIndex, status: true })
        ).rejects.toMatchObject({ code: 'index-out-of-range' })
      }
    })

    test('refuses an unknown list', async () => {
      await expect(
        manager.setStatus({ listId: 'nope', statusListIndex: 1, status: true })
      ).rejects.toMatchObject({ code: 'list-not-found' })
    })

    test('reports a list whose issuer instance left the registry', async () => {
      const orphaned = new StatusListManager({
        storage,
        signing,
        tenants: new MemoryTenantRegistry(),
        publicBaseUrl: PUBLIC_BASE_URL
      })
      await expect(
        orphaned.setStatus({
          listId: 'list-1',
          statusListIndex: 1,
          status: true
        })
      ).rejects.toMatchObject({ code: 'issuer-instance-unavailable' })
    })

    test('concurrent flips of different bits all survive', async () => {
      const indexes = [11, 2_222, 33_333, 44, 5_555, 66_666, 777, 8, 99_999, 10]
      await Promise.all(
        indexes.map((statusListIndex) =>
          manager.setStatus({
            listId: 'list-1',
            statusListIndex,
            status: true
          })
        )
      )

      const stored = await storage.getStatusList('list-1')
      expect(stored?.version).toBe(1 + indexes.length)
      const bits = await decodeBitstring(stored!.encodedList)
      for (const index of indexes) {
        expect(bits.getStatus(index)).toBe(true)
      }
      expect(
        (await verifyCredential({ credential: stored!.signedCredential }))
          .verified
      ).toBe(true)
    })
  })

  describe('allocation', () => {
    beforeEach(async () => {
      await createList()
    })

    const allocate = (credentialId: string) =>
      manager.allocateIndex({
        tenantId: TENANT_ID,
        credentialId,
        statusPurpose: 'revocation',
        listId: 'list-1'
      })

    test('hands out distinct in-range indexes', async () => {
      const allocations = await Promise.all(
        Array.from({ length: 20 }, (_unused, n) => allocate(`urn:uuid:${n}`))
      )
      const indexes = allocations.map(
        (allocation) => allocation.statusListIndex
      )

      expect(new Set(indexes).size).toBe(indexes.length)
      for (const index of indexes) {
        expect(index).toBeGreaterThanOrEqual(0)
        expect(index).toBeLessThan(MINIMUM_LIST_LENGTH)
      }
      expect(await storage.countAllocations('list-1')).toBe(20)
    })

    test('does not hand out indexes in issuance order', async () => {
      const indexes: number[] = []
      for (let n = 0; n < 12; n += 1) {
        indexes.push((await allocate(`urn:uuid:seq-${n}`)).statusListIndex)
      }
      // Sequential allocation would publish issuance order; random allocation
      // sorted-equals itself only by astronomical coincidence.
      expect(indexes).not.toEqual([...indexes].sort((a, b) => a - b))
    })

    test('retries past an index another allocator already took', async () => {
      const taken = 512
      let probe = 0
      const colliding = new StatusListManager({
        storage,
        signing,
        tenants,
        publicBaseUrl: PUBLIC_BASE_URL,
        // First two probes land on the same index; only one can win.
        randomIndex: () => (probe++ < 2 ? taken : 4096)
      })

      const first = await colliding.allocateIndex({
        tenantId: TENANT_ID,
        credentialId: 'urn:uuid:first',
        statusPurpose: 'revocation',
        listId: 'list-1'
      })
      const second = await colliding.allocateIndex({
        tenantId: TENANT_ID,
        credentialId: 'urn:uuid:second',
        statusPurpose: 'revocation',
        listId: 'list-1'
      })

      expect(first.statusListIndex).toBe(taken)
      expect(second.statusListIndex).toBe(4096)
    })

    test('gives up rather than spinning when nothing is free', async () => {
      const wedged = new StatusListManager({
        storage,
        signing,
        tenants,
        publicBaseUrl: PUBLIC_BASE_URL,
        randomIndex: () => 1
      })
      await wedged.allocateIndex({
        tenantId: TENANT_ID,
        credentialId: 'urn:uuid:one',
        statusPurpose: 'revocation',
        listId: 'list-1'
      })

      await expect(
        wedged.allocateIndex({
          tenantId: TENANT_ID,
          credentialId: 'urn:uuid:two',
          statusPurpose: 'revocation',
          listId: 'list-1'
        })
      ).rejects.toMatchObject({ code: 'list-exhausted' })
    })

    test('will not allocate into another tenant list', async () => {
      await expect(
        manager.allocateIndex({
          tenantId: 'globex',
          credentialId: 'urn:uuid:x',
          statusPurpose: 'revocation',
          listId: 'list-1'
        })
      ).rejects.toMatchObject({ code: 'list-not-found' })
    })
  })

  describe('setCredentialStatus', () => {
    beforeEach(async () => {
      await createList()
    })

    test('resolves the credential own index and flips it', async () => {
      const allocation = await manager.allocateIndex({
        tenantId: TENANT_ID,
        credentialId: 'urn:uuid:cred-1',
        statusPurpose: 'revocation',
        listId: 'list-1'
      })

      const change = await manager.setCredentialStatus({
        tenantId: TENANT_ID,
        credentialId: 'urn:uuid:cred-1',
        statusPurpose: 'revocation',
        status: true
      })

      expect(change.changed).toBe(true)
      const stored = await storage.getStatusList('list-1')
      expect(
        await readStatus(stored!.encodedList, allocation.statusListIndex)
      ).toBe(true)
    })

    test('refuses a credential with no entry, rather than inventing one', async () => {
      await expect(
        manager.setCredentialStatus({
          tenantId: TENANT_ID,
          credentialId: 'urn:uuid:never-issued',
          statusPurpose: 'revocation',
          status: true
        })
      ).rejects.toBeInstanceOf(StatusListError)
    })

    test('will not reach another tenant allocation', async () => {
      await manager.allocateIndex({
        tenantId: TENANT_ID,
        credentialId: 'urn:uuid:cred-1',
        statusPurpose: 'revocation',
        listId: 'list-1'
      })

      await expect(
        manager.setCredentialStatus({
          tenantId: 'globex',
          credentialId: 'urn:uuid:cred-1',
          statusPurpose: 'revocation',
          status: true
        })
      ).rejects.toMatchObject({ code: 'credential-not-allocated' })
    })
  })
})
