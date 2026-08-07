import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * Asset caching for the 61.66 MiB model bundle.
 *
 * This bug class is invisible in production: if the cache never hits, the app
 * still works perfectly and simply re-downloads 62 MiB every session. Nothing
 * throws, nothing looks wrong, the user pays. So the assertions that matter are
 * the network-call counts, not the returned bytes.
 */

import { MODEL_ASSET_URLS, MODEL_VERSION } from '../lib/bird-id-local-adapter'

// Sizes are illustrative; only the call COUNTS are asserted. The URLs come from
// the adapter rather than being retyped, so this cannot silently drift from what
// actually ships. It had already drifted once: the list still named
// occurrence-v3.bin.gz after that file was renamed to a content hash, and the
// test passed regardless because it only ever talked to its own fixtures.
const SIZES = [14386199, 25165824, 8620924, 16478112]
const FILES: Record<string, number> = Object.fromEntries(
  MODEL_ASSET_URLS.map((u, i) => [u, SIZES[i] ?? 1024]),
)
const URLS = Object.keys(FILES)
const TOTAL = Object.values(FILES).reduce((a, b) => a + b, 0)

let store: Map<string, ArrayBuffer>
let networkCalls: number

function fakeResponse(bytes: number) {
  const buf = new ArrayBuffer(bytes)
  let sent = 0
  const res = {
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k === 'content-length' ? String(bytes) : null) },
    clone: () => fakeResponse(bytes),
    arrayBuffer: async () => buf,
    body: {
      getReader: () => ({
        read: async () => {
          if (sent >= bytes) return { done: true, value: undefined }
          const n = Math.min(1 << 20, bytes - sent)
          sent += n
          return { done: false, value: new Uint8Array(n) }
        },
      }),
    },
  }
  return res
}

beforeEach(() => {
  store = new Map()
  networkCalls = 0
  vi.stubGlobal('caches', {
    open: async () => ({
      match: async (url: string) => {
        const b = store.get(url)
        return b ? fakeResponse(b.byteLength) : undefined
      },
      put: async (url: string, res: { arrayBuffer: () => Promise<ArrayBuffer> }) => {
        store.set(url, await res.arrayBuffer())
      },
    }),
    delete: async () => { store.clear(); return true },
  })
  vi.stubGlobal('fetch', async (url: string, opts?: { method?: string }) => {
    if (opts?.method === 'HEAD') return fakeResponse(FILES[url] ?? 0)
    networkCalls++
    return fakeResponse(FILES[url] ?? 1024)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('shipped asset URLs', () => {
  it('carries a version on every immutably-cached model file', () => {
    // public/_headers serves /models/* immutable for a year and the Cache API
    // is cache-first, so an unversioned model URL would pin existing users to
    // stale bytes forever. If dimensions still matched, inference would succeed
    // and return the WRONG species with no error anywhere.
    const models = MODEL_ASSET_URLS.filter(u => u.startsWith('/models/'))
    expect(models.length).toBeGreaterThan(0)
    for (const u of models) {
      expect(u).toContain('?v=' + MODEL_VERSION)
    }
  })

  it('versions the prior by content hash in the file name', () => {
    // The prior takes the other approach: its hash is IN the name, so it needs
    // no query string. Either scheme is fine; having neither is not.
    const prior = MODEL_ASSET_URLS.find(u => u.startsWith('/priors/'))
    expect(prior).toBeDefined()
    expect(prior).toMatch(/occurrence\.[0-9a-f]{8}\.bin\.gz$/)
  })
})

describe('model asset cache', () => {
  it('reports nothing cached before the first load', async () => {
    const { assetsCached } = await import('@/lib/model-cache')
    expect(await assetsCached(URLS)).toBe(false)
  })

  it('fetches every asset once on a cold load', async () => {
    const { preloadAssets } = await import('@/lib/model-cache')
    const out = await preloadAssets(URLS)
    expect(out.size).toBe(4)
    expect(networkCalls).toBe(4)
  })

  it('makes ZERO network calls on a warm load', async () => {
    const { preloadAssets } = await import('@/lib/model-cache')
    await preloadAssets(URLS)
    networkCalls = 0
    const out = await preloadAssets(URLS)
    expect(out.size).toBe(4)
    // The assertion the whole feature exists for.
    expect(networkCalls).toBe(0)
  })

  it('reports progress that only moves forward and ends at the total', async () => {
    const { preloadAssets } = await import('@/lib/model-cache')
    const seen: number[] = []
    await preloadAssets(URLS, p => seen.push(p.loaded))
    expect(seen.length).toBeGreaterThan(4)
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1])
    }
    expect(seen[seen.length - 1]).toBe(TOTAL)
  })

  it('reports the total it was given, not one probed from the network', async () => {
    // Content-Length is the COMPRESSED length while a fetch reader hands back
    // DECOMPRESSED bytes. Probing with HEAD understated the occurrence prior by
    // 7.6 MiB, so the bar saturated at 100% with a ninth of the download still
    // arriving, which is what the PR review saw.
    const { preloadAssets } = await import('@/lib/model-cache')
    const expected = TOTAL + 7_645_385
    const seen: { loaded: number; total: number }[] = []
    await preloadAssets(URLS, p => seen.push({ loaded: p.loaded, total: p.total }), expected)
    expect(seen.every(p => p.total === expected)).toBe(true)
  })

  it('sends no HEAD requests', async () => {
    let heads = 0
    vi.stubGlobal('fetch', async (url: string, opts?: { method?: string }) => {
      if (opts?.method === 'HEAD') heads++
      return fakeResponse(FILES[url] ?? 1024)
    })
    const { preloadAssets } = await import('@/lib/model-cache')
    await preloadAssets(URLS, undefined, TOTAL)
    // Four round trips per session bought a total that was wrong anyway.
    expect(heads).toBe(0)
  })

  it('still downloads when the Cache API is unavailable', async () => {
    // Some private modes and constrained webviews have no caches object at all.
    // Identification must degrade to re-downloading, not fail outright.
    vi.stubGlobal('caches', undefined)
    const { preloadAssets, assetsCached } = await import('@/lib/model-cache')
    expect(await assetsCached(URLS)).toBe(false)
    const out = await preloadAssets(URLS, undefined, TOTAL)
    expect(out.size).toBe(4)
  })

  it('still downloads when caches.open throws', async () => {
    vi.stubGlobal('caches', { open: async () => { throw new Error('storage disabled') } })
    const { preloadAssets } = await import('@/lib/model-cache')
    const out = await preloadAssets(URLS, undefined, TOTAL)
    expect(out.size).toBe(4)
  })

  it('re-downloads after the cache is cleared', async () => {
    const { preloadAssets, clearAssetCache, assetsCached } = await import('@/lib/model-cache')
    await preloadAssets(URLS)
    await clearAssetCache()
    expect(await assetsCached(URLS)).toBe(false)
    networkCalls = 0
    await preloadAssets(URLS)
    expect(networkCalls).toBe(4)
  })
})
