import type { Kysely } from 'kysely'
import type { Migration, MigrationProvider } from 'kysely/migration'

/**
 * Schema history for `SqlStorage`, applied by the Kysely migrator at startup.
 *
 * Keys are the migration names the migrator records in `kysely_migration`; they
 * sort lexicographically, so new migrations are added with a later date prefix
 * and existing ones are never edited.
 */

const initial: Migration = {
  async up(db: Kysely<unknown>): Promise<void> {
    await db.schema
      .createTable('status_lists')
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('tenant_id', 'text', (col) => col.notNull())
      .addColumn('issuer_instance_id', 'text', (col) => col.notNull())
      .addColumn('status_purpose', 'text', (col) => col.notNull())
      .addColumn('characteristics', 'text', (col) => col.notNull())
      .addColumn('encoded_list', 'text', (col) => col.notNull())
      .addColumn('signed_credential', 'text', (col) => col.notNull())
      .addColumn('version', 'integer', (col) => col.notNull())
      .addColumn('created_at', 'text', (col) => col.notNull())
      .addColumn('updated_at', 'text', (col) => col.notNull())
      .execute()

    // Lists are listed per tenant, optionally narrowed by purpose.
    await db.schema
      .createIndex('status_lists_tenant_purpose_idx')
      .on('status_lists')
      .columns(['tenant_id', 'status_purpose'])
      .execute()

    await db.schema
      .createTable('index_allocations')
      .addColumn('list_id', 'text', (col) =>
        col.notNull().references('status_lists.id')
      )
      .addColumn('tenant_id', 'text', (col) => col.notNull())
      .addColumn('credential_id', 'text', (col) => col.notNull())
      .addColumn('status_purpose', 'text', (col) => col.notNull())
      .addColumn('status_list_index', 'integer', (col) => col.notNull())
      .addColumn('allocated_at', 'text', (col) => col.notNull())
      // An index belongs to at most one credential: the database, not the
      // allocator's retry loop, is what makes random selection safe under
      // concurrency.
      .addPrimaryKeyConstraint('index_allocations_pkey', [
        'list_id',
        'status_list_index'
      ])
      // And a credential holds at most one index per purpose, so a repeated
      // allocate cannot quietly strand the first one.
      .addUniqueConstraint('index_allocations_credential_key', [
        'tenant_id',
        'credential_id',
        'status_purpose'
      ])
      .execute()
  },

  async down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropTable('index_allocations').execute()
    await db.schema.dropTable('status_lists').execute()
  }
}

export const migrations: Record<string, Migration> = {
  '2026-08-08-initial': initial
}

export const migrationProvider: MigrationProvider = {
  getMigrations: () => Promise.resolve(migrations)
}
