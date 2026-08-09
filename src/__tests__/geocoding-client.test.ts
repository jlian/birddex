import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchPlaces } from '@/lib/geocoding'
import { WingDexApiError } from '@/lib/api-error'

describe('geocoding client', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('aborts a stalled Worker request after six seconds', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    ))
    vi.stubGlobal('fetch', fetchMock)

    const request = searchPlaces('Green Lake')
    const expectation = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(6_000)
    await expectation

    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })

  it('throws a traced typed error without exposing a 5xx body or query', async () => {
    const response = new Response('provider details for Green Lake', {
      status: 502,
      headers: {
        'Content-Type': 'text/plain',
        'X-Trace-Id': 'abcdef0123456789abcdef0123456789',
      },
    })
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response)
    vi.stubGlobal('fetch', fetchMock)

    const error = await searchPlaces('Green Lake').catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(WingDexApiError)
    expect(error).toMatchObject({
      status: 502,
      traceId: 'abcdef0123456789abcdef0123456789',
      message: 'Geocoding request failed (HTTP 502)',
    })
    expect(response.bodyUsed).toBe(false)
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers)
    expect(headers.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
  })
})