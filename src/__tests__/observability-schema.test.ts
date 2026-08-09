import { describe, expect, it, vi } from 'vitest'
import { createLogger, createRouteResponder, requestCompletionLevel, RESULT_DESCRIPTION_HEADER, RESULT_TYPE_HEADER } from '../../functions/lib/log'

describe('createLogger schema', () => {
  function captureLogs(fn: (log: ReturnType<typeof createLogger>) => void, logLevel = 'debug'): unknown[] {
    const out: unknown[] = []
    const spyLog = vi.spyOn(console, 'log').mockImplementation((s: string) => { out.push(JSON.parse(s)) })
    const spyErr = vi.spyOn(console, 'error').mockImplementation((s: string) => { out.push(JSON.parse(s)) })
    try {
      const log = createLogger({ env: { LOG_LEVEL: logLevel }, traceId: 'trace123', spanId: 'span456', userId: 'u1', identity: { authMethod: 'session' } })
      fn(log)
    } finally {
      spyLog.mockRestore()
      spyErr.mockRestore()
    }
    return out
  }

  it('emits the required envelope fields', () => {
    const [entry] = captureLogs(log => log.info('foo/bar/read', { category: 'Application', resultType: 'Succeeded', resultSignature: 200 }))
    expect(entry).toMatchObject({
      level: 'Info',
      traceId: 'trace123',
      spanId: 'span456',
      operationName: 'foo/bar/read',
      category: 'Application',
      userId: 'u1',
      resultType: 'Succeeded',
      resultSignature: 200,
      identity: { authMethod: 'session' },
    })
    expect(typeof (entry as { time: string }).time).toBe('string')
  })

  it('omits resultDescription, durationMs, properties when absent', () => {
    const [entry] = captureLogs(log => log.info('foo/bar/read', { category: 'Application', resultType: 'Succeeded', resultSignature: 200 }))
    expect(entry).not.toHaveProperty('resultDescription')
    expect(entry).not.toHaveProperty('durationMs')
    expect(entry).not.toHaveProperty('properties')
  })

  it('omits the empty properties bag', () => {
    const [entry] = captureLogs(log => log.info('foo/bar/read', { category: 'Application', resultType: 'Succeeded', resultSignature: 200, properties: {} }))
    expect(entry).not.toHaveProperty('properties')
  })

  it('Info is emitted at info level (production default)', () => {
    const out = captureLogs(log => log.info('foo/bar/read'), 'info')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ level: 'Info' })
  })

  it('Debug is gated - not emitted at info level', () => {
    const out = captureLogs(log => log.debug('foo/bar/read'), 'info')
    expect(out).toHaveLength(0)
  })

  it('Debug is emitted at debug level', () => {
    const out = captureLogs(log => log.debug('foo/bar/read'), 'debug')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ level: 'Debug' })
  })

  it('Trace is gated - not emitted at debug level', () => {
    const out = captureLogs(log => log.trace('foo/bar/read'), 'debug')
    expect(out).toHaveLength(0)
  })

  it('Trace is emitted at trace level', () => {
    const out = captureLogs(log => log.trace('foo/bar/read'), 'trace')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ level: 'Trace' })
  })

  it('Warning and Error always emit even at info level', () => {
    const out = captureLogs(log => {
      log.warn('foo/bar/read', { category: 'Application' })
      log.error('foo/bar/read', { category: 'Application' })
    }, 'info')
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ level: 'Warning' })
    expect(out[1]).toMatchObject({ level: 'Error' })
  })

  it('routes errors to console.error', () => {
    const errs: unknown[] = []
    const spyLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    const spyErr = vi.spyOn(console, 'error').mockImplementation((s: string) => { errs.push(JSON.parse(s)) })
    try {
      const log = createLogger({ env: {}, traceId: 't', spanId: 's' })
      log.error('foo/bar/read', { category: 'Application', resultType: 'Failed', resultSignature: 500, resultDescription: 'boom' })
    } finally {
      spyLog.mockRestore()
      spyErr.mockRestore()
    }
    expect(errs).toHaveLength(1)
    expect(errs[0]).toMatchObject({ level: 'Error', resultDescription: 'boom' })
  })

  it('legacy DEBUG=1 maps to debug level', () => {
    const out: unknown[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((s: string) => { out.push(JSON.parse(s)) })
    try {
      const log = createLogger({ env: { DEBUG: '1' }, traceId: 't', spanId: 's' })
      log.debug('foo/bar/read')
      expect(out).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('withResource merges properties into all subsequent logs', () => {
    const [entry] = captureLogs(log => {
      const scoped = log.withResource({ outingId: 'outing_abc' })
      scoped.info('data/outings/write', { category: 'Application', properties: { locationName: 'Park' } })
    })
    expect(entry).toMatchObject({ properties: { outingId: 'outing_abc', locationName: 'Park' } })
  })

  it('withResourceId extends the resourceId path', () => {
    const out: unknown[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((s: string) => { out.push(JSON.parse(s)) })
    try {
      const log = createLogger({ env: { LOG_LEVEL: 'debug' }, traceId: 't', spanId: 's', resourceId: '/users/u1' })
      const scoped = log.withResourceId('outings/abc')
      scoped.info('data/outings/delete', { category: 'Application' })
    } finally {
      spy.mockRestore()
    }
    expect(out[0]).toMatchObject({ resourceId: '/users/u1/outings/abc' })
  })

  it('pretty format emits one-liner to console', () => {
    const out: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((s: string) => { out.push(s) })
    try {
      const log = createLogger({ env: { LOG_LEVEL: 'debug', LOG_FORMAT: 'pretty' }, traceId: 't', spanId: 's', userId: 'u1' })
      log.info('data/all/read', { resultSignature: 200, durationMs: 42, resultDescription: 'Fetched 5 outings' })
    } finally {
      spy.mockRestore()
    }
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('INFO')
    expect(out[0]).toContain('data/all/read')
    expect(out[0]).toContain('200')
    expect(out[0]).toContain('42ms')
    expect(out[0]).toContain('Fetched 5 outings')
    // Should NOT be JSON
    expect(out[0]).not.toContain('{')
  })
})

describe('createRouteResponder', () => {
  function captureLogs(fn: (log: ReturnType<typeof createLogger>) => void, logLevel = 'debug'): unknown[] {
    const out: unknown[] = []
    const spyLog = vi.spyOn(console, 'log').mockImplementation((s: string) => { out.push(JSON.parse(s)) })
    const spyErr = vi.spyOn(console, 'error').mockImplementation((s: string) => { out.push(JSON.parse(s)) })
    try {
      const log = createLogger({ env: { LOG_LEVEL: logLevel }, traceId: 't1', spanId: 's1' })
      fn(log)
    } finally {
      spyLog.mockRestore()
      spyErr.mockRestore()
    }
    return out
  }

  it('fail() returns a response with its middleware completion description', async () => {
    const logs: unknown[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((s: string) => { logs.push(JSON.parse(s)) })
    const spyErr = vi.spyOn(console, 'error').mockImplementation((s: string) => { logs.push(JSON.parse(s)) })
    try {
      const log = createLogger({ env: { LOG_LEVEL: 'debug' }, traceId: 't1', spanId: 's1' })
      const route = createRouteResponder(log, 'data/outings/write', 'Application')
      const response = route.fail(400, 'Invalid JSON body')
      expect(response.status).toBe(400)
      expect(response.headers.get(RESULT_DESCRIPTION_HEADER)).toBe('Invalid JSON body')
      expect(logs).toEqual([])
    } finally {
      spy.mockRestore()
      spyErr.mockRestore()
    }
  })

  it('fail() uses detail as the middleware resultDescription when provided', () => {
    let response: Response | undefined
    const entries = captureLogs(log => {
      const route = createRouteResponder(log, 'data/outings/write', 'Application')
      response = route.fail(400, 'Invalid outing', 'Outing payload missing required field: locationName')
    })
    expect(response?.headers.get(RESULT_DESCRIPTION_HEADER)).toBe(
      'Outing payload missing required field: locationName',
    )
    expect(entries).toEqual([])
  })

  it('fail() leaves 5xx severity to middleware', () => {
    let response: Response | undefined
    const entries = captureLogs(log => {
      const route = createRouteResponder(log, 'birdId/identify/invoke', 'Application')
      response = route.fail(500, 'Server error')
    })
    expect(response?.status).toBe(500)
    expect(response?.headers.get(RESULT_DESCRIPTION_HEADER)).toBe('Server error')
    expect(entries).toEqual([])
  })

  it('info() emits with bound operationName and category', () => {
    const [entry] = captureLogs(log => {
      const route = createRouteResponder(log, 'data/clear/delete', 'Audit')
      route.info('Deleted all data')
    })
    expect(entry).toMatchObject({
      level: 'Info',
      operationName: 'data/clear/delete',
      category: 'Audit',
      resultDescription: 'Deleted all data',
    })
  })

  it('debug() emits with properties', () => {
    const [entry] = captureLogs(log => {
      const route = createRouteResponder(log, 'data/dex/read', 'Application')
      route.debug('Fetched dex', { count: 42 })
    })
    expect(entry).toMatchObject({
      level: 'Debug',
      operationName: 'data/dex/read',
      properties: { count: 42 },
    })
  })

  it('failWithHeaders() returns Response with custom headers', () => {
    const logs: unknown[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((s: string) => { logs.push(JSON.parse(s)) })
    const spyErr = vi.spyOn(console, 'error').mockImplementation((s: string) => { logs.push(JSON.parse(s)) })
    try {
      const log = createLogger({ env: { LOG_LEVEL: 'debug' }, traceId: 't1', spanId: 's1' })
      const route = createRouteResponder(log, 'birdId/identify/invoke', 'Application')
      const response = route.failWithHeaders(429, 'Rate limited', { 'Retry-After': '60' })
      expect(response.status).toBe(429)
      expect(response.headers.get('Retry-After')).toBe('60')
    } finally {
      spy.mockRestore()
      spyErr.mockRestore()
    }
  })

  it('complete() attaches terminal outcome detail without immediate logs', async () => {
    const logs: unknown[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((s: string) => { logs.push(JSON.parse(s)) })
    const spyErr = vi.spyOn(console, 'error').mockImplementation((s: string) => { logs.push(JSON.parse(s)) })
    try {
      const log = createLogger({ env: { LOG_LEVEL: 'debug' }, traceId: 't1', spanId: 's1' })
      const route = createRouteResponder(log, 'export/sightings/export', 'Application')

      const jsonResponse = route.complete(Response.json({ ok: true }), 'JSON response completed')
      expect(jsonResponse.status).toBe(200)
      expect(jsonResponse.headers.get(RESULT_DESCRIPTION_HEADER)).toBe('JSON response completed')
      await expect(jsonResponse.json()).resolves.toEqual({ ok: true })

      const csvResponse = route.complete(
        new Response('a,b\n1,2\n', { headers: { 'content-type': 'text/csv; charset=utf-8' } }),
        'CSV export completed',
      )
      expect(csvResponse.headers.get('content-type')).toContain('text/csv')
      await expect(csvResponse.text()).resolves.toBe('a,b\n1,2\n')

      const emptyResponse = route.complete(new Response(null, { status: 204 }), 'No content completed')
      expect(emptyResponse.status).toBe(204)
      await expect(emptyResponse.text()).resolves.toBe('')

      const redirectResponse = route.complete(Response.redirect('https://example.com/safe', 302), 'Redirect completed')
      expect(redirectResponse.status).toBe(302)
      expect(redirectResponse.headers.get('location')).toBe('https://example.com/safe')

      expect(logs).toEqual([])
    } finally {
      spy.mockRestore()
      spyErr.mockRestore()
    }
  })

  it('complete() sanitizes and bounds terminal detail for middleware transport', () => {
    const log = createLogger({ env: { LOG_LEVEL: 'debug' }, traceId: 't1', spanId: 's1' })
    const route = createRouteResponder(log, 'test/op', 'Application')
    const response = route.complete(Response.json({ ok: true }), `Unsafe\r\nvalue 🐦 ${'x'.repeat(2_000)}`)
    const detail = response.headers.get(RESULT_DESCRIPTION_HEADER)

    expect(detail).toBeTruthy()
    expect(detail).not.toMatch(/[\r\n]/)
    expect(detail).not.toContain('🐦')
    expect(detail).toHaveLength(1_024)
  })

  it('failWithHeaders() marks semantic 302 failures via private resultType header', () => {
    const log = createLogger({ env: { LOG_LEVEL: 'debug' }, traceId: 't1', spanId: 's1' })
    const route = createRouteResponder(log, 'auth/mobileOAuth/invoke', 'Application')
    const response = route.failWithHeaders(
      302,
      '',
      { Location: 'wingdex://auth/callback?error=no_session' },
      'Mobile OAuth callback failed because no session could be resolved from callback cookies',
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('wingdex://auth/callback?error=no_session')
    expect(response.headers.get(RESULT_TYPE_HEADER)).toBe('Failed')
    expect(response.headers.get(RESULT_DESCRIPTION_HEADER)).toContain('Mobile OAuth callback failed')
  })

  it('classifies semantic redirect failures at Warning level', () => {
    expect(requestCompletionLevel(302, 'Failed')).toBe('Warning')
    expect(requestCompletionLevel(302, 'Succeeded')).toBe('Info')
    expect(requestCompletionLevel(422, 'Failed')).toBe('Warning')
    expect(requestCompletionLevel(500, 'Failed')).toBe('Error')
  })

  it('bounds and sanitizes failure details carried to middleware', () => {
    const log = createLogger({ env: { LOG_LEVEL: 'debug' }, traceId: 't1', spanId: 's1' })
    const route = createRouteResponder(log, 'test/op', 'Application')
    const response = route.fail(400, 'Invalid request', `Unsafe\r\nvalue 🐦 ${'x'.repeat(2_000)}`)
    const detail = response.headers.get('X-WingDex-Result-Description')

    expect(detail).toBeTruthy()
    expect(detail).not.toMatch(/[\r\n]/)
    expect(detail).not.toContain('🐦')
    expect(detail).toHaveLength(1_024)
  })

  it('exposes underlying logger via .log', () => {
    const log = createLogger({ env: { LOG_LEVEL: 'debug' }, traceId: 't1', spanId: 's1' })
    const route = createRouteResponder(log, 'test/op', 'Application')
    expect(route.log).toBe(log)
  })
})
