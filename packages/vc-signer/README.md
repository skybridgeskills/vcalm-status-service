# @skybridgeskills/vc-signer

Verifiable Credential signing for Skybridge services. One module covers every
signing use case we have: given key material, a DID method and a cryptosuite,
produce a signed VC. Status list credentials are ordinary VCs to sign.

Built on `@interop/vc` plus the Digital Bazaar cryptosuite packages.
Transport-neutral by design — it throws `SigningError` with a `code` and never
an HTTP status; services map codes to ProblemDetails at their edge.

## API

```ts
import { createSigner, generateKeyMaterial } from '@skybridgeskills/vc-signer'

const signer = await createSigner({
  keyMaterial: { kind: 'ed25519-seed', seed: process.env.TENANT_SEED_ACME! },
  didMethod: 'key',
  cryptosuite: 'eddsa-rdfc-2022'
})

const signed = await signer.signCredential({
  ...credential,
  issuer: signer.did
})
```

`createSigner` does the expensive work — decoding key material, deriving the
DID — once. Callers memoize the signer per issuer instance; `signCredential` is
cheap to call repeatedly.

A signer exposes `did`, `verificationMethod`, `didDocument` and
`signCredential(credential, { now })`. `now` pins `proof.created`, so signing
the same bytes twice produces the same proof.

### Verifying

The other half, for asserting that what was signed actually verifies — a
service checking its own output, a provisioning check, an end-to-end run
against a deployed instance:

```ts
import { verifyCredential } from '@skybridgeskills/vc-signer'

const { verified, error } = await verifyCredential({ credential })
```

The suite is read off the proof, so nothing has to be told which one was used.
`did:key` resolves from the identifier itself. A `did:web` credential whose
document is not published yet is verified by supplying it:
`verifyCredential({ credential, didDocument: signer.didDocument })`.

### Cryptosuites

| Cryptosuite            | Proof type             | Key family |
| ---------------------- | ---------------------- | ---------- |
| `eddsa-rdfc-2022`      | `DataIntegrityProof`   | ed25519    |
| `ecdsa-rdfc-2019`      | `DataIntegrityProof`   | P-256      |
| `Ed25519Signature2020` | `Ed25519Signature2020` | ed25519    |

`Ed25519Signature2020` is legacy and exists so `dcc-signing-service` keeps
byte-compatible behavior after it adopts this module; new issuance should use a
Data Integrity suite.

`CRYPTOSUITES` is the registry — a new suite (`ecdsa-sd-2023`, `bbs-2023`) is a
row there plus its `createSuite` and `createVerificationSuite` implementations,
and nothing else in the module changes.

Both DID methods are supported for every suite, and every cell of that matrix
has a sign-then-verify test. `did:web` requires a `didUrl`; the document that
has to be published there is `signer.didDocument`.

### Key material

Ed25519 accepts a multibase seed, so existing `TENANT_SEED_*` values keep
working — a raw string of 32 characters or more is also accepted, matching
DCC's seed handling.

P-256 has no deterministic seed derivation in this stack, and its public key
cannot be recovered from the secret multikey through WebCrypto's import path.
So ECDSA material carries both halves, generated once at provisioning time:

```ts
const material = await generateKeyMaterial('ecdsa-rdfc-2019')
// { kind: 'multikey', publicKeyMultibase: 'zDna…', secretKeyMultibase: 'z…' }
```

`generateKeyMaterial` replaces DCC's `'generate'` magic seed value and its
`did-*-generator` endpoints: mint once, persist the result.

### What it refuses

`SigningError` carries a `code` and no HTTP status:

| Code                      | Cause                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `unsupported-cryptosuite` | A suite outside the registry                                                              |
| `invalid-key-material`    | Material the suite cannot use, an undecodable seed, `didMethod: 'web'` without a `didUrl` |
| `issuer-mismatch`         | `credential.issuer` is not the signer's DID                                               |
| `missing-context`         | `@context` does not begin with a VCDM base context                                        |
| `invalid-credential`      | A credential handed to `verifyCredential` carries no usable proof                         |

**No silent issuer mutation.** `signCredential` validates that
`credential.issuer` matches the signer DID and throws rather than rewriting it.
This is deliberately unlike DCC's `addIssuerId`, which overwrites whatever the
caller sent. Callers set the issuer from `signer.did`; the signing-service
adapter keeps its legacy overwrite by doing so before it calls.

The suite's required JSON-LD contexts _are_ added, appended after the caller's
own and deduped, on a copy — the credential you pass in comes back unsigned and
unmodified.

## Consuming this package

Inside this repo, it is a workspace dependency:

```jsonc
{ "dependencies": { "@skybridgeskills/vc-signer": "workspace:*" } }
```

Nothing is published to npm — the scoped name is aspirational. External
consumers (for example `dcc-signing-service`) take it as a pnpm git dependency
pointing at this subdirectory:

```bash
pnpm add "github:skybridgeskills/vcalm-status-service#path:packages/vc-signer"
```

The package carries a `prepare` script, so `dist/` is built during install for
git consumers. Pin a tag or commit rather than a branch — see
[the packaging ADR](../../docs/adr/2026-08-08-vc-signer-packaging.md).

Requires Node 24+, which the `@interop` libraries impose; see
[the stack ADR](../../docs/adr/2026-08-08-interop-credential-stack.md).

## License

MIT. See [LICENSE.md](../../LICENSE.md) at the repo root.
