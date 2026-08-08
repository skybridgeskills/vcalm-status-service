import type { VerifiableCredential } from '@skybridgeskills/vc-signer'
import type { IssuerInstance } from '../services/issuer-instance.js'
import type { NewStatusListRecord } from '../services/storage.js'
import type { TenantRecord } from '../services/tenants.js'

/** The all-zero 131,072-bit list from the BSL spec examples. */
export const EMPTY_ENCODED_LIST =
  'uH4sIAAAAAAAAA-3BMQEAAADCoPVPbQwfoAAAAAAAAAAAAAAAAAAAAIC3AYbSVKsAQAAA'

export const testIssuerInstance = (
  overrides: Partial<IssuerInstance> = {}
): IssuerInstance => ({
  id: 'default',
  cryptosuite: 'eddsa-rdfc-2022',
  didMethod: 'key',
  ...overrides
})

export const testTenant = (
  overrides: Partial<TenantRecord> = {}
): TenantRecord => ({
  tenantId: 'acme',
  tokens: ['acme-token'],
  issuerInstances: [testIssuerInstance()],
  defaultInstanceId: 'default',
  ...overrides
})

export const testStatusListCredential = (
  id: string,
  issuer = 'did:example:default'
): VerifiableCredential => ({
  '@context': ['https://www.w3.org/ns/credentials/v2'],
  id,
  type: ['VerifiableCredential', 'BitstringStatusListCredential'],
  issuer,
  validFrom: '2026-08-08T00:00:00Z',
  credentialSubject: {
    id: `${id}#list`,
    type: 'BitstringStatusList',
    statusPurpose: 'revocation',
    encodedList: EMPTY_ENCODED_LIST
  },
  proof: { type: 'FakeProof', proofValue: 'z0' }
})

export const testStatusList = (
  overrides: Partial<NewStatusListRecord> = {}
): NewStatusListRecord => {
  const id = overrides.id ?? 'list-1'
  return {
    id,
    tenantId: 'acme',
    issuerInstanceId: 'default',
    statusPurpose: 'revocation',
    characteristics: { length: 131072, statusSize: 1 },
    encodedList: EMPTY_ENCODED_LIST,
    signedCredential: testStatusListCredential(
      `https://status.example/status-lists/${id}`
    ),
    ...overrides
  }
}
