import { FakeSigningService } from './signing-fake.js'
import { HttpSigningService } from './signing-http.js'
import { LocalSigningService } from './signing-local.js'
import { MemoryStorage } from './storage-memory.js'
import { SqlStorage } from './storage-sql.js'
import { EnvTenantRegistry } from './tenants-env.js'
import { MemoryTenantRegistry } from './tenants-memory.js'
import { StatusListManager } from '../status-lists/index.js'
import type { Config } from '../config.js'
import type { Logger } from '../logger.js'
import type { SigningService } from './signing.js'
import type { StorageService } from './storage.js'
import type { TenantRegistry } from './tenants.js'

export interface Services {
  storage: StorageService
  signing: SigningService
  tenants: TenantRegistry
  /** The domain layer the routes talk to, over the three services above. */
  statusLists: StatusListManager
}

const unreachable = (mode: never, kind: string): never => {
  throw new Error(`Unsupported ${kind} mode: ${String(mode)}`)
}

const createStorage = (config: Config): StorageService => {
  switch (config.storage.mode) {
    case 'memory':
      return new MemoryStorage()
    case 'sqlite':
      return new SqlStorage({ dialect: 'sqlite', file: config.storage.file })
    case 'postgres':
      return new SqlStorage({ dialect: 'postgres', url: config.storage.url })
    default:
      return unreachable(config.storage, 'storage')
  }
}

const createSigning = (config: Config): SigningService => {
  switch (config.signing.mode) {
    case 'fake':
      return new FakeSigningService()
    case 'local':
      return new LocalSigningService()
    case 'http':
      return new HttpSigningService({ url: config.signing.url })
    default:
      return unreachable(config.signing, 'signing')
  }
}

const createTenantRegistry = (config: Config): TenantRegistry => {
  switch (config.tenantRegistry.mode) {
    case 'memory':
      return new MemoryTenantRegistry()
    case 'env':
      return new EnvTenantRegistry()
    default:
      return unreachable(config.tenantRegistry.mode, 'tenant registry')
  }
}

/** Builds the service graph from config. Nothing else selects an implementation. */
export const createServices = (config: Config, logger?: Logger): Services => {
  const storage = createStorage(config)
  const signing = createSigning(config)
  const tenants = createTenantRegistry(config)
  const services: Services = {
    storage,
    signing,
    tenants,
    statusLists: new StatusListManager({
      storage,
      signing,
      tenants,
      publicBaseUrl: config.publicBaseUrl
    })
  }
  logger?.info('services configured', {
    storage: config.storage.mode,
    signing: config.signing.mode,
    tenantRegistry: config.tenantRegistry.mode
  })
  return services
}

export { FakeSigningService } from './signing-fake.js'
export { HttpSigningService } from './signing-http.js'
export { LocalSigningService } from './signing-local.js'
export { MemoryStorage } from './storage-memory.js'
export { SqlStorage } from './storage-sql.js'
export { EnvTenantRegistry, parseTenantsFromEnv } from './tenants-env.js'
export { MemoryTenantRegistry } from './tenants-memory.js'
export { SigningServiceError, credentialIssuerId } from './signing.js'
export {
  MINIMUM_LIST_LENGTH,
  STATUS_PURPOSES,
  StorageError
} from './storage.js'
export { resolveIssuerInstance } from './tenants.js'
export type { SigningServiceErrorCode } from './signing.js'
export type { SqlStorageOptions } from './storage-sql.js'
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
