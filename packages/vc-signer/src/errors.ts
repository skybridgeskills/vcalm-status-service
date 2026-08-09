/**
 * Failure modes callers must distinguish. Services map these to their own
 * transport errors (ProblemDetails, HTTP status) at the edge — this module
 * never carries an HTTP status.
 */
export type SigningErrorCode =
  | 'unsupported-cryptosuite'
  | 'issuer-mismatch'
  | 'invalid-key-material'
  | 'missing-context'
  /** A credential handed to `verifyCredential` carries no usable proof. */
  | 'invalid-credential'

export class SigningError extends Error {
  override readonly name = 'SigningError'
  readonly code: SigningErrorCode

  constructor(
    code: SigningErrorCode,
    message?: string,
    options?: { cause?: unknown }
  ) {
    super(message ?? code, options)
    this.code = code
  }
}

export const isSigningError = (error: unknown): error is SigningError =>
  error instanceof SigningError
