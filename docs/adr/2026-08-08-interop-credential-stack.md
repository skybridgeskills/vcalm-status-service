# The @interop credential libraries, and the Node 24 floor they impose

Date: 2026-08-08

Status: accepted

## Context

Signing and, shortly, bitstring list encoding are built on someone's
credential libraries. Two lineages are live and API-compatible with each other,
because one is a fork of the other:

- Digital Bazaar's `@digitalbazaar/vc` and
  `@digitalbazaar/vc-bitstring-status-list` — plain JavaScript, requiring
  Node 18 or later, slower release cadence.
- Interop Alliance's `@interop/vc` (11.0.6) and
  `@interop/vc-bitstring-status-list` (3.0.4) — a TypeScript port of the same
  code, maintained by the Interop Alliance and DCC-adjacent people, published
  within the last six weeks, and requiring Node 24 or later.

The scaffold pinned Node 22, because that is what `dcc-transaction-service`
runs. Choosing the `@interop` line therefore forces a runtime decision the
scaffold had already made the other way. The two lineages cannot be mixed
freely either: a suite built on one fork's proof base class and passed to the
other fork's `issue()` is duck-typing across a fork boundary, and works only
until it doesn't.

## Decision

Build on the `@interop` line, and raise the repository's Node floor to 24.

- `@interop/vc` for issuance, `@interop/security-document-loader` for contexts
  and DID resolution, `@interop/did-method-key` and `@interop/did-web-resolver`
  for DID derivation, `@interop/ed25519-verification-key`,
  `@interop/ecdsa-multikey` and `@interop/bnid` for keys and seeds.
- The two exceptions are the Data Integrity suite implementations —
  `@digitalbazaar/data-integrity` with the `eddsa-rdfc-2022` and
  `ecdsa-rdfc-2019` cryptosuites, plus legacy `@digitalbazaar/ed25519-signature-2020`
  — because the `@interop` line publishes no equivalent.
  `@interop/data-integrity-core` is types only.
- `engines.node` is `>=24.0` in every manifest, `.nvmrc` is `lts/krypton`, and
  the container base image is `node:24-slim`.

## Consequences

- The credential stack is TypeScript-native, so the signer's boundaries are
  type-checked rather than guessed at, and its maintainers are the same people
  whose libraries the rest of our ecosystem work (EDV, DCC alignment) already
  tracks.
- Node 24 is now a hard requirement — local development, CI, and the ECS task
  all move together. The wrapper deployment inherits `node:24-slim`; nothing in
  the Path B image contract cares which minor it is.
- We diverge from `dcc-transaction-service`, which stays on Node 22. That is a
  divergence in convention, not in interface: the services talk over HTTP.
- Suites are constructed from Digital Bazaar classes and handed to an
  `@interop` `issue()`. That works because `jsonld-signatures` type-checks
  suites structurally, not by `instanceof` — verified against every cell of the
  didMethod × cryptosuite matrix, which is exactly why those round-trip tests
  exist. If a future release of either side tightens that, the tests fail
  loudly rather than in production.
- If the `@interop` line stalls, the fallback is the Digital Bazaar packages it
  was forked from: the same API, and the Node floor drops back. The blast
  radius is `packages/vc-signer`, which is the reason signing is a package.
