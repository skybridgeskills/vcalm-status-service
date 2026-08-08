import { issue } from '@interop/vc'
import {
  assertCredentialContext,
  assertIssuerMatches,
  withRequiredContexts
} from './credential.js'
import { getCryptosuite } from './cryptosuites.js'
import { deriveDid } from './did.js'
import { createDocumentLoader } from './document-loader.js'
import { loadKeyPair } from './key-material.js'
import type {
  Signer,
  SignerConfig,
  UnsignedCredential,
  VerifiableCredential
} from './types.js'

/**
 * Builds a signer for one key: resolves the cryptosuite, loads the key
 * material, derives the DID, and returns something that signs credentials.
 *
 * Key derivation is the expensive part and happens once here — callers memoize
 * the returned signer per issuer instance. Everything that can fail on
 * configuration fails now, not on the first credential.
 */
export const createSigner = async (config: SignerConfig): Promise<Signer> => {
  const descriptor = getCryptosuite(config.cryptosuite)
  const keyPair = await loadKeyPair(config.keyMaterial, config.cryptosuite)
  const { did, didDocument, assertionKey } = await deriveDid({
    keyPair,
    keyFamily: descriptor.keyFamily,
    didMethod: config.didMethod,
    didUrl: config.didUrl
  })
  const documentLoader = createDocumentLoader(didDocument)

  return {
    did,
    didDocument,
    verificationMethod: assertionKey.id,

    async signCredential(
      unsigned: UnsignedCredential,
      opts?: { now?: Date }
    ): Promise<VerifiableCredential> {
      assertIssuerMatches(unsigned, did)
      assertCredentialContext(unsigned)

      const credential = withRequiredContexts(
        unsigned,
        descriptor.requiredContexts
      )
      const suite = descriptor.createSuite({
        keyPair: assertionKey,
        verificationMethod: assertionKey.id,
        date: opts?.now
      })

      const signed = await issue({
        // The `@interop/vc` signature is typed against its own credential
        // model; ours is deliberately looser, so the shapes meet here.
        credential: credential as never,
        suite: suite as never,
        documentLoader: documentLoader as never,
        ...(opts?.now ? { now: opts.now } : {})
      })
      return signed as unknown as VerifiableCredential
    }
  }
}
