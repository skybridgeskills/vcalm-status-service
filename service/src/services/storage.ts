import type { VerifiableCredential } from '@skybridgeskills/vc-signer'

/**
 * Persistence contract. Two implementations are planned: `MemoryStorage` for
 * tests, and one Kysely-backed SQL implementation (SQLite locally, Postgres
 * deployed). The interface is written so both can honor the invariant that
 * matters most — a list's signed credential is materialized inside the same
 * serialized write that changes its bits.
 */

/** BSL defines more; this service issues the two purposes it was asked for. */
export type StatusPurpose = 'revocation' | 'suspension'

export const STATUS_PURPOSES: readonly StatusPurpose[] = Object.freeze([
  'revocation',
  'suspension'
])

/** BSL §3.2 herd-privacy floor: lists smaller than this fail conformant validators. */
export const MINIMUM_LIST_LENGTH = 131072

export interface StatusMessage {
  status: string
  message: string
}

/** BSL §2.1/§2.2 list characteristics, fixed at create time. */
export interface StatusListCharacteristics {
  length: number
  statusSize: number
  /** Required by BSL when `statusSize > 1`. */
  statusMessage?: StatusMessage[]
  /** Milliseconds; copied onto `credentialSubject.ttl` and the cache posture. */
  ttl?: number
}

export interface StatusListRecord {
  /** Opaque, service-owned, unique. The canonical URL is derived from it. */
  id: string
  /** Immutable owner, set at create. Authorization is checked against this. */
  tenantId: string
  /** Immutable issuer binding, set at create. Decides which key signs. */
  issuerInstanceId: string
  statusPurpose: StatusPurpose
  characteristics: StatusListCharacteristics
  /** Multibase-encoded GZIP bitstring (BSL §2.2). */
  encodedList: string
  /** The signed credential served verbatim by the public GET. */
  signedCredential: VerifiableCredential
  /** Bumped on every materialization; the ETag is derived from it. */
  version: number
  createdAt: Date
  updatedAt: Date
}

export type NewStatusListRecord = Omit<
  StatusListRecord,
  'version' | 'createdAt' | 'updatedAt'
>

export interface IndexAllocation {
  /** VCALM `credentialId` — need not appear in the credential itself. */
  credentialId: string
  tenantId: string
  listId: string
  statusPurpose: StatusPurpose
  statusListIndex: number
  allocatedAt: Date
}

export type NewIndexAllocation = Omit<IndexAllocation, 'allocatedAt'>

/** The new state produced by a mutation, written atomically with it. */
export interface StatusListMaterialization {
  encodedList: string
  signedCredential: VerifiableCredential
}

export interface StatusListMutationResult<T> {
  /** Omit to leave the list untouched — a redundant write skips re-signing. */
  materialization?: StatusListMaterialization
  result: T
}

export type StorageErrorCode =
  | 'list-not-found'
  | 'duplicate-list'
  | 'index-taken'
  | 'credential-already-allocated'

/** Transport-neutral, like `SigningError`; routes map codes to ProblemDetails. */
export class StorageError extends Error {
  override readonly name = 'StorageError'
  readonly code: StorageErrorCode

  constructor(
    code: StorageErrorCode,
    message?: string,
    options?: { cause?: unknown }
  ) {
    super(message ?? code, options)
    this.code = code
  }
}

export interface StorageService {
  /** Opens connections and applies migrations. */
  init(): Promise<void>
  close(): Promise<void>
  /** Liveness probe for `/healthz`; rejects when the backend is unreachable. */
  ping(): Promise<void>

  createStatusList(record: NewStatusListRecord): Promise<StatusListRecord>
  getStatusList(id: string): Promise<StatusListRecord | undefined>
  findStatusLists(query: {
    tenantId: string
    statusPurpose?: StatusPurpose
    issuerInstanceId?: string
  }): Promise<StatusListRecord[]>

  /**
   * Read-modify-write of one list, serialized against concurrent writers so
   * bit flips cannot be lost. `mutate` runs inside the transaction and returns
   * the re-signed credential; storage bumps `version` and `updatedAt` only
   * when a materialization comes back.
   */
  updateStatusList<T>(
    id: string,
    mutate: (
      current: StatusListRecord
    ) => Promise<StatusListMutationResult<T>> | StatusListMutationResult<T>
  ): Promise<T>

  allocateIndex(allocation: NewIndexAllocation): Promise<IndexAllocation>
  getAllocation(query: {
    tenantId: string
    credentialId: string
    statusPurpose: StatusPurpose
  }): Promise<IndexAllocation | undefined>
  /** Backs random free-index selection: pick, check, retry. */
  isIndexAllocated(listId: string, statusListIndex: number): Promise<boolean>
  countAllocations(listId: string): Promise<number>
}
