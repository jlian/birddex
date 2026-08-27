import { describe, expect, it, vi } from 'vitest'
import {
  GeocodingConfigurationError,
  GeocodingUpstreamError,
  rateLimitKey,
  reverseGeocodeLocal,
  searchPlaces,
} from './geocoding-gateway'

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const providerResult = {
  name: 'Green Lake Park',
  formatted: 'Green Lake Park, Seattle, WA, United States of America',
  lat: 47.6801,
  lon: -122.3277,
  city: 'Seattle',
  state: 'Washington',
  state_code: 'WA',
  country_code: 'us',
}

describe('Geoapify geocoding gateway', () => {
  it('normalizes submitted searches and makes one provider request', async () => {
    const fetcher = vi.fn<Fetcher>(async () => Response.json({ results: [providerResult] }))

    const results = await searchPlaces('test-key', '  Green   Lake  ', fetcher)

    expect(fetcher).toHaveBeenCalledOnce()
    const url = new URL(String(fetcher.mock.calls[0][0]))
    expect(url.origin).toBe('https://api.geoapify.com')
    expect(url.pathname).toBe('/v1/geocode/search')
    expect(url.searchParams.get('text')).toBe('Green Lake')
    expect(url.searchParams.get('limit')).toBe('5')
    expect(url.searchParams.get('lang')).toBe('en')
    expect(url.searchParams.get('bias')).toBe('countrycode:none')
    expect(url.searchParams.get('apiKey')).toBe('test-key')
    expect(results).toEqual([expect.objectContaining({
      label: 'Green Lake Park, Seattle',
      context: 'Washington',
      stateProvince: 'US-WA',
      countryCode: 'US',
    })])
  })

  it('rejects invalid input before contacting the provider', async () => {
    const fetcher = vi.fn<Fetcher>()

    await expect(searchPlaces('test-key', 'x', fetcher)).rejects.toThrow('Invalid search query')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('requires the server-side provider key', async () => {
    await expect(searchPlaces(undefined, 'Green Lake')).rejects.toBeInstanceOf(GeocodingConfigurationError)
  })

  it('preserves provider throttling and Retry-After without exposing other statuses', async () => {
    const throttled = vi.fn<Fetcher>(async () => new Response(null, {
      status: 429,
      headers: { 'Retry-After': '3' },
    }))
    const denied = vi.fn<Fetcher>(async () => new Response(null, { status: 403 }))

    await expect(searchPlaces('test-key', 'Green Lake', throttled)).rejects.toEqual(
      new GeocodingUpstreamError(429, '3', 429),
    )
    await expect(searchPlaces('test-key', 'Green Lake', denied)).rejects.toEqual(
      new GeocodingUpstreamError(502, undefined, 403),
    )
  })

  it('maps network and malformed JSON failures to a provider-safe 502', async () => {
    const networkFailure = vi.fn<Fetcher>(async () => { throw new Error('includes secret and query') })
    const malformed = vi.fn<Fetcher>(async () => new Response('{', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const wrongShape = vi.fn<Fetcher>(async () => Response.json({ features: [] }))

    await expect(searchPlaces('test-key', 'Sensitive Place', networkFailure)).rejects.toEqual(
      new GeocodingUpstreamError(502, undefined, 0),
    )
    await expect(searchPlaces('test-key', 'Sensitive Place', malformed)).rejects.toEqual(
      new GeocodingUpstreamError(502, undefined, 200, 'search', 'unusable payload'),
    )
    await expect(searchPlaces('test-key', 'Sensitive Place', wrongShape)).rejects.toEqual(
      new GeocodingUpstreamError(502, undefined, 200, 'search', 'unusable payload'),
    )
  })

  it('aborts a provider request after five seconds', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<Fetcher>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }))

    try {
      const request = searchPlaces('test-key', 'Green Lake', fetcher)
      const expectation = expect(request).rejects.toEqual(
        new GeocodingUpstreamError(504, undefined, 0),
      )
      await vi.advanceTimersByTimeAsync(5_000)
      await expectation
      expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns empty results when the provider has no usable matches', async () => {
    const fetcher = vi.fn<Fetcher>(async () => Response.json({
      results: [{ formatted: 'Missing coordinates' }, { lat: 47, lon: -122 }],
    }))

    await expect(searchPlaces('test-key', 'Nowhere', fetcher)).resolves.toEqual([])
  })
})

describe('reverseGeocodeLocal', () => {
  // The local archive is ordered ahead of the paid provider, so the contract
  // that matters is when it declines to answer: an unconfigured bucket and an
  // empty tile must both fall through rather than fail the request.

  it('returns null when no archive is bound, so the provider still answers', () => {
    return expect(reverseGeocodeLocal(undefined, 47.68, -122.33)).resolves.toBeNull()
  })

  it('throws on a missing archive rather than silently billing the provider', async () => {
    // A bucket bound to a key that is not there is a deployment fault, not a
    // coverage gap. It must be visible; the reverse route catches it, logs a
    // warning and falls back, so the endpoint still answers.
    const bucket = { get: async () => null } as unknown as R2Bucket
    await expect(reverseGeocodeLocal(bucket, 47.68, -122.33)).rejects.toThrow(/PMTiles archive not found/)
  })
})

describe('rateLimitKey', () => {
  const request = (ip?: string) =>
    new Request('https://wingdex.test/api/geocoding/search', {
      headers: ip ? { 'cf-connecting-ip': ip } : {},
    })

  it('gives a registered account its own budget', () => {
    expect(rateLimitKey({ id: 'user-1', isAnonymous: false }, request('203.0.113.7')))
      .toBe('user:user-1')
  })

  it('shares one budget per IP across anonymous sessions', () => {
    const first = rateLimitKey({ id: 'anon-1', isAnonymous: true }, request('203.0.113.7'))
    const second = rateLimitKey({ id: 'anon-2', isAnonymous: true }, request('203.0.113.7'))
    expect(first).toBe(second)
    expect(first).toBe('ip:203.0.113.7')
  })

  it('does not fall back to a shared key when the session is missing', () => {
    expect(rateLimitKey(undefined, request('203.0.113.7'))).toBe('user:unknown')
  })

  it('still returns a key when the IP header is absent', () => {
    expect(rateLimitKey({ id: 'anon-1', isAnonymous: true }, request())).toBe('ip:unknown')
  })
})
