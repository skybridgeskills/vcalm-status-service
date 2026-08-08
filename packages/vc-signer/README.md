# @skybridgeskills/vc-signer

Verifiable Credential signing for Skybridge services. One module covers every
signing use case we have: given key material, a DID method and a cryptosuite,
produce a signed VC. Status list credentials are ordinary VCs to sign.

Built on `@interop/vc` plus the Digital Bazaar cryptosuite and multikey
packages. Transport-neutral by design — it throws `SigningError` with a `code`
and never an HTTP status; services map codes to ProblemDetails at their edge.

## Status

The public type surface, the cryptosuite registry and the error contract are in
place. `createSigner` / `generateKeyMaterial` land with the signing milestone;
until then this package is the contract consumers build against.

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

Supported cryptosuites: `eddsa-rdfc-2022`, `ecdsa-rdfc-2019`, and legacy
`Ed25519Signature2020`. `CRYPTOSUITES` is the registry — a new suite is a row
there plus its suite implementation.

Ed25519 accepts a multibase seed, so existing `TENANT_SEED_*` values keep
working. ECDSA (P-256) has no deterministic seed derivation in this stack:
generate multikey material once with `generateKeyMaterial` and persist it at
provisioning time.

### No silent issuer mutation

`signCredential` validates that `credential.issuer` matches the signer DID and
throws `SigningError('issuer-mismatch')` when it does not. Callers set the
issuer from `signer.did`. This is deliberately unlike DCC's `addIssuerId`,
which overwrites whatever the caller sent.

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
git consumers.

## License

MIT. See [LICENSE.md](../../LICENSE.md) at the repo root.
