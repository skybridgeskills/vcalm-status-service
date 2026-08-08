import { describe, expect, test } from 'vitest'
import { SigningError, isSigningError } from './errors.js'

describe('SigningError', () => {
  test('carries a code and defaults its message to that code', () => {
    const error = new SigningError('issuer-mismatch')
    expect(error.code).toBe('issuer-mismatch')
    expect(error.message).toBe('issuer-mismatch')
    expect(error.name).toBe('SigningError')
  })

  test('preserves an explicit message and cause', () => {
    const cause = new Error('boom')
    const error = new SigningError('missing-context', 'no v2 context', {
      cause
    })
    expect(error.message).toBe('no v2 context')
    expect(error.cause).toBe(cause)
  })

  test('carries no HTTP status — transport mapping belongs to the caller', () => {
    expect('status' in new SigningError('invalid-key-material')).toBe(false)
  })

  test('is narrowable from unknown', () => {
    expect(isSigningError(new SigningError('issuer-mismatch'))).toBe(true)
    expect(isSigningError(new Error('issuer-mismatch'))).toBe(false)
  })
})
