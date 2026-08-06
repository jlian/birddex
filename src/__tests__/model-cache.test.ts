import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * Asset caching for the 61.66 MiB model bundle.
 *
 * This bug class is invisible in production: if the cache never hits, the app
 * still works perfectly and simply re-downloads 62 MiB every session. Nothing
 * throws, nothing looks wrong, the user pays. So the assertions that matter are
 * the network-call counts, not the returned bytes.
 */

const FILES: Record<string, number> = {
  '/models/wingclip_visual_int8.onnx': 14386199,
  '/models/wingclip_visual_int8.data': 25165824,
  '/models/text_classifier_int8.bin': 8620924,
  '/priors/occurrence-v3.bin.gz': 16478112,
}
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
