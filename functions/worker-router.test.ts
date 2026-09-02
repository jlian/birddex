import { afterEach, describe, expect, it, vi } from 'vitest'
import app, { createWorkerApp } from '../worker'
import { RESULT_DESCRIPTION_HEADER, RESULT_TYPE_HEADER } from './lib/log'

afterEach(() => {
  vi.restoreAllMocks()
})

function executionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  }
}

function env(): Env {
  return {
    ASSETS: { fetch: vi.fn() },
    DB: {
      prepare: vi.fn(() => ({
        first: vi.fn(async () => ({ ok: 1 })),
      })),
    },
  } as unknown as Env
}

describe('native Worker routing', () => {
  it('runs API handlers through the request middleware', async () => {
    const response = await app.request(
      'http://localhost:5000/api/health',
      undefined,
      env(),
      executionContext(),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('X-Frame-Options')).toBe('DENY')
    expect(response.headers.has('traceparent')).toBe(true)
    expect(response.headers.has(RESULT_DESCRIPTION_HEADER)).toBe(false)
    expect(response.headers.has(RESULT_TYPE_HEADER)).toBe(false)
  })

  it('keeps raw route exceptions inside the structured middleware boundary', async () => {
    const errorApp = createWorkerApp()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    errorApp.get('/api/auth/test-error', () => {
      throw new Error('private provider failure')
    })

    const response = await errorApp.request(
      'http://localhost:5000/api/auth/test-error',
      undefined,
      env(),
      executionContext(),
    )

    expect(response.status).toBe(500)
    expect(await response.text()).toBe('Internal Server Error')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.has('traceparent')).toBe(true)
    expect(consoleError).toHaveBeenCalledTimes(1)
    const [logged] = consoleError.mock.calls[0]
    expect(logged).not.toBeInstanceOf(Error)
    expect(logged).toEqual(expect.objectContaining({
      level: 'Error',
      operationName: 'auth/sessions/invoke',
      category: 'Request',
      resultType: 'Failed',
      resultSignature: 500,
      resultDescription: 'Unhandled route error; inspect the result signature and trace ID, then retry or investigate the route implementation',
    }))
  })
})
