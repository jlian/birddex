import { afterEach, describe, expect, it, vi } from 'vitest'
import { GeocodingUpstreamError, reverseGeocode, searchPlaces } from './geocoding-gateway'
import type { Logger } from './log'

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type BoundStatement = {
  sql: string
  values: unknown[]
}

class MemoryD1 {
  private cache = new Map<string, { response: string; expiresAt: number }>()
  private inflight = new Map<string, { ownerId: string; expiresAt: number }>()
  private nextAllowedAt = 0

  seedExpired(cacheKey: string, expiresAt: number) {
    this.cache.set(cacheKey, { response: '{}', expiresAt })
    this.inflight.set(cacheKey, { ownerId: 'expired-owner', expiresAt })
  }

  delayUpstreamUntil(timestamp: number) {
    this.nextAllowedAt = timestamp
  }

  seedInflightCache(response: unknown, expiresAt: number) {
    const cacheKey = this.inflight.keys().next().value as string | undefined
    if (!cacheKey) throw new Error('No in-flight geocoding request')
    this.cache.set(cacheKey, { response: JSON.stringify(response), expiresAt })
  }

  hasCacheKey(cacheKey: string): boolean {
    return this.cache.has(cacheKey)
  }

  hasInflightKey(cacheKey: string): boolean {
    return this.inflight.has(cacheKey)
  }

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
      if (statement.sql.startsWith('DELETE FROM geocoding_cache WHERE cacheKey IN')) {
        let changes = 0
        for (const [key, row] of [...this.cache.entries()]) {
          if (changes >= 25) break
          if (row.expiresAt <= Number(firstValue)) {
            this.cache.delete(key)
            changes++
          }
        }
        return { meta: { changes } }
      }
      if (statement.sql.startsWith('DELETE FROM geocoding_inflight WHERE cacheKey IN')) {
        let changes = 0
        for (const [key, row] of [...this.inflight.entries()]) {
          if (changes >= 25) break
          if (row.expiresAt <= Number(firstValue)) {
            this.inflight.delete(key)
            changes++
          }
        }
        return { meta: { changes } }
      }
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
      if (statement.sql.startsWith('UPDATE geocoding_inflight SET expiresAt')) {
        const existing = this.inflight.get(String(secondValue))
        if (existing?.ownerId !== String(thirdValue)) return { meta: { changes: 0 } }
        this.inflight.set(String(secondValue), {
          ownerId: existing.ownerId,
          expiresAt: Number(firstValue),
        })
        return { meta: { changes: 1 } }
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
  afterEach(() => {
    vi.useRealTimers()
  })

  it('physically deletes expired cache state without logging lookup data', async () => {
    const memory = new MemoryD1()
    memory.seedExpired('sensitive-cache-key', Date.now() - 1)
    const database = memory as unknown as D1Database
    const fetcher = vi.fn<Fetcher>(async () => Response.json([providerResult]))
    const debug = vi.fn<Logger['debug']>()
    const log = { debug } as unknown as Logger

    await searchPlaces(database, 'Green Lake', fetcher, log)

    expect(memory.hasCacheKey('sensitive-cache-key')).toBe(false)
    expect(memory.hasInflightKey('sensitive-cache-key')).toBe(false)
    expect(debug).toHaveBeenCalledWith('geocoding/cache/delete', expect.objectContaining({
      properties: { cacheRows: 1, inflightRows: 1 },
    }))
    expect(JSON.stringify(debug.mock.calls)).not.toContain('sensitive-cache-key')
    expect(JSON.stringify(debug.mock.calls)).not.toContain('Green Lake')
  })

  it('normalizes a submitted search and reuses its cached provider response', async () => {
    const database = new MemoryD1() as unknown as D1Database
    const fetcher = vi.fn<Fetcher>(async () => Response.json([providerResult]))
    const debug = vi.fn<Logger['debug']>()
    const log = { debug } as unknown as Logger

    const first = await searchPlaces(database, '  Green   Lake  ', fetcher, log)
    const second = await searchPlaces(database, 'Green Lake', fetcher, log)

    expect(fetcher).toHaveBeenCalledOnce()
    expect(String(fetcher.mock.calls[0][0])).toContain('q=Green+Lake')
    expect(first).toEqual(second)
    expect(first[0]).toMatchObject({
      label: 'Seattle, Washington',
      stateProvince: 'US-WA',
      countryCode: 'US',
    })
    expect(debug).toHaveBeenCalledTimes(2)
    expect(debug).toHaveBeenNthCalledWith(1, 'geocoding/cache/read', expect.objectContaining({
      properties: { cacheStatus: 'miss', requestType: 'search' },
    }))
    expect(debug).toHaveBeenNthCalledWith(2, 'geocoding/cache/read', expect.objectContaining({
      properties: { cacheStatus: 'hit', requestType: 'search' },
    }))
    expect(JSON.stringify(debug.mock.calls)).not.toContain('Green')
    expect(JSON.stringify(debug.mock.calls)).not.toContain('47.6801')
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

  it('keeps identical misses coalesced while waiting beyond the flight lease', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-08T00:00:00Z'))
    const memory = new MemoryD1()
    memory.delayUpstreamUntil(Date.now() + 20_000)
    const database = memory as unknown as D1Database
    const fetcher = vi.fn<Fetcher>(async () => Response.json([providerResult]))

    const first = searchPlaces(database, 'Green Lake', fetcher)
    await vi.advanceTimersByTimeAsync(16_000)
    const second = searchPlaces(database, 'Green Lake', fetcher)
    await vi.advanceTimersByTimeAsync(6_000)

    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('re-reads cache after waiting for the global upstream slot', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-08T00:00:00Z'))
    const memory = new MemoryD1()
    memory.delayUpstreamUntil(Date.now() + 5_000)
    const database = memory as unknown as D1Database
    const fetcher = vi.fn<Fetcher>(async () => Response.json([providerResult]))

    const request = searchPlaces(database, 'Green Lake', fetcher)
    await vi.advanceTimersByTimeAsync(1_000)
    memory.seedInflightCache([providerResult], Date.now() + 60_000)
    await vi.advanceTimersByTimeAsync(5_000)

    await expect(request).resolves.toHaveLength(1)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('keeps identical misses coalesced during an upstream call beyond the flight lease', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-08T00:00:00Z'))
    const database = new MemoryD1() as unknown as D1Database
    let releaseFetch: () => void = () => undefined
    const blocked = new Promise<void>(resolve => { releaseFetch = resolve })
    const fetcher = vi.fn<Fetcher>(async () => {
      await blocked
      return Response.json([providerResult])
    })

    const first = searchPlaces(database, 'Green Lake', fetcher)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(16_000)
    const second = searchPlaces(database, 'Green Lake', fetcher)
    await vi.advanceTimersByTimeAsync(250)
    expect(fetcher).toHaveBeenCalledOnce()

    releaseFetch()
    await vi.runAllTimersAsync()
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