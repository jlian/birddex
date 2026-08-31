/**
 * Persistent caching for the 56.25 MiB of model assets (MODEL_BYTES; the
 * decoded total is 67.37 MiB and is not a transfer size).
 *
 * Uses the Cache API directly rather than a service worker. main.tsx
 * deliberately unregisters service workers, so adding one back would fight an
 * existing decision. The Cache API gives the same persistence with none of the
 * lifecycle, and it is available from a normal page context.
 *
 * Assets carry either a version query or a content hash so a new model never
 * collides with a cached old one:
 *   wingclip_visual_int8.onnx   13.72 MiB
 *   wingclip_visual_int8.data   24.00 MiB
 *   text_classifier_int8.bin     8.11 MiB
 *   occurrence.<hash>.bin.gz    21.54 MiB
 *
 * The HTTP cache alone is not enough: it is best-effort and the browser can
 * evict 24 MiB of weights whenever it likes, which would silently turn a free
 * identification into a 56 MiB download on cellular. A named Cache is explicit
 * and inspectable.
 */

const CACHE_NAME = "wingdex-model-v3"
const MAX_FETCH_ATTEMPTS = 3
const MAX_RETRY_DELAY_MS = 5_000

class RetryableFetchError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message)
  }
}

function assetName(url: string): string {
  return url.split('/').pop()?.split('?')[0] || url
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('Retry-After')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(MAX_RETRY_DELAY_MS, Math.ceil(seconds * 1_000))
    }

    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) {
      return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, date - Date.now()))
    }
  }
  return 250 * 2 ** (attempt - 1)
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function readResponse(
  response: Response,
  onChunk?: (bytesRead: number) => void,
): Promise<ArrayBuffer> {
  const reader = response.body?.getReader()
  if (!reader) return response.arrayBuffer()

  const chunks: Uint8Array[] = []
  let bytesRead = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    bytesRead += value.byteLength
    onChunk?.(bytesRead)
  }

  const bytes = new Uint8Array(bytesRead)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes.buffer
}

async function fetchAsset(
  url: string,
  onChunk?: (bytesRead: number) => void,
): Promise<{ buffer: ArrayBuffer; contentType: string | null }> {
  let lastError: unknown
  let attempts = 0
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    attempts = attempt
    try {
      const response = await fetch(url)
      if (!response.ok) {
        const message = `HTTP ${response.status}`
        if (!isRetryableStatus(response.status)) throw new Error(message)
        throw new RetryableFetchError(message, retryDelay(response, attempt))
      }
      return {
        buffer: await readResponse(response, onChunk),
        contentType: response.headers.get('Content-Type'),
      }
    } catch (error) {
      lastError = error
      const retryable = error instanceof RetryableFetchError
        || !(error instanceof Error && /^HTTP \d+$/.test(error.message))
      if (!retryable || attempt === MAX_FETCH_ATTEMPTS) break
      await sleep(error instanceof RetryableFetchError && error.retryAfterMs !== undefined
        ? error.retryAfterMs
        : 250 * 2 ** (attempt - 1))
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError)
  const attemptLabel = attempts === 1 ? 'attempt' : 'attempts'
  throw new Error(`${assetName(url)} download failed after ${attempts} ${attemptLabel}: ${detail}`)
}

/** Cache API is unavailable in some private modes and constrained webviews. */
async function openCache(): Promise<Cache | null> {
  if (!("caches" in globalThis)) return null
  try {
    return await caches.open(CACHE_NAME)
  } catch {
    return null
  }
}

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
 * Progress matters here: 56 MiB with no feedback looks like a hung app, and
 * this is the first thing a new user hits.
 */
async function fetchCached(
  url: string,
  onProgress?: (p: AssetProgress) => void,
  state?: { loaded: number; total: number },
): Promise<ArrayBuffer> {
  // Caching is best effort. Where the Cache API is missing or throws, the
  // download still works, it just repeats next session; failing here would
  // block identification entirely for those users.
  const cache = await openCache()
  const hit = await cache?.match(url)
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

  const start = state?.loaded ?? 0
  let reportedForAsset = 0
  const { buffer, contentType } = await fetchAsset(url, bytesRead => {
    reportedForAsset = Math.max(reportedForAsset, bytesRead)
    onProgress?.({
      loaded: start + reportedForAsset,
      total: state?.total ?? 0,
      current: url,
      cached: false,
    })
  })
  if (state) state.loaded = start + buffer.byteLength

  // Persistence is best-effort. Cache the completed bytes rather than cloning
  // the network response into extra multi-megabyte streaming branches.
  try {
    await cache?.put(url, new Response(buffer, {
      headers: contentType ? { 'Content-Type': contentType } : undefined,
    }))
  } catch (err) {
    console.warn("model-cache: persisting " + url + " failed, continuing uncached", err)
  }
  return buffer
}

/**
 * Warm every asset. Call on FIRST IDENTIFY, not at page load: opening the site
 * must not pull 56 MiB, and most visits never identify anything.
 */
export async function preloadAssets(
  urls: string[],
  onProgress?: (p: AssetProgress) => void,
  /**
   * Expected DECODED bytes across all assets.
   *
   * Not measured with a HEAD pass, which was wrong twice over. Content-Length
   * reports the COMPRESSED length while fetch hands the reader DECOMPRESSED
   * bytes, so the occurrence prior alone understated the total by 7.6 MiB
   * (16,478,112 against 24,123,497) and the bar saturated at 100% with a
   * ninth of the download still arriving. And it cost four round trips even
   * when every asset was already cached.
   */
  totalBytes = 0,
): Promise<Map<string, ArrayBuffer>> {
  const state = { loaded: 0, total: totalBytes }
  const out = new Map<string, ArrayBuffer>()
  // Sequential on purpose. Four parallel multi-MiB downloads on a phone
  // compete for bandwidth and make progress meaningless.
  for (const u of urls) {
    out.set(u, await fetchCached(u, onProgress, state))
  }
  await pruneStaleAssets(urls)
  return out
}

/**
 * Drop entries that are not part of the current asset set. Keys carry the model
 * version, so without this every bump strands another 56 MiB indefinitely.
 */
async function pruneStaleAssets(urls: string[]): Promise<void> {
  const cache = await openCache()
  if (!cache) return
  const keep = new Set(urls.map(u => new URL(u, location.href).href))
  try {
    for (const req of await cache.keys()) {
      if (!keep.has(req.url)) await cache.delete(req)
    }
  } catch (err) {
    console.warn("model-cache: pruning stale assets failed", err)
  }
}

/** Are the assets already local? Lets the UI skip a download prompt. */
export async function assetsCached(urls: string[]): Promise<boolean> {
  const cache = await openCache()
  if (!cache) return false
  for (const u of urls) {
    if (!(await cache.match(u))) return false
  }
  return true
}

/** Drop the cache. For a settings screen, and for testing a cold load. */
export async function clearAssetCache(): Promise<void> {
  // Deleting does not need openCache() to have succeeded, and tying it to that
  // meant a cache that failed to open could never be cleared.
  if (!("caches" in globalThis)) return
  try {
    await caches.delete(CACHE_NAME)
  } catch (err) {
    console.warn("model-cache: clearing the asset cache failed", err)
  }
}
