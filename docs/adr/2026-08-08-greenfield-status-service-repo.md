# Greenfield status service, in its own two-package repository

Date: 2026-08-08

Status: accepted

## Context

We need a credential status service that conforms to the VCALM status surface
and publishes Bitstring Status List credentials for multiple tenants. Two
existing codebases were candidates to build on:

- **DCC's `status-service-db`** (over Digital Bazaar's
  `credential-status-manager-db`): roughly 500 lines of plain-JavaScript
  Express 4 glue. Upstream has been dormant since October 2024 and our fork
  carries no Skybridge commits. It has no VCALM `/status-lists` surface at all,
  no authentication, no tenancy (one process is one DID seed and one Mongo
  database), lists hardcoded to 100,000 entries — below the Bitstring Status
  List herd-privacy floor of 131,072 — sequential index allocation that leaks
  issuance order, `Ed25519Signature2020` as the only cryptosuite, a required
  Mongo replica set, and stub-only tests.
- **DCC's `transaction-service`**, which we already run and maintain, and whose
  conventions are the house style.

Separately, VC signing is needed in more than one place: this service signs
status list credentials, and `dcc-signing-service` needs the same capability
when it is upgraded. Publishing a signing package to npm would mean standing up
an npm organization we do not have.

## Decision

Build a new service, `skybridgeskills/vcalm-status-service`: public, MIT, at
the top level of the workspace rather than under `dcc/`, because it is not a
fork.

The repository is a two-package pnpm workspace:

- `service/` — the Hono application.
- `packages/vc-signer/` — `@skybridgeskills/vc-signer`, the signing module,
  consumed here as `workspace:*` and by external repositories as a pnpm git
  dependency (`github:skybridgeskills/vcalm-status-service#path:packages/vc-signer`).
  Nothing is published to a registry; the scoped name is aspirational.

Scaffold conventions are copied from `transaction-service` — pnpm 10, Node 22,
ESM with `NodeNext` and `.js`-extension imports, TypeScript strict, Hono with a
routes object and an exported `AppType`, colocated vitest tests, eslint flat
config plus prettier, husky and lint-staged, `validate.sh`, a five-stage
`node:22-slim` image — with two deliberate upgrades:

1. **Configuration is parsed and validated with zod**, not hand-read from
   `process.env`; an invalid value fails the boot.
2. **Signing, storage and the tenant registry are interfaces from day one**,
   each with a production and an in-memory implementation selected by config,
   rather than module singletons.

`status-service-db` remains a reference for behavior we must match (the
allocate endpoint DCC's issuer already calls), not a codebase we extend.

## Consequences

- This is a rewrite, not a migration. Nothing carries over except one idea
  worth keeping: the clean seam of a single injected status manager behind the
  routes, which becomes the `StorageService` and `SigningService` interfaces.
- The service must beat the benchmark on the axes that made it unusable:
  TypeScript strict, the VCALM surface, bearer auth, real multi-tenancy,
  configurable list characteristics with the 131,072 floor enforced, random
  index allocation, pluggable backends, `eddsa-rdfc-2022` Data Integrity
  proofs, HTTP-level tests against the real app, and structured logs with a
  `/healthz` contract.
- Being a workspace makes the container build slightly more involved (it stages
  manifests for both packages and copies both `dist/` trees), and it means the
  signing module can move to its own repository later without changing how
  consumers import it.
- Consumers of `vc-signer` depend on a git ref rather than a version. The
  package carries a `prepare` script so `dist/` builds during install. If the
  `#path:` mechanism proves flaky, the fallbacks are GitHub Packages or
  promotion to a standalone repository; the package boundary makes either
  mechanical.
- Public and MIT from the first commit, with DCC lineage disclosed in the
  README's acknowledgments. Disclosure, not disqualifier.
