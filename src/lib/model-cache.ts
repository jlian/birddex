/**
 * Persistent caching for the 61.66 MiB of model assets.
 *
 * Uses the Cache API directly rather than a service worker. main.tsx
 * deliberately unregisters service workers, so adding one back would fight an
 * existing decision. The Cache API gives the same persistence with none of the
 * lifecycle, and it is available from a normal page context.
 *
 * Assets, all content-addressed by version in the file name so a new model
 * never collides with a cached old one:
 *   wingclip_visual_int8.onnx   13.72 MiB
 *   wingclip_visual_int8.data   24.00 MiB
 *   text_classifier_int8.bin     8.22 MiB
 *   occurrence-v3.bin.gz        15.71 MiB
 *
 * The HTTP cache alone is not enough: it is best-effort and the browser can
 * evict 24 MiB of weights whenever it likes, which would silently turn a free
 * identification into a 62 MiB download on cellular. A named Cache is explicit
 * and inspectable.
 */

const CACHE_NAME = "wingdex-model-v3"

export type AssetProgress = {
  /** Bytes fetched across all assets so far. */
  loaded: number
  /** Total bytes expected, or 0 when the server sends no content-length. */
  total: number
  /** Which asset is in flight, for a status line. */
  current: string
  /** True when the bytes came from cache rather than the network. */
  cached: boolean
}

/**
 * Fetch with cache-first semantics and progress reporting.
 *
 * Progress matters here: 62 MiB with no feedback looks like a hung app, and
 * this is the first thing a new user hits.
 */
async function fetchCached(
  url: string,
  onProgress?: (p: AssetProgress) => void,
  state?: { loaded: number; total: number },
): Promise<ArrayBuffer> {
  const cache = await caches.open(CACHE_NAME)
  const hit = await cache.match(url)
  if (hit) {
    const buf = await hit.arrayBuffer()
    if (state) state.loaded += buf.byteLength
    onProgress?.({
      loaded: state?.loaded ?? buf.byteLength,
      total: state?.total ?? 0,
      current: url,
      cached: true,
    })
    return buf
  }

  const res = await fetch(url)
  if (!res.ok) throw new Error("fetch " + url + " failed: " + res.status)

  // Tee the body so progress can be reported while the response is still
  // streaming, then cache the completed copy.
  const reader = res.clone().body?.getReader()
  if (reader && onProgress) {
    const start = state?.loaded ?? 0
    let seen = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      seen += value.byteLength
      onProgress({
        loaded: start + seen,
        total: state?.total ?? 0,
        current: url,
        cached: false,
      })
    }
    if (state) state.loaded = start + seen
  }

  // Cache.put needs a response that has not been consumed. Persistence is
  // best-effort: if the Cache API rejects (quota exceeded, private browsing,
  // storage disabled) the bytes are already in hand, so keep them and let
  // inference proceed rather than failing an otherwise successful 62 MiB
  // download that every retry would only repeat.
  try {
    await cache.put(url, res.clone())
  } catch (err) {
    console.warn("model-cache: persisting " + url + " failed, continuing uncached", err)
  }
  return res.arrayBuffer()
}

/**
 * Warm every asset. Call on FIRST IDENTIFY, not at page load: opening the site
 * must not pull 62 MiB, and most visits never identify anything.
 */
export async function preloadAssets(
  urls: string[],
  onProgress?: (p: AssetProgress) => void,
): Promise<Map<string, ArrayBuffer>> {
  // A HEAD pass gives a real total so the progress bar is honest rather than
  // indeterminate. It is cheap and failures are non-fatal.
  let total = 0
  await Promise.all(urls.map(async u => {
    try {
      const h = await fetch(u, { method: "HEAD" })
      const len = Number(h.headers.get("content-length") || 0)
      if (Number.isFinite(len)) total += len
    } catch {
      // Leave total short rather than failing the load.
    }
  }))

  const state = { loaded: 0, total }
  const out = new Map<string, ArrayBuffer>()
  // Sequential on purpose. Four parallel multi-MiB downloads on a phone
  // compete for bandwidth and make progress meaningless.
  for (const u of urls) {
    out.set(u, await fetchCached(u, onProgress, state))
  }
  return out
}

/** Are the assets already local? Lets the UI skip a download prompt. */
export async function assetsCached(urls: string[]): Promise<boolean> {
  if (!("caches" in globalThis)) return false
  const cache = await caches.open(CACHE_NAME)
  for (const u of urls) {
    if (!(await cache.match(u))) return false
  }
  return true
}

/** Drop the cache. For a settings screen, and for testing a cold load. */
export async function clearAssetCache(): Promise<void> {
  await caches.delete(CACHE_NAME)
}
