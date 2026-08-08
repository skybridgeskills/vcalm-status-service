# vc-signer is a workspace package consumed by git, not by npm

Date: 2026-08-08

Status: accepted

## Context

Signing is needed in more than one place. This service signs status list
credentials on every update, and `dcc-signing-service` — our fork, which today
carries its own `src/issue.js` plus a hand-rolled suite registry — needs the
same three cryptosuites, the same key material handling, and the same did:key
and did:web derivation. Two implementations of that would drift, and the one
that drifts is always the one that is not under test.

So the signing module is a package. Where the package lives is the open
question, and the options were: a directory inside this service, a package
inside `dcc-signing-service`, a standalone repository both depend on, or a
package published to npm.

Skybridge has no npm organization, and setting one up carries ongoing cost:
release process, versioning discipline, credentials in CI, and a public promise
about a package whose only consumers are ours.

## Decision

`@skybridgeskills/vc-signer` is a package in this repository's pnpm workspace
(`packages/vc-signer`), and it is never published to a registry.

- Inside this repo, the service depends on it as `workspace:*`.
- Outside this repo, consumers take it as a pnpm git dependency:
  `github:skybridgeskills/vcalm-status-service#path:packages/vc-signer`.
- The package carries a `prepare` script, so `dist/` is built during install
  for git consumers, who get no prebuilt artifact.
- The scoped name is aspirational. It exists so that publishing later is a
  decision about a registry, not a rename with a migration.

The package's public type surface is deliberately self-contained — its own
`UnsignedCredential`, `DidDocument` and key material types rather than
re-exported library types — so a git consumer compiles against it without
inheriting our dependency graph's type packages.

## Consequences

- One implementation of signing, one test matrix, and `dcc-signing-service`'s
  upgrade becomes "delete `src/suites/`, depend on this" rather than a parallel
  port.
- Consumers pin by git ref. That is coarser than semver: a breaking change to
  the package is visible to us only when a consumer bumps its ref. Consumers
  should pin a tag or commit, not a branch.
- Git consumers must be able to build TypeScript at install time, which means
  the `prepare` script and its dev dependencies have to keep working. If that
  proves flaky in a consumer's CI, the fallbacks are GitHub Packages or
  promotion to a standalone repo — both mechanical, because the package
  boundary already exists.
- This repository is now a workspace, so the container build installs and
  builds from the repo root via `pnpm --filter`. That was already true after
  the scaffold and does not change with this decision.
- Publishing to npm remains available later. Nothing in the package assumes it
  is private, and `publishConfig.access` is set to `restricted` so an
  accidental `pnpm publish` cannot make it public by default.
