import { driver as didKeyDriver } from '@interop/did-method-key'
import { driver as didWebDriver, getNode } from '@interop/did-web-resolver'
import * as EcdsaMultikey from '@interop/ecdsa-multikey'
import { Ed25519VerificationKey } from '@interop/ed25519-verification-key'
import { SigningError } from './errors.js'
import type {
  DidDocument,
  DidMethod,
  KeyFamily,
  SigningKeyPair
} from './types.js'

/** Multibase-multikey header for P-256 public keys. */
const P256_MULTIBASE_HEADER = 'zDna'

/**
 * Registers the key suite for a family on a DID driver. The ed25519 suite is a
 * key pair class, so the driver reads its header off the class; ECDSA is
 * registered by header because the suite spans one header per curve.
 */
const registerKeySuite = (
  driver: { use: (options: Record<string, unknown>) => void },
  keyFamily: KeyFamily
): void => {
  if (keyFamily === 'ed25519') {
    driver.use({ keyPairClass: Ed25519VerificationKey })
  } else {
    driver.use({
      multibaseMultikeyHeader: P256_MULTIBASE_HEADER,
      fromMultibase: EcdsaMultikey.from
    })
  }
}

export interface DidBinding {
  did: string
  didDocument: DidDocument
  /** The `assertionMethod` key: what signs, and what `proof` points at. */
  assertionKey: SigningKeyPair & { id: string }
}

/**
 * Derives the DID and DID document a key signs under.
 *
 * `did:key` is derived from the key alone. `did:web` is not derivable from key
 * material — the identifier is the URL — so `didUrl` is required, and the
 * returned document is what has to be published there for anyone to verify.
 */
export const deriveDid = async ({
  keyPair,
  keyFamily,
  didMethod,
  didUrl
}: {
  keyPair: SigningKeyPair
  keyFamily: KeyFamily
  didMethod: DidMethod
  didUrl?: string
}): Promise<DidBinding> => {
  if (didMethod === 'web' && !didUrl) {
    throw new SigningError(
      'invalid-key-material',
      'didUrl is required when didMethod is "web"'
    )
  }

  const driver = didMethod === 'web' ? didWebDriver() : didKeyDriver()
  registerKeySuite(driver, keyFamily)

  const { didDocument, methodFor } = await driver.fromKeyPair({
    ...(didMethod === 'web' ? { url: didUrl } : {}),
    verificationKeyPair: keyPair
  })

  const assertionKey = methodFor({ purpose: 'assertionMethod' })
  if (!assertionKey?.id) {
    throw new SigningError(
      'invalid-key-material',
      `Derived ${didDocument.id} has no assertionMethod key`
    )
  }

  return {
    did: didDocument.id,
    didDocument: didDocument as unknown as DidDocument,
    assertionKey: assertionKey as SigningKeyPair & { id: string }
  }
}

/**
 * The verification methods a DID document publishes, as standalone nodes with
 * their own `@context` — the shape a document loader has to hand back when a
 * verifier dereferences a `#fragment` key id.
 */
export const verificationMethodNodes = (
  didDocument: DidDocument
): { id: string; node: unknown }[] => {
  const methods = didDocument.verificationMethod
  if (!Array.isArray(methods)) return []
  return methods
    .filter(
      (method): method is { id: string } =>
        typeof (method as { id?: unknown })?.id === 'string'
    )
    .map((method) => ({
      id: method.id,
      node: getNode({ didDocument, id: method.id })
    }))
}
