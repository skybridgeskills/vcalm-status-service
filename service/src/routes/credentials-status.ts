import { z } from 'zod'
import { problem } from '../problem-details.js'
import { statusListUrl } from '../status-lists/index.js'
import type { Context } from 'hono'
import type { AppDeps } from '../app.js'
import type { AuthVariables } from '../auth.js'
import type { StatusListRecord } from '../services/storage.js'
import type { StatusChange } from '../status-lists/index.js'

/**
 * `POST /credentials/status` — set or clear one credential's status bit.
 *
 * The normal call names a `credentialId` and a purpose and lets the service
 * resolve which list and index that means. The explicit selector
 * (`statusListIndex` + `statusListCredential`) is the escape hatch the contract
 * allows, and it is how a test flips a chosen bit without an allocation record.
 */

export const CREDENTIALS_STATUS_PATH = '/credentials/status'

/**
 * BSL names the entry type `BitstringStatusListEntry`; the VCALM example writes
 * `BitstringStatusList`. Both refer to the same thing, so both are accepted.
 */
const ENTRY_TYPES = ['BitstringStatusList', 'BitstringStatusListEntry']

const credentialStatusSchema = z
  .object({
    id: z.string().optional(),
    type: z.string(),
    statusPurpose: z.enum(['revocation', 'suspension']),
    /** BSL §2.1: an arbitrary-size integer expressed as a base-10 string. */
    statusListIndex: z.string().optional(),
    statusListCredential: z.string().optional()
  })
  .strict()

export const updateCredentialStatusSchema = z
  .object({
    credentialId: z.string().min(1),
    credentialStatus: credentialStatusSchema,
    status: z.boolean(),
    /**
     * Declared by VCALM for services that delegate index assignment. This
     * service allocates its own indexes, so the value is accepted and ignored
     * rather than rejected as an unknown key.
     */
    indexAllocator: z.string().optional()
  })
  .strict()

type UpdateCredentialStatusBody = z.infer<typeof updateCredentialStatusSchema>

const parseIndex = (raw: string): number => {
  if (!/^\d+$/.test(raw)) {
    throw problem(
      400,
      `"${raw}" is not a status list index; BSL requires a base-10 integer string`
    )
  }
  const index = Number(raw)
  if (!Number.isSafeInteger(index)) {
    throw problem(400, `Status list index "${raw}" is out of range`)
  }
  return index
}

const canonicalUrlOf = (record: StatusListRecord, publicBaseUrl: string) =>
  record.signedCredential.id ?? statusListUrl(publicBaseUrl, record.id)

/**
 * Resolves `statusListCredential` back to a stored list. The canonical URL is
 * `…/status-lists/{id}`, so the id is its last segment — and the stored list has
 * to agree that this is its URL, so a plausible-looking URL cannot address a
 * list that does not answer to it.
 */
const listFromUrl = async (
  deps: AppDeps,
  url: string
): Promise<StatusListRecord> => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw problem(400, `"${url}" is not a status list URL`)
  }
  const segments = parsed.pathname
    .split('/')
    .filter((segment) => segment !== '')
  if (segments.length !== 2 || segments[0] !== 'status-lists') {
    throw problem(400, `"${url}" is not a status list URL`)
  }

  const record = await deps.services.storage.getStatusList(
    decodeURIComponent(segments[1]!)
  )
  if (
    record === undefined ||
    canonicalUrlOf(record, deps.config.publicBaseUrl) !== url
  ) {
    throw problem(404, `No status list at "${url}"`)
  }
  return record
}

const setByExplicitSelector = async (
  deps: AppDeps,
  tenantId: string,
  body: UpdateCredentialStatusBody
): Promise<StatusChange> => {
  const selector = body.credentialStatus
  if (
    selector.statusListIndex === undefined ||
    selector.statusListCredential === undefined
  ) {
    throw problem(
      400,
      'An explicit selector needs both statusListIndex and statusListCredential'
    )
  }

  const list = await listFromUrl(deps, selector.statusListCredential)
  // `setStatus` sets bits without asking whose list it is. Here is where that
  // question is answered — the same 404 as a list that does not exist, because
  // to this tenant it does not.
  if (list.tenantId !== tenantId) {
    throw problem(404, `No status list at "${selector.statusListCredential}"`)
  }
  if (list.statusPurpose !== selector.statusPurpose) {
    throw problem(
      400,
      `Status list "${list.id}" is a ${list.statusPurpose} list, not ${selector.statusPurpose}`
    )
  }

  return await deps.services.statusLists.setStatus({
    listId: list.id,
    statusListIndex: parseIndex(selector.statusListIndex),
    status: body.status
  })
}

export const updateCredentialStatusHandler =
  (deps: AppDeps) => async (c: Context<AuthVariables>) => {
    const tenantId = c.var.tenant.tenantId
    const body = updateCredentialStatusSchema.parse(await c.req.json())
    const selector = body.credentialStatus

    if (!ENTRY_TYPES.includes(selector.type)) {
      throw problem(
        400,
        `credentialStatus.type must be one of: ${ENTRY_TYPES.join(', ')}`
      )
    }

    const explicit =
      selector.statusListIndex !== undefined ||
      selector.statusListCredential !== undefined

    const change = explicit
      ? await setByExplicitSelector(deps, tenantId, body)
      : await deps.services.statusLists.setCredentialStatus({
          tenantId,
          credentialId: body.credentialId,
          statusPurpose: selector.statusPurpose,
          status: body.status
        })

    // VCALM declares 200 with no body. Echoing the entry that moved costs a
    // conformant client nothing and tells a test which bit it just hit.
    return c.json({
      credentialId: body.credentialId,
      credentialStatus: {
        type: 'BitstringStatusListEntry',
        statusPurpose: change.record.statusPurpose,
        statusListIndex: String(change.statusListIndex),
        statusListCredential: canonicalUrlOf(
          change.record,
          deps.config.publicBaseUrl
        )
      },
      status: body.status
    })
  }
