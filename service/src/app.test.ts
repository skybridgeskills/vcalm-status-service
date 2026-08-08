import { beforeEach, describe, expect, test } from 'vitest'
import { testClient } from 'hono/testing'
import { createApp, type AppType } from './app.js'
import { parseConfig } from './config.js'
import { createLogger } from './logger.js'
import { createServices, type Services } from './services/index.js'

let logLines: Record<string, unknown>[]
let services: Services

const buildApp = () => {
  const config = parseConfig({})
  services = createServices(config)
  const logger = createLogger({
    write: (line) => logLines.push(JSON.parse(line) as Record<string, unknown>)
  })
  return createApp({ config, services, logger })
}

beforeEach(() => {
  logLines = []
})

describe('GET /', () => {
  test('answers with the service banner', async () => {
    const client = testClient<AppType>(buildApp())
    const response = await client.index.$get()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      message: 'vcalm-status-service status: ok.'
    })
  })
})

describe('GET /healthz', () => {
  test('is 200 and healthy when storage answers', async () => {
    const response = await buildApp().request('/healthz')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ healthy: true })
  })

  test('is 503 problem+json when storage is unreachable', async () => {
    const app = buildApp()
    services.storage.ping = async () => {
      throw new Error('connection refused')
    }
    const response = await app.request('/healthz')
    expect(response.status).toBe(503)
    expect(response.headers.get('content-type')).toContain(
      'application/problem+json'
    )
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      status: 503,
      title: 'Service Unavailable',
      healthy: false
    })
    // The backend's own message must not reach the caller.
    expect(JSON.stringify(body)).not.toContain('connection refused')
  })
})

describe('error surface', () => {
  test('an unknown route is 404 problem+json', async () => {
    const response = await buildApp().request('/status-lists/nope')
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain(
      'application/problem+json'
    )
    expect(await response.json()).toMatchObject({
      title: 'Not Found',
      status: 404
    })
  })

  test('an unexpected handler failure is a bare 500, logged but not disclosed', async () => {
    const app = buildApp()
    app.get('/boom', () => {
      throw new Error('DSN=postgres://user:secret@db/status')
    })

    const response = await app.request('/boom')
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('secret')
    expect(
      logLines.some(
        (line) => line.level === 'error' && line.msg === 'unhandled error'
      )
    ).toBe(true)
  })
})

describe('request logging', () => {
  test('logs one structured line per request with a request id', async () => {
    await buildApp().request('/')
    const request = logLines.find((line) => line.msg === 'request')
    expect(request).toMatchObject({ method: 'GET', path: '/', status: 200 })
    expect(typeof request?.requestId).toBe('string')
    expect(typeof request?.durationMs).toBe('number')
  })

  test('echoes a caller-supplied request id back and into the log', async () => {
    const response = await buildApp().request('/', {
      headers: { 'X-Request-Id': 'trace-123' }
    })
    expect(response.headers.get('x-request-id')).toBe('trace-123')
    expect(logLines.find((line) => line.msg === 'request')?.requestId).toBe(
      'trace-123'
    )
  })
})
