import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import SqliteDatabase from 'better-sqlite3'
import {
  Kysely,
  PostgresDialect,
  SqliteDialect,
  sql,
  type Dialect,
  type Transaction
} from 'kysely'
import { Migrator } from 'kysely/migration'
import pg from 'pg'
import { migrationProvider } from './storage-sql-migrations.js'
import {
  allocationRecord,
  statusListRecord,
  statusListRow,
  type Database
} from './storage-sql-schema.js'
import {
  StorageError,
  type IndexAllocation,
  type NewIndexAllocation,
  type NewStatusListRecord,
  type StatusListMutationResult,
  type StatusListRecord,
  type StatusPurpose,
  type StorageService
} from './storage.js'

/**
 * Where the one SQL implementation puts its rows. SQLite is the local and
 * ngrok-run backend — a file plus a volume, no service to provision — and
 * Postgres is the deployed one, alongside the rest of the platform.
 */
export type SqlStorageOptions =
  | { dialect: 'sqlite'; file: string }
  | { dialect: 'postgres'; url: string }

const IN_MEMORY_SQLITE = ':memory:'

const createDialect = (options: SqlStorageOptions): Dialect => {
  if (options.dialect === 'postgres') {
    return new PostgresDialect({
      pool: new pg.Pool({ connectionString: options.url })
    })
  }
  if (options.file !== IN_MEMORY_SQLITE) {
    // A fresh container mounts an empty volume; better-sqlite3 creates the
    // file but not the directory above it.
    mkdirSync(dirname(options.file), { recursive: true })
  }
  return new SqliteDialect({ database: new SqliteDatabase(options.file) })
}

/**
 * The single SQL implementation of {@link StorageService}, written over Kysely
 * so SQLite and Postgres share one schema and one set of queries rather than
 * drifting apart as two hand-maintained backends.
 *
 * The invariant it exists to protect: a list's bits and the signed credential
 * that publishes them change together, or not at all. Every mutation runs in a
 * transaction that holds the list row for its duration, so two concurrent bit
 * flips serialize instead of one overwriting the other's re-signed credential.
 */
export class SqlStorage implements StorageService {
  readonly #options: SqlStorageOptions
  #db: Kysely<Database> | undefined

  constructor(options: SqlStorageOptions) {
    this.#options = options
  }

