import { randomInt, randomUUID } from 'node:crypto'
import { createBitstring, decodeBitstring } from './bitstring.js'
import { buildStatusListCredential, statusListUrl } from './credential.js'
import { StatusListError } from './errors.js'
import {
  MINIMUM_LIST_LENGTH,
  StorageError,
  type IndexAllocation,
  type StatusListCharacteristics,
  type StatusListRecord,
  type StatusMessage,
  type StatusPurpose,
  type StorageService
} from '../services/storage.js'
import {
  resolveIssuerInstance,
  type TenantRegistry
} from '../services/tenants.js'
import type { IssuerInstance } from '../services/issuer-instance.js'
import type { SigningService } from '../services/signing.js'

/**
 * The status-list domain, sitting between the routes and the two services that
 * do the work. Every state change here is *sign-on-update*: the bits and the
 * signed credential that publishes them are produced together and written in
 * one transaction, so the public GET is a pure read of stored bytes and a
 * bit-flip is visible the instant the call that made it returns.
 */

export interface StatusListManagerDeps {
  storage: StorageService
  signing: SigningService
  tenants: TenantRegistry
  publicBaseUrl: string
  /** Test seams; both default to the obvious production behavior. */
  now?: () => Date
  randomIndex?: (length: number) => number
  generateId?: () => string
}

export interface CreateStatusListInput {
  tenantId: string
  instance: IssuerInstance
  statusPurpose: StatusPurpose
  /** Opaque slug; generated when the caller supplies none. */
  id?: string
  /**
   * Canonical URL, when the caller supplied a full-URL `id` under one of its
   * tenant's authorized bases. Defaults to this service's own base.
   */
  url?: string
  characteristics?: {
    length?: number
    statusSize?: number
    statusMessage?: StatusMessage[]
    ttl?: number
  }
}

export interface StatusChange {
  /** `false` when the bit already held that value — nothing was re-signed. */
  changed: boolean
  /** The list as it now stands, at its new version when something changed. */
  record: StatusListRecord
}

/**
 * Random probes before giving up. Probing costs `1 / (1 - fill)` attempts on
 * average, so this cap only engages on a list that is nearly full: it starts
 * failing around 90% (~118,000 entries of the 131,072 minimum).
 *
 * That is a backstop, not a budget. Lists are meant to be rolled at **45–55%
 * fill**, where allocation costs two probes and this constant is unreachable —
 * creating a list is one signature and one insert, so there is nothing to gain
 * by packing one. See the storage ADR; `countAllocations` is what a caller
 * watches to decide.
 */
const ALLOCATION_ATTEMPTS = 64

export class StatusListManager {
  readonly #storage: StorageService
  readonly #signing: SigningService
  readonly #tenants: TenantRegistry
  readonly #publicBaseUrl: string
  readonly #now: () => Date
  readonly #randomIndex: (length: number) => number
  readonly #generateId: () => string

  constructor(deps: StatusListManagerDeps) {
    this.#storage = deps.storage
    this.#signing = deps.signing
    this.#tenants = deps.tenants
    this.#publicBaseUrl = deps.publicBaseUrl
    this.#now = deps.now ?? (() => new Date())
    this.#randomIndex = deps.randomIndex ?? ((length) => randomInt(length))
    this.#generateId = deps.generateId ?? (() => randomUUID())
  }

  /** Creates an all-zero list, signs it, and stores both. */
  async createList(input: CreateStatusListInput): Promise<StatusListRecord> {
    const characteristics = this.#characteristics(input.characteristics)
    const id = input.id ?? this.#generateId()
    const url = input.url ?? statusListUrl(this.#publicBaseUrl, id)

    const list = await createBitstring(characteristics.length)
    const { encodedList, signedCredential } = await this.#materialize({
      url,
      instance: input.instance,
      statusPurpose: input.statusPurpose,
      list,
      ttl: characteristics.ttl
    })

