import { describe, expect, it } from 'vitest'
import { assertWingDexApiResponse, extractTraceId, getWingDexApiErrorMessage, WingDexApiError } from '../lib/api-error'

describe('WingDex API errors', () => {
  it('extracts and normalizes a valid trace ID', () => {
    const response = new Response(null, {
      headers: { 'X-Trace-Id': 'ABCDEF0123456789ABCDEF0123456789' },
    })

    expect(extractTraceId(response)).toBe('abcdef0123456789abcdef0123456789')
  })

  it.each([
    'not-a-trace-id',
    '00000000000000000000000000000000',
    'abcdef0123456789abcdef0123456789-injected',
  ])('rejects an invalid trace ID: %s', (traceId) => {
    const response = new Response(null, { headers: { 'X-Trace-Id': traceId } })
    expect(extractTraceId(response)).toBeUndefined()
  })

  it('throws a typed error with a bounded plain-text 4xx message', async () => {
    const response = new Response('  Invalid input\nPlease try again.  ', {
      status: 400,
      statusText: 'Bad Request',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Trace-Id': 'abcdef0123456789abcdef0123456789',
      },
    })

    const error = await assertWingDexApiResponse(response).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(WingDexApiError)
    expect(error).toMatchObject({
      status: 400,
      statusText: 'Bad Request',
      traceId: 'abcdef0123456789abcdef0123456789',
      message: 'Invalid input Please try again.',
    })
  })

  it('does not read or expose a 5xx response body', async () => {
    const response = new Response('database secret', {
      status: 500,
      statusText: 'Internal Server Error',
      headers: { 'Content-Type': 'text/plain' },
    })

    await expect(assertWingDexApiResponse(response, 'Import failed')).rejects.toMatchObject({
      message: 'Import failed (HTTP 500)',
      status: 500,
    })
    expect(response.bodyUsed).toBe(false)
  })

  it('discards oversized and non-plain-text 4xx bodies', async () => {
    const oversized = new Response('x'.repeat(513), {
      status: 422,
      headers: { 'Content-Type': 'text/plain' },
    })
    const json = Response.json({ error: 'raw details' }, { status: 400 })

    await expect(assertWingDexApiResponse(oversized, 'Preview failed')).rejects.toThrow('Preview failed (HTTP 422)')
    await expect(assertWingDexApiResponse(json)).rejects.toThrow('Request failed (HTTP 400)')
  })

  it('returns normally for successful responses', async () => {
    await expect(assertWingDexApiResponse(new Response(null, { status: 204 }))).resolves.toBeUndefined()
  })

  it('does not surface arbitrary non-API error messages', () => {
    expect(getWingDexApiErrorMessage(new Error('sensitive query value'), 'Please try again.')).toBe('Please try again.')
  })
})