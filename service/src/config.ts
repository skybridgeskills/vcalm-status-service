import { z } from 'zod'

/**
 * Configuration is parsed and validated once, from the environment, at
 * startup. Every sub-parser takes `env` as a parameter so it can be unit
 * tested without mutating `process.env`.
 */

export type NodeEnv = 'development' | 'test' | 'production'
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * Backend selection. Each mode names an implementation of the matching
 * interface; adding one is a new enum member plus a case in the factory.
 */
export type StorageMode = 'memory' | 'sqlite' | 'postgres'
export type SigningMode = 'fake' | 'local'
export type TenantRegistryMode = 'memory'

/**
 * Storage carries what its backend needs to connect, so nothing downstream
 * reads the environment again. `sqlite` and `postgres` are one implementation
 * over two dialects, not two backends.
 */
export type StorageConfig =
  | { mode: 'memory' }
  | { mode: 'sqlite'; file: string }
  | { mode: 'postgres'; url: string }

export interface Config {
  nodeEnv: NodeEnv
  port: number
  /**
   * Origin the service is reachable at. Canonical list URLs are
   * `{publicBaseUrl}/status-lists/{id}` and are fixed at create time, so this
   * value is load-bearing for anything already issued — never a request-derived
   * host. Stored without a trailing slash.
   */
  publicBaseUrl: string
  logLevel: LogLevel
  storage: StorageConfig
  signing: { mode: SigningMode }
  tenantRegistry: { mode: TenantRegistryMode }
}

const DEFAULT_PORT = 4008

/** Relative to the working directory, and inside the container's volume mount. */
const DEFAULT_SQLITE_FILE = './data/status-lists.db'

/** dotenv-style loaders yield `''` for a declared-but-empty var; treat as unset. */
const withoutEmptyValues = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.trim() === '') continue
    out[key] = value
  }
  return out
}

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(DEFAULT_PORT),
  PUBLIC_BASE_URL: z.string().url().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  STORAGE_MODE: z.enum(['memory', 'sqlite', 'postgres']).default('memory'),
  SQLITE_FILE: z.string().min(1).default(DEFAULT_SQLITE_FILE),
  DATABASE_URL: z.string().min(1).optional(),
  SIGNING_MODE: z.enum(['fake', 'local']).default('fake'),
  TENANT_REGISTRY_MODE: z.enum(['memory']).default('memory')
})

type EnvValues = z.infer<typeof envSchema>

const parseStorage = (values: EnvValues): StorageConfig => {
  switch (values.STORAGE_MODE) {
    case 'memory':
      return { mode: 'memory' }
    case 'sqlite':
      return { mode: 'sqlite', file: values.SQLITE_FILE }
    case 'postgres': {
      if (values.DATABASE_URL === undefined) {
        throw new ConfigError(
          'Invalid environment configuration — STORAGE_MODE=postgres requires DATABASE_URL'
        )
      }
      return { mode: 'postgres', url: values.DATABASE_URL }
    }
  }
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

const stripTrailingSlash = (url: string): string => url.replace(/\/+$/, '')

export const parseConfig = (env: NodeJS.ProcessEnv): Config => {
  const parsed = envSchema.safeParse(withoutEmptyValues(env))
  if (!parsed.success) {
    const details = parsed.error.errors
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new ConfigError(`Invalid environment configuration — ${details}`)
  }

  const values = parsed.data

  // The fake signer produces no real proof. It exists for tests and must never
  // be the thing signing a status list a verifier will check.
  if (values.SIGNING_MODE === 'fake' && values.NODE_ENV === 'production') {
    throw new ConfigError(
      'Invalid environment configuration — SIGNING_MODE=fake is refused when NODE_ENV=production'
    )
  }

  // Canonical list URLs are baked into issued credentials forever. A process
  // that forgets its lists when it restarts breaks every one of them, so
  // in-memory storage is a test and throwaway-run backend only.
  if (values.STORAGE_MODE === 'memory' && values.NODE_ENV === 'production') {
    throw new ConfigError(
      'Invalid environment configuration — STORAGE_MODE=memory is refused when NODE_ENV=production'
    )
  }

  return {
    nodeEnv: values.NODE_ENV,
    port: values.PORT,
    publicBaseUrl: stripTrailingSlash(
      values.PUBLIC_BASE_URL ?? `http://localhost:${values.PORT}`
    ),
    logLevel: values.LOG_LEVEL,
    storage: parseStorage(values),
    signing: { mode: values.SIGNING_MODE },
    tenantRegistry: { mode: values.TENANT_REGISTRY_MODE }
  }
}

let cached: Config | undefined

/** The process-wide config, parsed on first use. */
export const getConfig = (): Config => {
  cached ??= parseConfig(process.env)
  return cached
}

/** Test seam: drops the memoized config so the next `getConfig` re-reads env. */
export const resetConfig = (): void => {
  cached = undefined
}
