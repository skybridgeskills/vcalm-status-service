/**
 * Ambient declarations for the Digital Bazaar suite packages, which ship no
 * types. Only the members this module actually uses are declared, so a wrong
 * call site still fails to compile.
 *
 * The `@interop/*` packages are TypeScript and need nothing here.
 */

declare module '@digitalbazaar/data-integrity' {
  export class DataIntegrityProof {
    constructor(options: {
      signer?: unknown
      cryptosuite: unknown
      date?: Date | string
      legacyContext?: boolean
    })
  }
}

declare module '@digitalbazaar/eddsa-rdfc-2022-cryptosuite' {
  export const cryptosuite: unknown
}

declare module '@digitalbazaar/ecdsa-rdfc-2019-cryptosuite' {
  export const cryptosuite: unknown
}

declare module '@digitalbazaar/ed25519-signature-2020' {
  export class Ed25519Signature2020 {
    constructor(options?: {
      key?: unknown
      signer?: unknown
      verificationMethod?: string
      date?: Date | string
    })
  }
}
