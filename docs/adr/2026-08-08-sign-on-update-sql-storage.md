# Sign on update, into one SQL implementation over two dialects

Date: 2026-08-08

Status: accepted

## Context

A status list is two things that must agree: a bitstring, and a signed
`BitstringStatusListCredential` that publishes it at a URL already baked into
issued credentials. Two questions follow from that, and they are entangled.

**When is the credential signed?** Either on every read of
`GET /status-lists/{id}`, or on every write that changes a bit. Signing on read
means the public, unauthenticated endpoint invokes a key on every request —
latency, a denial-of-service surface pointed at the signer, and, once signing
is a call to a provisioned `dcc-signing-service`, a remote dependency on the
one endpoint that must never be down. It also introduces staleness the service
cannot reason about: what a verifier sees depends on cache behavior rather than
on when the flip happened.

**Where do the rows live?** The benchmark, DCC's `status-service-db`, requires
a MongoDB replica set. This service has to run three ways: in tests, on a
laptop and behind ngrok during the Certree campaign, and in the deployed
monorepo wrapper. Those pull in different directions — the first wants no
process at all, the second wants zero dependencies but real durability (a list
URL issued mid-campaign has to keep resolving after a restart), and the third
wants the Postgres the rest of the platform already runs.

The obvious answer to the third question — write a SQLite backend and a
Postgres backend — is two implementations of an interface whose hardest
invariant is transactional. They would drift, and the drift would show up as a
lost bit flip in exactly one of them.

## Decision

**Sign on update.** Every state change decodes the bitstring, sets the bit,
re-encodes, re-signs, and stores the bits and the credential together inside
one transaction. `GET /status-lists/{id}` is a pure read of stored bytes and
never touches a key. A redundant write — the bit already holds the requested
value — returns without materializing anything, so no new signature and no new
version.

**One `StorageService`, two implementations.** `MemoryStorage` for tests and
throwaway runs, and `SqlStorage`: a single [Kysely](https://kysely.dev)
implementation whose dialect is chosen by configuration — better-sqlite3 on a
file for local and ngrok runs, `pg` for the deployment. One schema, one set of
queries, migrations by Kysely's migrator at startup.

Supporting choices inside that:

- **JSON in `text` columns, timestamps as ISO-8601 strings.** Nothing queries
  into a document, and one column type means one mapping function rather than a
  driver-dependent pair.
- **Serialization is the database's job.** `updateStatusList` opens a
  transaction and holds the list row for its duration — `select … for update`
  on Postgres, and on SQLite the single synchronous writer that better-sqlite3
  already is.
- **Allocation invariants are constraints, not checks.** A primary key on
  `(list_id, status_list_index)` and a unique key on
  `(tenant_id, credential_id, status_purpose)`. The random-index allocator
  probes, and loses races to the database rather than to a read-then-write
  window.
- **In-memory storage is refused when `NODE_ENV=production`**, alongside the
  existing refusal of the fake signer.

## Consequences

- A bit flip is visible the instant `POST /credentials/status` returns, with no
  staleness inside the service. That is what makes behavioural revocation
  testing (Certree Dim-3) observable, and it leaves HTTP cache posture as the
  only remaining variable.
- The public GET is cheap and keyless. It can sit behind a CDN, which BSL §6.4
  explicitly endorses, and a flood of status checks cannot reach the signer.
- Signing happens inside a database transaction. With in-process signing that
  is microseconds; with a future `SIGNING_MODE=http` it is a network call
  holding a row lock. Per-list, not global — but it is the cost of the
  guarantee, and it is the reason the lock is on one row.
- Re-signing on every flip costs one signature per state change instead of one
  per read. For status lists, writes are rare and reads are not.
- SQLite and Postgres cannot drift, because there is nothing to drift: the same
  queries run on both, and the storage contract suite runs against every
  implementation, Postgres included when `TEST_DATABASE_URL` names a database.
- Kysely is a new dependency and a real commitment — the schema, the
  migrations and the query surface are all expressed in it. It earns that by
  being the thing that makes one implementation possible; the alternative was
  two.
- A dialect Kysely does not support is a dialect we do not support. That is
  acceptable: the two we need are the two that exist.
