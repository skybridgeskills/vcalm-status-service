export type StatusListErrorCode =
  /** `options.length` below the BSL §3.2 herd-privacy floor. */
  | 'list-too-short'
  /** Only 1-bit entries in v1; `statusSize`/`statusMessage` are refused. */
  | 'unsupported-characteristics'
  | 'list-not-found'
  /** A chosen list does not serve the purpose the caller asked for. */
  | 'list-purpose-mismatch'
  /** The list's tenant or issuer instance is gone from the registry. */
  | 'issuer-instance-unavailable'
  | 'index-out-of-range'
  /** No allocation for this credential and purpose — nothing to flip. */
  | 'credential-not-allocated'
  /** Every random probe hit a taken index; the list has no room left. */
  | 'list-exhausted'

/**
 * Transport-neutral, like `SigningError` and `StorageError`: the domain says
 * what went wrong and the routes decide what an HTTP client is told.
 */
export class StatusListError extends Error {
  override readonly name = 'StatusListError'
  readonly code: StatusListErrorCode

  constructor(
    code: StatusListErrorCode,
    message?: string,
    options?: { cause?: unknown }
  ) {
    super(message ?? code, options)
    this.code = code
  }
}

export const isStatusListError = (error: unknown): error is StatusListError =>
  error instanceof StatusListError
