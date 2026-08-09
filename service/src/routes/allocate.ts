import { z } from 'zod'
import { problem } from '../problem-details.js'
import {
  bitstringStatusListEntry,
  statusListUrl
} from '../status-lists/index.js'
import type { Context } from 'hono'
import type { AppDeps } from '../app.js'
import type { AuthVariables } from '../auth.js'

/**
 * `POST /credentials/status/allocate` — **a documented non-VCALM extension.**
 *
 * VCALM has no allocate operation: in its architecture, attaching a status
 * entry is issuer-instance configuration on the issue endpoint. This service is
 * standalone, so something has to hand an issuer an entry before it signs, and
 * this is it — the same path and the same credential-in, credential-out shape
 * as DCC's `status-service-db`, so an existing caller keeps its flow.
 *
 * Two differences from DCC's are deliberate: it requires a Bearer token like
 * every other write here, and it attaches one entry for one purpose rather than
 * revocation and suspension together.
 *
 * It does not touch `@context`. A VCDM 2.0 credential already defines the entry
 * terms; a 1.1 credential has to bring its own status context, and quietly
 * appending one to a document somebody else is about to sign would be a worse
 * surprise than the canonicalization error.
 */

export const ALLOCATE_PATH = '/credentials/status/allocate'

const credentialSchema = z
  .object({ id: z.string().optional() })
  .passthrough()
  .describe('an unsigned credential')

const wrappedSchema = z
  .object({
    credential: credentialSchema,
    options: z
      .object({
        statusPurpose: z.enum(['revocation', 'suspension']).optional(),
        /** Skips list selection; the caller has chosen. */
        statusListId: z.string().min(1).optional()
      })
      .strict()
      .optional()
  })
  .strict()

type Credential = Record<string, unknown>

interface AllocateRequest {
  credential: Credential
  statusPurpose: 'revocation' | 'suspension'
  statusListId: string | undefined
}

/**
 * The wrapped form is discriminated on the presence of a `credential` key;
 * anything else is a bare credential, which is how DCC's callers post.
 */
export const parseAllocateBody = (body: unknown): AllocateRequest => {
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).length === 0
  ) {
    throw problem(400, 'Post a credential, or {credential, options}.')
  }

  if ('credential' in body) {
    const wrapped = wrappedSchema.parse(body)
    return {
      credential: wrapped.credential as Credential,
      statusPurpose: wrapped.options?.statusPurpose ?? 'revocation',
      statusListId: wrapped.options?.statusListId
    }
  }

  return {
    credential: credentialSchema.parse(body) as Credential,
    statusPurpose: 'revocation',
    statusListId: undefined
  }
}

/**
 * Existing entries are kept and the new one appended, because a credential may
 * legitimately carry one per purpose. BSL allows `credentialStatus` to be a
 * single object or an array, and this only reaches for the array when it must.
 */
const withStatusEntry = (
  credential: Credential,
  entry: unknown
): Credential => {
  const existing = credential.credentialStatus
  if (existing === undefined) {
    return { ...credential, credentialStatus: entry }
  }
  return {
    ...credential,
    credentialStatus: [
      ...(Array.isArray(existing) ? (existing as unknown[]) : [existing]),
      entry
    ]
  }
}

export const allocateHandler =
  (deps: AppDeps) => async (c: Context<AuthVariables>) => {
    const tenantId = c.var.tenant.tenantId
    const request = parseAllocateBody(await c.req.json())

    const credentialId = request.credential.id
    if (typeof credentialId !== 'string' || credentialId === '') {
      throw problem(
        400,
        'The credential needs an `id`; it is what a later status update names.'
      )
    }

    const { allocation, list } =
      await deps.services.statusLists.allocateForCredential({
        tenantId,
        credentialId,
        statusPurpose: request.statusPurpose,
        ...(request.statusListId === undefined
          ? {}
          : { listId: request.statusListId })
      })

    const entry = bitstringStatusListEntry({
      statusListCredential:
        list.signedCredential.id ??
        statusListUrl(deps.config.publicBaseUrl, list.id),
      statusListIndex: allocation.statusListIndex,
      statusPurpose: allocation.statusPurpose
    })

    // Credential in, credential out — the caller signs what comes back.
    return c.json(withStatusEntry(request.credential, entry))
  }
