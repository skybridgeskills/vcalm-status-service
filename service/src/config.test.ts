import { describe, expect, test } from 'vitest'
import { ConfigError, parseConfig } from './config.js'

describe('parseConfig', () => {
  test('runs on defaults with an empty environment', () => {
    const config = parseConfig({})
    expect(config.port).toBe(4008)
    expect(config.publicBaseUrl).toBe('http://localhost:4008')
    expect(config.nodeEnv).toBe('development')
    expect(config.logLevel).toBe('info')
    expect(config.storage.mode).toBe('memory')
    expect(config.tenantRegistry.mode).toBe('memory')
  })

  test('derives the default public base URL from the configured port', () => {
    expect(parseConfig({ PORT: '9999' }).publicBaseUrl).toBe(
      'http://localhost:9999'
    )
  })

  test('normalizes a trailing slash off the public base URL', () => {
    const config = parseConfig({ PUBLIC_BASE_URL: 'https://status.example/' })
    expect(config.publicBaseUrl).toBe('https://status.example')
  })

  test('treats an empty value as unset rather than invalid', () => {
    expect(parseConfig({ PORT: '   ', PUBLIC_BASE_URL: '' }).port).toBe(4008)
  })

  test('rejects a port that is not a valid TCP port', () => {
    expect(() => parseConfig({ PORT: 'http' })).toThrow(ConfigError)
    expect(() => parseConfig({ PORT: '70000' })).toThrow(/PORT/)
  })

  test('rejects a public base URL that is not a URL', () => {
    expect(() => parseConfig({ PUBLIC_BASE_URL: 'status.example' })).toThrow(
      /PUBLIC_BASE_URL/
    )
  })

  test('rejects an unknown backend mode instead of falling back', () => {
    expect(() => parseConfig({ STORAGE_MODE: 'mongo' })).toThrow(/STORAGE_MODE/)
  })

  test('refuses the fake signer in production', () => {
    expect(() =>
      parseConfig({ NODE_ENV: 'production', SIGNING_MODE: 'fake' })
    ).toThrow(/SIGNING_MODE=fake/)
  })

  test('accepts the real in-process signer, in production too', () => {
    expect(
      parseConfig({
        NODE_ENV: 'production',
        SIGNING_MODE: 'local',
        STORAGE_MODE: 'sqlite'
      }).signing.mode
    ).toBe('local')
  })

  test('refuses storage that forgets its lists in production', () => {
    expect(() =>
      parseConfig({ NODE_ENV: 'production', SIGNING_MODE: 'local' })
    ).toThrow(/STORAGE_MODE=memory/)
  })

  test('carries the sqlite file, defaulted for a plain docker run', () => {
    expect(parseConfig({ STORAGE_MODE: 'sqlite' }).storage).toEqual({
      mode: 'sqlite',
      file: './data/status-lists.db'
    })
    expect(
      parseConfig({ STORAGE_MODE: 'sqlite', SQLITE_FILE: '/srv/lists.db' })
        .storage
    ).toEqual({ mode: 'sqlite', file: '/srv/lists.db' })
  })

  test('carries the postgres DSN, and refuses the mode without one', () => {
    expect(
      parseConfig({
        STORAGE_MODE: 'postgres',
        DATABASE_URL: 'postgres://localhost/status'
      }).storage
    ).toEqual({ mode: 'postgres', url: 'postgres://localhost/status' })
    expect(() => parseConfig({ STORAGE_MODE: 'postgres' })).toThrow(
      /DATABASE_URL/
    )
  })
})
