import { FakeSigningService } from './signing-fake.js'
import { MemoryStorage } from './storage-memory.js'
import { MemoryTenantRegistry } from './tenants-memory.js'
import type { Config } from '../config.js'
import type { Logger } from '../logger.js'
import type { SigningService } from './signing.js'
import type { StorageService } from './storage.js'
import type { TenantRegistry } from './tenants.js'

export interface Services {
  storage: StorageService
  signing: SigningService
  tenants: TenantRegistry
}

const unreachable = (mode: never, kind: string): never => {
  throw new Error(`Unsupported ${kind} mode: ${String(mode)}`)
}

const createStorage = (config: Config): StorageService => {
  switch (config.storage.mode) {
    case 'memory':
      return new MemoryStorage()
    default:
      return unreachable(config.storage.mode, 'storage')
  }
}

const createSigning = (config: Config): SigningService => {
  switch (config.signing.mode) {
    case 'fake':
      return new FakeSigningService()
    default:
      return unreachable(config.signing.mode, 'signing')
  }
}

const createTenantRegistry = (config: Config): TenantRegistry => {
  switch (config.tenantRegistry.mode) {
    case 'memory':
      return new MemoryTenantRegistry()
    default:
      return unreachable(config.tenantRegistry.mode, 'tenant registry')
  }
}

/** Builds the service graph from config. Nothing else selects an implementation. */
export const createServices = (config: Config, logger?: Logger): Services => {
  const services: Services = {
    storage: createStorage(config),
    signing: createSigning(config),
    tenants: createTenantRegistry(config)
  }
  logger?.info('services configured', {
    storage: config.storage.mode,
    signing: config.signing.mode,
    tenantRegistry: config.tenantRegistry.mode
  })
  return services
}

export { FakeSigningService } from './signing-fake.js'
export { MemoryStorage } from './storage-memory.js'
export { MemoryTenantRegistry } from './tenants-memory.js'
export { credentialIssuerId } from './signing.js'
export {
  MINIMUM_LIST_LENGTH,
  STATUS_PURPOSES,
  StorageError
} from './storage.js'
export { resolveIssuerInstance } from './tenants.js'
export type { IssuerInstance } from './issuer-instance.js'
export type { SigningService } from './signing.js'
export type {
  IndexAllocation,
  NewIndexAllocation,
  NewStatusListRecord,
  StatusListCharacteristics,
  StatusListMaterialization,
  StatusListMutationResult,
  StatusListRecord,
  StatusMessage,
  StatusPurpose,
  StorageErrorCode,
  StorageService
} from './storage.js'
export type { TenantRecord, TenantRegistry } from './tenants.js'
