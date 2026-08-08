# Every error is an RFC 9457 problem document

Date: 2026-08-08

Status: accepted

## Context

The VCALM OpenAPI description references a `ProblemDetails` schema for errors
elsewhere in the API, but the status operations declare no error body at all:
`POST /status-lists` lists a bare `400`, `POST /credentials/status` lists `400`
and `404`, and neither declares the `401` its own security requirement implies.
Whatever we return, we are filling a gap rather than following a spec.

The service also has more than one source of failure — request validation
(zod), route-level rejections, the signing module's `SigningError`, storage's
`StorageError` — and each could plausibly shape its own response.

## Decision

Every non-2xx response is an [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)
problem document served as `application/problem+json`, with `type`, `title`,
`status` and an optional `detail`, plus problem-specific extension members.

- `type` is `about:blank` when the status code says everything, otherwise a
  stable `urn:skybridge:vcalm-status-service:problem:*` URI.
- One `onError` handler owns the mapping. Domain modules throw transport-neutral
  errors carrying a `code` — never an HTTP status — and the edge maps them.
- Unrecognized errors become a bare `500` with no `detail`, and are the only
  case logged at error level.

## Consequences

- Clients get one error shape from every endpoint, including 404s for unknown
  routes, which is more than the VCALM description promises and never less.
- Adding an error case is a `ProblemDetailsError` at the throw site; no handler
  invents its own JSON shape.
- Backend failure text — connection strings, driver messages — cannot reach a
  client by accident, because the generic path emits no `detail`.
- The `urn:skybridge:…` type URIs are identifiers, not URLs; if we later want
  them to resolve to documentation, that is a redirect to add, not a client
  change.
- If VCALM later specifies an error body for these operations, we will need to
  reconcile. RFC 9457 permits extension members, so the likely outcome is
  additive rather than a rewrite.