  get #database(): Kysely<Database> {
    if (this.#db === undefined) {
      // A wiring bug, not a request outcome — deliberately not a StorageError.
      throw new Error('SqlStorage.init() has not been awaited')
    }
    return this.#db
  }

  async init(): Promise<void> {
    if (this.#db !== undefined) return
    const db = new Kysely<Database>({ dialect: createDialect(this.#options) })
    if (this.#options.dialect === 'sqlite') {
      // Off by default in SQLite, and the allocation table's reference to its
      // list is only worth declaring if it is enforced.
      await sql`pragma foreign_keys = on`.execute(db)
    }

    const { error } = await new Migrator({
      db,
      provider: migrationProvider
    }).migrateToLatest()
    if (error !== undefined) {
      await db.destroy()
      throw error
    }
    this.#db = db
  }

  async close(): Promise<void> {
    const db = this.#db
    this.#db = undefined
    await db?.destroy()
  }

  async ping(): Promise<void> {
    await sql`select 1`.execute(this.#database)
  }

  async createStatusList(
    record: NewStatusListRecord
  ): Promise<StatusListRecord> {
    const now = new Date()
    const stored: StatusListRecord = {
      ...record,
      version: 1,
      createdAt: now,
      updatedAt: now
    }
    try {
      await this.#database
        .insertInto('status_lists')
        .values(statusListRow(stored))
        .execute()
    } catch (error) {
      if ((await this.getStatusList(record.id)) !== undefined) {
        throw new StorageError(
          'duplicate-list',
          `Status list "${record.id}" already exists`,
          { cause: error }
        )
      }
      throw error
    }
    return stored
  }

  async getStatusList(id: string): Promise<StatusListRecord | undefined> {
    const row = await this.#database
      .selectFrom('status_lists')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst()
    return row === undefined ? undefined : statusListRecord(row)
  }

  async findStatusLists(query: {
    tenantId: string
    statusPurpose?: StatusPurpose
    issuerInstanceId?: string
  }): Promise<StatusListRecord[]> {
    let builder = this.#database
      .selectFrom('status_lists')
      .selectAll()
      .where('tenant_id', '=', query.tenantId)
    if (query.statusPurpose !== undefined) {
      builder = builder.where('status_purpose', '=', query.statusPurpose)
    }
    if (query.issuerInstanceId !== undefined) {
      builder = builder.where('issuer_instance_id', '=', query.issuerInstanceId)
    }
    const rows = await builder.orderBy('created_at', 'asc').execute()
    return rows.map(statusListRecord)
  }

  async updateStatusList<T>(
    id: string,
    mutate: (
      current: StatusListRecord
    ) => Promise<StatusListMutationResult<T>> | StatusListMutationResult<T>
  ): Promise<T> {
    return await this.#database.transaction().execute(async (trx) => {
      const row = await this.#lockStatusList(trx, id)
      if (row === undefined) {
        throw new StorageError(
          'list-not-found',
          `Status list "${id}" not found`
        )
      }

      // `mutate` re-signs, which is why signing lives inside the transaction:
      // the credential that publishes these bits is written with them.
      const outcome = await mutate(statusListRecord(row))
      if (outcome.materialization !== undefined) {
        await trx
          .updateTable('status_lists')
          .set({
            encoded_list: outcome.materialization.encodedList,
            signed_credential: JSON.stringify(
              outcome.materialization.signedCredential
            ),
            version: row.version + 1,
            updated_at: new Date().toISOString()
          })
          .where('id', '=', id)
          .execute()
      }
      return outcome.result
    })
  }

  /**
   * Postgres needs `for update` to keep a second writer out until this
   * transaction commits. SQLite has no row locks and needs none: better-sqlite3
   * is synchronous behind a single connection, so an open transaction already
   * excludes every other writer in the process.
   */
  async #lockStatusList(trx: Transaction<Database>, id: string) {
    const query = trx
      .selectFrom('status_lists')
      .selectAll()
      .where('id', '=', id)
    return await (
      this.#options.dialect === 'postgres' ? query.forUpdate() : query
    ).executeTakeFirst()
  }

  async allocateIndex(
    allocation: NewIndexAllocation
  ): Promise<IndexAllocation> {
    const stored: IndexAllocation = { ...allocation, allocatedAt: new Date() }
    try {
      await this.#database
        .insertInto('index_allocations')
        .values({
          list_id: stored.listId,
          tenant_id: stored.tenantId,
          credential_id: stored.credentialId,
          status_purpose: stored.statusPurpose,
          status_list_index: stored.statusListIndex,
          allocated_at: stored.allocatedAt.toISOString()
        })
        .execute()
    } catch (error) {
      throw await this.#classifyAllocationFailure(allocation, error)
    }
    return stored
  }

  /**
   * Turns a constraint violation into the code the routes answer with.
   *
   * Read back rather than parsed from the driver's error: the two dialects
   * report violations differently, and Postgres aborts the transaction that hit
   * one — so the classifying queries run afterwards, on their own connection.
   */
  async #classifyAllocationFailure(
    allocation: NewIndexAllocation,
    cause: unknown
  ): Promise<unknown> {
    const existing = await this.getAllocation(allocation)
    if (existing !== undefined) {
      return new StorageError(
        'credential-already-allocated',
        `Credential "${allocation.credentialId}" already has a ${allocation.statusPurpose} index`,
        { cause }
      )
    }
    if (
      await this.isIndexAllocated(allocation.listId, allocation.statusListIndex)
    ) {
      return new StorageError(
        'index-taken',
        `Index ${allocation.statusListIndex} of list "${allocation.listId}" is already allocated`,
        { cause }
      )
    }
    if ((await this.getStatusList(allocation.listId)) === undefined) {
      return new StorageError(
        'list-not-found',
        `Status list "${allocation.listId}" not found`,
        { cause }
      )
    }
    return cause
  }

  async getAllocation(query: {
    tenantId: string
    credentialId: string
    statusPurpose: StatusPurpose
  }): Promise<IndexAllocation | undefined> {
    const row = await this.#database
      .selectFrom('index_allocations')
      .selectAll()
      .where('tenant_id', '=', query.tenantId)
      .where('credential_id', '=', query.credentialId)
      .where('status_purpose', '=', query.statusPurpose)
      .executeTakeFirst()
    return row === undefined ? undefined : allocationRecord(row)
  }

  async isIndexAllocated(
    listId: string,
    statusListIndex: number
  ): Promise<boolean> {
    const row = await this.#database
      .selectFrom('index_allocations')
      .select('list_id')
      .where('list_id', '=', listId)
      .where('status_list_index', '=', statusListIndex)
      .executeTakeFirst()
    return row !== undefined
  }

  async countAllocations(listId: string): Promise<number> {
    const row = await this.#database
      .selectFrom('index_allocations')
      .select(({ fn }) => fn.countAll().as('count'))
      .where('list_id', '=', listId)
      .executeTakeFirstOrThrow()
    return Number(row.count)
  }
}
