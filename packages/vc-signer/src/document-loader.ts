import { securityLoader } from '@interop/security-document-loader'
import { verificationMethodNodes } from './did.js'
import type { DidDocument } from './types.js'

/**
 * The document loader used while signing.
 *
 * `securityLoader` carries the credential, Data Integrity, Multikey and status
 * list contexts as static documents, so signing resolves no remote contexts.
 * On top of that, the signer's own DID document and each of its verification
 * methods are registered statically: a `did:web` identifier is only resolvable
 * once its document is published, and signing must not depend on that having
 * happened — or on the network at all.
 */
export const createDocumentLoader = (didDocument?: DidDocument): unknown => {
  const loader = securityLoader()
  if (didDocument) {
    loader.addStatic(didDocument.id, didDocument)
    for (const { id, node } of verificationMethodNodes(didDocument)) {
      loader.addStatic(id, node)
    }
  }
  return loader.build()
}
