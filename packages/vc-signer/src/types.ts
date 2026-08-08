/**
 * Public type surface for `@skybridgeskills/vc-signer` — the contract that both
 * the status service and (later) `dcc-signing-service` build against.
 */

/**
 * A credential as handed to the signer: a VCDM 1.1 or 2.0 credential with no
 * proof attached. Kept structurally loose on purpose — the signer validates
 * only what it must (`issuer`) and leaves credential shape to the caller.
 */
export interface UnsignedCredential {
  '@context': string | (string | Record<string, unknown>)[]
  id?: string
  type: string | string[]
  issuer: string | { id: string; [key: string]: unknown }
  [key: string]: unknown
}

/** An {@link UnsignedCredential} with at least one proof attached. */
export interface VerifiableCredential extends UnsignedCredential {
  proof: Record<string, unknown> | Record<string, unknown>[]
}

/**
 * Cryptosuites this module signs with. `Ed25519Signature2020` is legacy and
 * exists so `dcc-signing-service` keeps byte-compatible behavior after it
 * adopts this module; new issuance should use a Data Integrity suite.
 */
export type Cryptosuite =
  | 'eddsa-rdfc-2022'
  | 'ecdsa-rdfc-2019'
  | 'Ed25519Signature2020'

/** Key families backing the supported cryptosuites. */
export type KeyFamily = 'ed25519' | 'p256'

/**
 * Key material for a signer.
 *
 * Ed25519 accepts a multibase seed so existing `TENANT_SEED_*` values keep
 * working. ECDSA has no deterministic seed derivation in the stack we build
 * on, so P-256 material is generated once and persisted at provisioning time —
 * and both halves are persisted, because the WebCrypto import path cannot
 * recover a P-256 public key from the secret multikey alone.
 */
export type KeyMaterial =
  | { kind: 'ed25519-seed'; seed: string }
  | {
      kind: 'multikey'
      publicKeyMultibase: string
      secretKeyMultibase: string
    }

export type DidMethod = 'key' | 'web'

/**
 * A DID document, kept minimal on purpose so the published type surface stays
 * self-contained for git-dependency consumers.
 */
export interface DidDocument {
  id: string
  [key: string]: unknown
}

export interface SignerConfig {
  keyMaterial: KeyMaterial
  didMethod: DidMethod
  /** Required when `didMethod` is `web`; ignored for `did:key`. */
  didUrl?: string
  cryptosuite: Cryptosuite
}

export interface Signer {
  did: string
  verificationMethod: string
  /**
   * The signer's DID document. For `did:web` this is the document that must be
   * published at `didUrl`; provisioning writes it out, and nothing else can
   * derive it once the process exits.
   */
  didDocument: DidDocument
  signCredential(
    unsigned: UnsignedCredential,
    opts?: { now?: Date }
  ): Promise<VerifiableCredential>
}

/**
 * A live key pair as produced by the `@interop` key suites: enough of the
 * shape for suite construction, without re-exporting their type surface.
 */
export interface SigningKeyPair {
  id?: string
  controller?: string
  signer(): unknown
}

export interface SuiteOptions {
  keyPair: SigningKeyPair
  verificationMethod: string
  /** Pins `proof.created`; the suites default it to now when absent. */
  date?: Date
}

/**
 * Per-suite metadata, carried over from the DCC suite plugin contract
 * (`createSuite` / `getRequiredContexts` / `getProofType`) and typed.
 */
export interface CryptosuiteDescriptor {
  cryptosuite: Cryptosuite
  /** Value of `proof.type` produced by the suite. */
  proofType: 'DataIntegrityProof' | 'Ed25519Signature2020'
  keyFamily: KeyFamily
  /**
   * Contexts a credential must declare for this proof to be canonicalizable.
   * VCDM 2.0 (`https://www.w3.org/ns/credentials/v2`) already defines these
   * terms, but declaring them again is harmless, so they are injected either
   * way rather than making injection depend on the credential's model version.
   */
  requiredContexts: string[]
  /** Builds the linked-data proof suite this cryptosuite signs with. */
  createSuite(options: SuiteOptions): unknown
}
