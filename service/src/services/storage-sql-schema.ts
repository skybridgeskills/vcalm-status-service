import type { VerifiableCredential } from '@skybridgeskills/vc-signer'
import type {
  IndexAllocation,
  StatusListCharacteristics,
  StatusListRecord,
  StatusPurpose
} from './storage.js'

/**
 * The SQL shape behind `SqlStorage`, written once for both dialects.
 *
 * Two portability choices keep it that way:
 *
 * - **JSON lives in `text` columns.** Postgres would take `jsonb` and SQLite
 *   would not, and nothing here ever queries *into* a document — the list
 *   credential and its characteristics are read and written whole. One column
 *   type means one mapping function instead of a driver-dependent pair.
 * - **Timestamps are ISO-8601 UTC strings.** SQLite has no date type, and the
 *   two drivers disagree about what a date column round-trips as. ISO-8601 in
 *   `text` sorts chronologically, so `order by created_at` needs no help.
 */

export interface StatusListTable {
  id: string
  tenant_id: string
  issuer_instance_id: string
  status_purpose: string
  /** JSON {@link StatusListCharacteristics}. */
  characteristics: string
  encoded_list: string
  /** JSON {@link VerifiableCredential} — the bytes the public GET serves. */
  signed_credential: string
  version: number
  created_at: string
  updated_at: string
}

export interface IndexAllocationTable {
  list_id: string
  tenant_id: string
  credential_id: string
  status_purpose: string
  status_list_index: number
  allocated_at: string
}

export interface Database {
  status_lists: StatusListTable
  index_allocations: IndexAllocationTable
}

export const statusListRow = (record: StatusListRecord): StatusListTable => ({
  id: record.id,
  tenant_id: record.tenantId,
  issuer_instance_id: record.issuerInstanceId,
  status_purpose: record.statusPurpose,
  characteristics: JSON.stringify(record.characteristics),
  encoded_list: record.encodedList,
  signed_credential: JSON.stringify(record.signedCredential),
  version: record.version,
  created_at: record.createdAt.toISOString(),
  updated_at: record.updatedAt.toISOString()
})

export const statusListRecord = (row: StatusListTable): StatusListRecord => ({
  id: row.id,
  tenantId: row.tenant_id,
  issuerInstanceId: row.issuer_instance_id,
  statusPurpose: row.status_purpose as StatusPurpose,
  characteristics: JSON.parse(row.characteristics) as StatusListCharacteristics,
  encodedList: row.encoded_list,
  signedCredential: JSON.parse(row.signed_credential) as VerifiableCredential,
  version: row.version,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at)
})

export const allocationRecord = (
  row: IndexAllocationTable
): IndexAllocation => ({
  credentialId: row.credential_id,
  tenantId: row.tenant_id,
  listId: row.list_id,
  statusPurpose: row.status_purpose as StatusPurpose,
  statusListIndex: row.status_list_index,
  allocatedAt: new Date(row.allocated_at)
})