    return await this.#storage.createStatusList({
      id,
      tenantId: input.tenantId,
      issuerInstanceId: input.instance.id,
      statusPurpose: input.statusPurpose,
      characteristics,
      encodedList,
      signedCredential
    })
  }

  /**
   * Sets one bit by index — the explicit-selector path, and what every other
   * update ends up calling.
   */
  async setStatus(input: {
    listId: string
    statusListIndex: number
    status: boolean
  }): Promise<StatusChange> {
    const list = await this.#storage.getStatusList(input.listId)
    if (list === undefined) {
      throw new StatusListError(
        'list-not-found',
        `Status list "${input.listId}" not found`
      )
    }
    // Resolved before the write opens: the instance binding is immutable, and
    // a registry lookup may one day be an HTTP call that has no business
    // holding a row lock.
    const instance = await this.#instanceFor(list)

    return await this.#storage.updateStatusList(input.listId, async (current) =>
      this.#applyStatus(current, instance, input.statusListIndex, input.status)
    )
  }

  /** The VCALM path: the service resolves list and index from its own records. */
  async setCredentialStatus(input: {
    tenantId: string
    credentialId: string
    statusPurpose: StatusPurpose
    status: boolean
  }): Promise<StatusChange> {
    const allocation = await this.#storage.getAllocation({
      tenantId: input.tenantId,
      credentialId: input.credentialId,
      statusPurpose: input.statusPurpose
    })
    if (allocation === undefined) {
      throw new StatusListError(
        'credential-not-allocated',
        `Credential "${input.credentialId}" has no ${input.statusPurpose} entry`
      )
    }
    return await this.setStatus({
      listId: allocation.listId,
      statusListIndex: allocation.statusListIndex,
      status: input.status
    })
  }

  /**
   * Binds a credential to a free index, chosen at random.
   *
   * Random rather than sequential is a privacy property, not a preference:
   * sequential indexes publish issuance order, and the herd a 131,072-entry
   * list buys is only as good as the position inside it.
   */
  async allocateIndex(input: {
    tenantId: string
    credentialId: string
    statusPurpose: StatusPurpose
    listId: string
  }): Promise<IndexAllocation> {
    const list = await this.#storage.getStatusList(input.listId)
    if (list === undefined || list.tenantId !== input.tenantId) {
      throw new StatusListError(
        'list-not-found',
        `Status list "${input.listId}" not found`
      )
    }

    for (let attempt = 0; attempt < ALLOCATION_ATTEMPTS; attempt += 1) {
      const statusListIndex = this.#randomIndex(list.characteristics.length)
      if (await this.#storage.isIndexAllocated(input.listId, statusListIndex)) {
        continue
      }
      try {
        return await this.#storage.allocateIndex({
          tenantId: input.tenantId,
          credentialId: input.credentialId,
          statusPurpose: input.statusPurpose,
          listId: input.listId,
          statusListIndex
        })
      } catch (error) {
        // Lost a race for that index to a concurrent allocator; probe again.
        if (error instanceof StorageError && error.code === 'index-taken') {
          continue
        }
        throw error
      }
    }

    throw new StatusListError(
      'list-exhausted',
      `Status list "${input.listId}" has no free index left to allocate`
    )
  }

  #characteristics(
    requested: CreateStatusListInput['characteristics']
  ): StatusListCharacteristics {
    const length = requested?.length ?? MINIMUM_LIST_LENGTH
    if (length < MINIMUM_LIST_LENGTH) {
      throw new StatusListError(
        'list-too-short',
        `A status list must hold at least ${MINIMUM_LIST_LENGTH} entries (BSL §3.2 herd privacy); ${length} was requested`
      )
    }
    // 1-bit entries only in v1: multi-bit entries need `statusMessage`, which
    // the BSL library underneath does not carry.
    if (
      (requested?.statusSize !== undefined && requested.statusSize !== 1) ||
      requested?.statusMessage !== undefined
    ) {
      throw new StatusListError(
        'unsupported-characteristics',
        'Only single-bit status entries are supported; statusSize must be 1 and statusMessage must be absent'
      )
    }
    return {
      length,
      statusSize: 1,
      ...(requested?.ttl === undefined ? {} : { ttl: requested.ttl })
    }
  }

  async #instanceFor(list: StatusListRecord): Promise<IssuerInstance> {
    const tenant = await this.#tenants.getTenant(list.tenantId)
    const instance =
      tenant === undefined
        ? undefined
        : resolveIssuerInstance(tenant, list.issuerInstanceId)
    if (instance === undefined) {
      throw new StatusListError(
        'issuer-instance-unavailable',
        `Issuer instance "${list.issuerInstanceId}" of tenant "${list.tenantId}" is not in the registry, so list "${list.id}" cannot be re-signed`
      )
    }
    return instance
  }

  /** Runs inside the write transaction — this is the sign-on-update step. */
  async #applyStatus(
    current: StatusListRecord,
    instance: IssuerInstance,
    statusListIndex: number,
    status: boolean
  ) {
    if (
      !Number.isInteger(statusListIndex) ||
      statusListIndex < 0 ||
      statusListIndex >= current.characteristics.length
    ) {
      throw new StatusListError(
        'index-out-of-range',
        `Index ${statusListIndex} is outside list "${current.id}" (0…${current.characteristics.length - 1})`
      )
    }

    const list = await decodeBitstring(current.encodedList)
    if (list.getStatus(statusListIndex) === status) {
      // Idempotent write: no new bytes, so no new signature and no new version.
      return { result: { changed: false, record: current } }
    }
    list.setStatus(statusListIndex, status)

    const materialization = await this.#materialize({
      url: this.#canonicalUrl(current),
      instance,
      statusPurpose: current.statusPurpose,
      list,
      ttl: current.characteristics.ttl
    })

    return {
      materialization,
      result: {
        changed: true,
        record: {
          ...current,
          ...materialization,
          version: current.version + 1,
          updatedAt: this.#now()
        }
      }
    }
  }

  async #materialize(input: {
    url: string
    instance: IssuerInstance
    statusPurpose: StatusPurpose
    list: Awaited<ReturnType<typeof createBitstring>>
    ttl?: number
  }) {
    const issuer = await this.#signing.issuerDid(input.instance)
    const { encodedList, unsigned } = await buildStatusListCredential({
      url: input.url,
      issuer,
      statusPurpose: input.statusPurpose,
      list: input.list,
      validFrom: this.#now(),
      ...(input.ttl === undefined ? {} : { ttl: input.ttl })
    })
    return {
      encodedList,
      signedCredential: await this.#signing.sign(input.instance, unsigned)
    }
  }

  /** The URL the list was created under, which never changes once issued. */
  #canonicalUrl(list: StatusListRecord): string {
    return (
      list.signedCredential.id ?? statusListUrl(this.#publicBaseUrl, list.id)
    )
  }
}
