import { describe, expect, test } from 'vitest'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import {
  ProblemDetailsError,
  ProblemType,
  toProblemDetails
} from './problem-details.js'

describe('toProblemDetails', () => {
  test('passes a ProblemDetailsError through with its extensions', () => {
    const error = new ProblemDetailsError(409, 'list already exists', {
      type: 'urn:skybridge:vcalm-status-service:problem:duplicate-list',
      extensions: { listId: 'abc' }
    })
    expect(toProblemDetails(error)).toEqual({
      type: 'urn:skybridge:vcalm-status-service:problem:duplicate-list',
      title: 'Conflict',
      status: 409,
      detail: 'list already exists',
      listId: 'abc'
    })
  })

  test('defaults type and title from the status code', () => {
    expect(toProblemDetails(new ProblemDetailsError(401))).toEqual({
      type: ProblemType.blank,
      title: 'Unauthorized',
      status: 401
    })
  })

  test('turns a ZodError into a 400 that names the offending fields', () => {
    const schema = z.object({ statusPurpose: z.string() })
    const result = schema.safeParse({})
    expect(result.success).toBe(false)
    const details = toProblemDetails(result.success ? null : result.error)
    expect(details.status).toBe(400)
    expect(details.type).toBe(ProblemType.validation)
    expect(details.detail).toContain('statusPurpose')
    expect(details.errors).toEqual([
      { path: ['statusPurpose'], message: 'Required' }
    ])
  })

  test('maps a Hono HTTPException onto its own status', () => {
    const details = toProblemDetails(
      new HTTPException(404, { message: 'Status list not found' })
    )
    expect(details).toEqual({
      type: ProblemType.blank,
      title: 'Not Found',
      status: 404,
      detail: 'Status list not found'
    })
  })

  test('never leaks details of an unrecognized error', () => {
    const details = toProblemDetails(
      new Error('DSN=postgres://user:secret@db/status')
    )
    expect(details).toEqual({
      type: ProblemType.blank,
      title: 'Internal Server Error',
      status: 500
    })
    expect(JSON.stringify(details)).not.toContain('secret')
  })
})
