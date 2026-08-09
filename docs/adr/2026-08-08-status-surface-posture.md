# The status surface is strict on input and honest about freshness

Date: 2026-08-08

Status: accepted

## Context

The three VCALM status operations are now mounted, and the specification
leaves three things to the implementer that will be hard to change later.

**Caching.** `GET /status-lists/{id}` is public, unauthenticated, cacheable,
and the obvious candidate for a CDN — BSL §6.4 explicitly endorses putting one
there. It is also the document a verifier reads to learn whether a credential
was revoked thirty seconds ago. A long `max-age` makes the endpoint cheap and
makes revocation invisible for the length of that window.

**Unknown input.** VCALM's `CreateStatusListRequest` is
`additionalProperties: false`, but says nothing about `options`, whose
vocabulary we had to mint. A service can ignore what it does not understand or
refuse it.

**A list under the wrong domain.** The authorized-domain check has to answer
something when a list is requested under a domain its tenant does not hold.

## Decision

**Fresh by default; `ttl` is the only way to buy staleness.** Without
`options.ttl` the GET answers `Cache-Control: no-cache` plus a strong `ETag`
derived from the list's version, and honours `If-None-Match` with a 304. Caches
may store the document but must revalidate, so a bit flip can never be masked
by one — and revalidation is a version comparison, not a re-signing. With
`options.ttl` set, the response carries `Cache-Control: public,
max-age=<ttl/1000>`, exactly the alignment BSL §2.2 asks for, and the same
value appears on `credentialSubject.ttl`.

**Unknown keys are refused, everywhere.** `statusPurpose` outside
`revocation`/`suspension`, an unknown top-level field, an unknown `options`
key, an unknown field on `credentialStatus` — all 400. Two near-misses are
recognized specifically so they can be refused with a reason rather than as
typos: `options.statusSize` other than 1 and any `options.statusMessage` answer
"single-bit entries only", and `credentialStatus.type` accepts both
`BitstringStatusList` (the VCALM example) and `BitstringStatusListEntry` (the
BSL term) and nothing else. `indexAllocator` is the one field accepted and
ignored, because VCALM defines it for services that delegate index assignment
and this one does not.

**A list under an unauthorized domain is 404, not 403.** Under that domain,
there is no such list.

## Consequences

- Behavioural revocation testing works without choreography: flip a bit, fetch
  the list, see it. That is what the Certree Dim-3 dimension measures, and it is
  the reason the default is `no-cache` rather than something cheaper.
- A tenant that wants CDN economics opts into them per list, and accepts the
  staleness window it named. Nobody gets it by accident.
- The GET stays cheap anyway: a revalidation is an ETag comparison and a 304,
  and the version is already in the row.
- Refusing unknown input means a client's typo is a 400 at the first call
  rather than a list quietly created with default characteristics. It also
  means adding an option later is a breaking change for nobody and a silent
  no-op for nobody — the two failure modes a permissive parser trades between.
- 404 over 403 keeps the domain check from confirming that a list exists
  somewhere else. It is not much of a secret — the list is public at its
  canonical URL — but there is no reason to volunteer it, and "this domain does
  not serve that" is the honest description.
- The strictness is asymmetric on purpose: strict on what we accept, permissive
  on what we recognize. Accepting both spellings of the entry type costs
  nothing and spares every client a spec-archaeology trip.
