import { describe, expect, it, vi } from 'vitest'
import { GeocodingUpstreamError, reverseGeocode, searchPlaces } from './geocoding-gateway'

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type BoundStatement = {
  sql: string
  values: unknown[]
}

class MemoryD1 {
  private cache = new Map<string, { response: string; expiresAt: number }>()
  private inflight = new Map<string, { ownerId: string; expiresAt: number }>()
  private nextAllowedAt = 0

  prepare(sql: string) {
    const statement: BoundStatement = { sql: sql.replace(/\s+/g, ' ').trim(), values: [] }
    const bind = (...values: unknown[]) => {
      statement.values = values
      return { bind, first, run }
    }
    const first = async <T>(): Promise<T | null> => {
      const [firstValue, secondValue] = statement.values
      if (statement.sql.startsWith('SELECT response, expiresAt FROM geocoding_cache')) {
        const cached = this.cache.get(String(firstValue))
        return cached && cached.expiresAt > Number(secondValue) ? cached as T : null
      }
      if (statement.sql.startsWith('SELECT expiresAt FROM geocoding_inflight')) {
        return (this.inflight.get(String(firstValue)) || null) as T | null
      }
      if (statement.sql.startsWith('SELECT nextAllowedAt FROM geocoding_rate_limit')) {
        return { nextAllowedAt: this.nextAllowedAt } as T
      }
      throw new Error(`Unhandled first(): ${statement.sql}`)
    }
    const run = async () => {
      const [firstValue, secondValue, thirdValue, fourthValue] = statement.values
      if (statement.sql.startsWith('INSERT INTO geocoding_inflight')) {
        const key = String(firstValue)
        const existing = this.inflight.get(key)
        if (!existing || existing.expiresAt <= Number(fourthValue)) {
          this.inflight.set(key, { ownerId: String(secondValue), expiresAt: Number(thirdValue) })
          return { meta: { changes: 1 } }
        }
        return { meta: { changes: 0 } }
      }
      if (statement.sql.startsWith('UPDATE geocoding_rate_limit SET nextAllowedAt = ?1')) {
        if (this.nextAllowedAt <= Number(secondValue)) {
          this.nextAllowedAt = Number(firstValue)
          return { meta: { changes: 1 } }
        }
        return { meta: { changes: 0 } }
      }
      if (statement.sql.startsWith('UPDATE geocoding_rate_limit SET nextAllowedAt = MAX')) {
        this.nextAllowedAt = Math.max(this.nextAllowedAt, Number(firstValue))
        return { meta: { changes: 1 } }
      }
      if (statement.sql.startsWith('INSERT INTO geocoding_cache')) {
        this.cache.set(String(firstValue), { response: String(secondValue), expiresAt: Number(thirdValue) })
        return { meta: { changes: 1 } }
      }
      if (statement.sql.startsWith('DELETE FROM geocoding_inflight')) {
        const existing = this.inflight.get(String(firstValue))
        if (existing?.ownerId === String(secondValue)) this.inflight.delete(String(firstValue))
        return { meta: { changes: existing?.ownerId === String(secondValue) ? 1 : 0 } }
      }
      if (statement.sql.startsWith('DELETE FROM geocoding_cache')) {
        this.cache.delete(String(firstValue))
        return { meta: { changes: 1 } }
      }
      throw new Error(`Unhandled run(): ${statement.sql}`)
    }
    return {
      bind,
      first,
      run,
    }
  }
}

const providerResult = {
  lat: '47.6801',
  lon: '-122.3277',
  display_name: 'Green Lake, Seattle, Washington',
  address: {
    city: 'Seattle',
    state: 'Washington',
    country_code: 'us',
    'ISO3166-2-lvl4': 'US-WA',
  },
}

describe('geocoding gateway', () => {
  it('normalizes a submitted search and reuses its cached provider response', async () => {
    const database = new MemoryD1() as unknown as D1Database
    const fetcher = vi.fn<Fetcher>(async () => Response.json([providerResult]))

    const first = await searchPlaces(database, '  Green   Lake  ', fetcher)
    const second = await searchPlaces(database, 'Green Lake', fetcher)

    expect(fetcher).toHaveBeenCalledOnce()
    expect(String(fetcher.mock.calls[0][0])).toContain('q=Green+Lake')
    expect(first).toEqual(second)
    expect(first[0]).toMatchObject({
      label: 'Seattle, Washington',
      stateProvince: 'US-WA',
      countryCode: 'US',
    })
  })

  it('coalesces concurrent identical cache misses', async () => {
    const database = new MemoryD1() as unknown as D1Database
    let releaseFetch: () => void = () => undefined
    const blocked = new Promise<void>(resolve => { releaseFetch = resolve })
    const fetcher = vi.fn<Fetcher>(async () => {
      await blocked
      return Response.json([providerResult])
    })

    const first = searchPlaces(database, 'Green Lake', fetcher)
    const second = searchPlaces(database, 'Green Lake', fetcher)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    releaseFetch()

    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('preserves upstream status and Retry-After', async () => {
    const database = new MemoryD1() as unknown as D1Database
    const fetcher = vi.fn<Fetcher>(async () => new Response(null, {
      status: 429,
      headers: { 'Retry-After': '3' },
    }))

    await expect(searchPlaces(database, 'Green Lake', fetcher)).rejects.toEqual(
      new GeocodingUpstreamError(429, '3'),
    )
  })

  it('clamps nearby-search bounds at the poles and antimeridian', async () => {
    const database = new MemoryD1() as unknown as D1Database
    const fetcher = vi.fn<Fetcher>(async () => Response.json([{
      ...providerResult,
      category: 'leisure',
      type: 'park',
      name: 'Boundary Park',
    }]))

    await reverseGeocode(database, '90', '180', fetcher)

    const url = new URL(String(fetcher.mock.calls[0][0]))
    expect(url.searchParams.get('viewbox')).toBe('179.980,90.000,180.000,89.980')
  })
})