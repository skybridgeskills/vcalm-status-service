# vcalm-status-service

A [VCALM](https://w3c.github.io/vcalm/)-conforming credential status service.
It publishes and updates [Bitstring Status List
1.0](https://www.w3.org/TR/vc-bitstring-status-list/) credentials for
multi-tenant issuers, and it is built to be run by anyone — not just Skybridge.

TypeScript, [Hono](https://hono.dev), pnpm, service-oriented: signing, storage
and the tenant registry are interfaces chosen by configuration.

## Status

Early. The scaffold, configuration, error surface and service interfaces are in
place; signing is real (`@skybridgeskills/vc-signer` signs under
`eddsa-rdfc-2022`, `ecdsa-rdfc-2019` and legacy `Ed25519Signature2020`, over
`did:key` or `did:web`); and status lists are stored, allocated and re-signed on
update against SQLite or Postgres. Tenancy is real too: tenants come from the
registry, Bearer authentication resolves them, and a list is only served under a
domain its tenant holds. The HTTP surface is not mounted yet — the routes and
the provisioning CLI land next, see [Roadmap](#roadmap).

## The VCALM status surface

Three operations, per the VCALM OpenAPI description:

| Operation                          | Route                      | Auth   |
| ---------------------------------- | -------------------------- | ------ |
| Create a status list               | `POST /status-lists`       | Bearer |
| Fetch a status list credential     | `GET /status-lists/{id}`   | public |
| Set or clear a credential's status | `POST /credentials/status` | Bearer |

Plus `POST /credentials/status/allocate`, a **documented non-VCALM extension**
that hands an issuer a status list entry before it signs a credential.

Design commitments worth knowing before reading the code:

- **Sign on update, never on GET.** The signed list credential is materialized
  inside the write transaction that changes a bit. The public GET serves stored
  bytes, so it never invokes a key and a redundant write never re-signs.
- **Tenancy binds to the list.** Every list carries an immutable `tenant_id`
  set at create time. Ownership is never inferred from the request's domain or
  path, so the same list resolves identically through a proxy, a SaaS domain or
  an ngrok tunnel.
- **Service-owned canonical URLs.** A list's URL is
  `{PUBLIC_BASE_URL}/status-lists/{id}`, fixed at create time — already-issued
  credentials point at it forever.
- **One list per status purpose** (`revocation`, `suspension`), with the BSL
  herd-privacy floor of 131,072 entries enforced at creation.
- **Random index allocation**, so a list does not leak issuance order.
- **Bearer only.** VCALM forbids long-lived credentials of the HTTP Basic kind;
  this service accepts an HS256 JWT access token or a static tenant token, and
  never Basic.
- **No provisioning API.** Tenants are provisioned into the registry out of
  band, by CLI. The service never exposes an endpoint that creates one.

Errors are [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem
documents (`application/problem+json`), which fills a gap in the VCALM
description — it declares no error body for these operations.

## Storage

Two implementations of one interface. `MemoryStorage` is for tests and
throwaway runs; `SqlStorage` is a single Kysely implementation over two
dialects, so both share one schema and one set of queries:

| `STORAGE_MODE` | Backend                          | For                                        |
| -------------- | -------------------------------- | ------------------------------------------ |
| `memory`       | process memory                   | tests; refused when `NODE_ENV=production`  |
| `sqlite`       | `SQLITE_FILE` via better-sqlite3 | local and ngrok runs — a file and a volume |
| `postgres`     | `DATABASE_URL` via `pg`          | the deployed wrapper                       |

Migrations are Kysely's, applied at startup, so a plain `docker run` with a
volume comes up ready. Two tables: `status_lists` (the list, its
characteristics, its bits, and the signed credential the public GET serves) and
`index_allocations` (which credential holds which index, and the constraint
that stops two of them holding the same one).

Every bit flip runs inside one transaction that holds the list row — Postgres
with `select … for update`, SQLite by holding its single writer — decodes the
bitstring, sets the bit, re-encodes, re-signs and stores both. Concurrent flips
serialize instead of overwriting each other, and a redundant write returns
without touching the credential or the version.

## Tenancy and authentication

A tenant owns its lists, its issuer instances and its credentials. Every list
carries an immutable `tenant_id` set at create, and ownership is checked against
that — never against the request's host or path, which is what lets one list
resolve identically through a proxy, a direct domain and an ngrok tunnel.

**Bearer only.** VCALM forbids long-lived credentials of the HTTP Basic kind, so
this service accepts `Authorization: Bearer <token>` and nothing else — a
deliberate divergence from `dcc-transaction-service`, whose conventions it
otherwise copies. Two credential forms are accepted:

1. an **HS256 access token** whose `sub` names the tenant (`ACCESS_JWT_SECRET`);
2. a **static tenant token**, so one provisioning act works across every service.

The endpoint that mints access tokens is deliberately not implemented — a
recorded conformance gap. Verification ships, so adding it later is additive.
Authentication never switches itself off: a registry with no tenants refuses
every write rather than allowing it.

Tenants come from `TENANT_REGISTRY_MODE`:

| Mode     | Source                                                               |
| -------- | -------------------------------------------------------------------- |
| `env`    | `TENANT_TOKEN_<NAME>` and friends — see [.env.example](.env.example) |
| `memory` | tests only; refused when `NODE_ENV=production`                       |

An `HttpTenantRegistry` that pulls from the platform's tenant-service replaces
`env` later without touching a caller — which is why the interface is async.

### Authorized domains

The same list is reachable through several fronts, so before serving one the
service checks the effective host (`X-Forwarded-Host`, else `Host`) against the
owning tenant's `TENANT_DOMAINS_<NAME>` plus `PUBLIC_BASE_URL`, which every
tenant may use and nobody has to list. The same set decides whether a
client-supplied canonical `id` may be minted at create.

This narrows; it never widens. It is not access control — the GET is public
wherever it is answered — it exists so one tenant's list is never served under
another's brand.

## Repository layout

```
service/              the Hono application
packages/vc-signer/   @skybridgeskills/vc-signer — VC signing, several cryptosuites
```

## Getting started

Requires Node 24+ and pnpm 10 (`corepack enable`). The Node floor comes from
the `@interop` credential libraries — see
[the stack ADR](docs/adr/2026-08-08-interop-credential-stack.md).

```bash
pnpm install
cp .env.example service/.env
pnpm dev
```

```bash
curl localhost:4008/healthz
```

`pnpm validate` runs the full check — lint, build, tests — and is what CI runs.

## Configuration

All configuration is environment variables, validated with zod at startup; an
invalid value fails the boot rather than defaulting silently. See
[.env.example](.env.example) for the full list with defaults.

The backend for each service interface is a mode: `STORAGE_MODE`,
`SIGNING_MODE`, `TENANT_REGISTRY_MODE`.

`STORAGE_MODE=sqlite` reads `SQLITE_FILE` (default `./data/status-lists.db`,
created along with its directory); `STORAGE_MODE=postgres` requires
`DATABASE_URL`. `STORAGE_MODE=memory`, the default, forgets every list when the
process exits — which would break every credential already pointing at one — so
configuration refuses it when `NODE_ENV=production`.

`SIGNING_MODE=local` signs in-process with `@skybridgeskills/vc-signer`, using
the key material on the issuer instance a list is bound to. `SIGNING_MODE=http`
calls the VCALM `POST /credentials/issue` of a provisioned
`dcc-signing-service` at `SIGNING_SERVICE_URL`, authenticating with the token
recorded on the instance — the remote holds the key, so the instance also
carries the issuer DID that provisioning recorded. `SIGNING_MODE=fake`, the
default, is a test double that produces an unverifiable proof; configuration
refuses it when `NODE_ENV=production`, so a production deployment has to choose
its signer explicitly.

## Deployment

The image is a five-stage `node:24-slim` build; the container listens on
`0.0.0.0:$PORT` and answers `/healthz` for the load balancer's target group.
All configuration arrives as environment variables, so the same image runs
locally, behind ngrok, and in ECS.

## Roadmap

1. ~~`@skybridgeskills/vc-signer` — real signing across `eddsa-rdfc-2022`,
   `ecdsa-rdfc-2019` and legacy `Ed25519Signature2020`.~~ Done; see
   [packages/vc-signer](packages/vc-signer/README.md).
2. ~~SQL storage (Kysely; SQLite locally, Postgres deployed) with
   sign-on-update.~~ Done; see [Storage](#storage).
3. ~~Tenancy, bearer auth, the tenant registry and the authorized-domain check,
   including `SIGNING_MODE=http`.~~ Done; see
   [Tenancy and authentication](#tenancy-and-authentication).
4. The VCALM status surface routes.
5. `pnpm provision-tenant` — onboards a tenant end to end.
6. The allocate endpoint and issuer integration.

## Acknowledgments

This service is new code, but it stands on work from the [Digital Credentials
Consortium](https://github.com/digitalcredentials):

- Its scaffold conventions — Hono routing, the validation script, the container
  build, tenant and issuer-instance configuration — follow DCC's
  `transaction-service`.
- DCC's `status-service-db` (over Digital Bazaar's
  `credential-status-manager-db`) was the benchmark this service was measured
  against while it was designed.
- Signing builds on the `@interop` and Digital Bazaar credential libraries, and
  `@skybridgeskills/vc-signer` carries over the suite plugin contract from DCC's
  `signing-service`.

Lineage disclosed, not disclaimed. This is not a fork of any of them.

## License

MIT — see [LICENSE.md](LICENSE.md). Copyright Skybridge Skills.
