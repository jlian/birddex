import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * Asset caching for the 56.25 MiB model bundle (MODEL_BYTES).
 *
 * This bug class is invisible in production: if the cache never hits, the app
 * still works perfectly and simply re-downloads 56 MiB every session. Nothing
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
let cacheWrites: number

function fakeResponse(bytes: number, status = 200, headers: Record<string, string> = {}) {
  const buf = new ArrayBuffer(bytes)
  let sent = 0
  const res = {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key: string) => headers[key] ?? (key === 'content-length' ? String(bytes) : null) },
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
  cacheWrites = 0
  vi.stubGlobal('caches', {
    open: async () => ({
      match: async (url: string) => {
        const b = store.get(url)
        return b ? fakeResponse(b.byteLength) : undefined
      },
      put: async (url: string, res: { arrayBuffer: () => Promise<ArrayBuffer> }) => {
        cacheWrites++
        store.set(url, await res.arrayBuffer())
      },
      // preloadAssets prunes after every run. Without these the prune threw
      // "cache.keys is not a function", was swallowed by its own try/catch,
      // and the path went untested while warning on every call.
      keys: async () =>
        [...store.keys()].map(u => ({ url: new URL(u, location.href).href })),
      delete: async (req: { url: string }) => {
        for (const k of store.keys()) {
          if (new URL(k, location.href).href === req.url) return store.delete(k)
        }
        return false
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
    expect(cacheWrites).toBe(4)
  })

  it('retries a transient network failure and caches the successful response once', async () => {
    let attempts = 0
    vi.stubGlobal('fetch', async (url: string) => {
      networkCalls++
      attempts++
      if (attempts === 1) throw new TypeError('Failed to fetch')
      return fakeResponse(FILES[url] ?? 1024)
    })

    const { preloadAssets } = await import('@/lib/model-cache')
    await preloadAssets([URLS[0]])

    expect(networkCalls).toBe(2)
    expect(cacheWrites).toBe(1)
  })

  it('retries a retryable HTTP status', async () => {
    let attempts = 0
    vi.stubGlobal('fetch', async (url: string) => {
      networkCalls++
      attempts++
      return attempts === 1
        ? fakeResponse(0, 503, { 'Retry-After': '0' })
        : fakeResponse(FILES[url] ?? 1024)
    })

    const { preloadAssets } = await import('@/lib/model-cache')
    await preloadAssets([URLS[0]])

    expect(networkCalls).toBe(2)
  })

  it('does not retry a permanent HTTP status and names the failed asset', async () => {
    vi.stubGlobal('fetch', async () => {
      networkCalls++
      return fakeResponse(0, 404)
    })

    const { preloadAssets } = await import('@/lib/model-cache')
    await expect(preloadAssets([URLS[0]])).rejects.toThrow(
      'wingclip_visual_int8.onnx download failed after 1 attempt: HTTP 404',
    )
    expect(networkCalls).toBe(1)
    expect(cacheWrites).toBe(0)
  })

  it('keeps progress monotonic when a streamed attempt fails and retries', async () => {
    let attempts = 0
    vi.stubGlobal('fetch', async (url: string) => {
      networkCalls++
      attempts++
      if (attempts === 1) {
        let reads = 0
        return {
          ...fakeResponse(FILES[url] ?? 1024),
          body: {
            getReader: () => ({
              read: async () => {
                reads++
                if (reads === 1) return { done: false, value: new Uint8Array(512) }
                throw new TypeError('connection reset')
              },
            }),
          },
        }
      }
      return fakeResponse(FILES[url] ?? 1024)
    })

    const { preloadAssets } = await import('@/lib/model-cache')
    const seen: number[] = []
    await preloadAssets([URLS[0]], progress => seen.push(progress.loaded))

    expect(networkCalls).toBe(2)
    for (let index = 1; index < seen.length; index++) {
      expect(seen[index]).toBeGreaterThanOrEqual(seen[index - 1])
    }
    expect(seen.at(-1)).toBe(FILES[URLS[0]])
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
