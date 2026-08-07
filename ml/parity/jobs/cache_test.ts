/**
 * Does the cache layer actually cache, and report honest progress?
 *
 * Runs in Node with a fake Cache API and a fake fetch, because the logic worth
 * testing is the DECISION (cache hit versus network, byte accounting, sequential
 * order) and none of that needs a browser.
 *
 * The bug this is guarding against is silent: if the cache never hits, the app
 * still works perfectly and just re-downloads 61.66 MiB every session. Nothing
 * fails, the user pays.
 */

const store = new Map<string, ArrayBuffer>()
let networkCalls = 0
let headCalls = 0

const FILES: Record<string, number> = {
  "/models/wingclip_visual_int8.onnx": 14386199,
  "/models/wingclip_visual_int8.data": 25165824,
  "/models/text_classifier_int8.bin": 8620924,
  "/priors/occurrence.1fb61779.bin.gz": 16478112,
}

class FakeResponse {
  ok = true
  status = 200
  headers: Map<string, string>
  private buf: ArrayBuffer
  constructor(buf: ArrayBuffer) {
    this.buf = buf
    this.headers = new Map([["content-length", String(buf.byteLength)]])
  }
  clone() { return new FakeResponse(this.buf) }
  async arrayBuffer() { return this.buf }
  get body() {
    const buf = this.buf
    let sent = 0
    return {
      getReader() {
        return {
          async read() {
            if (sent >= buf.byteLength) return { done: true, value: undefined }
            // Chunk it so progress is exercised, not just called once.
            const n = Math.min(1 << 20, buf.byteLength - sent)
            sent += n
            return { done: false, value: new Uint8Array(n) }
          },
        }
      },
    }
  }
}

const g = globalThis as Record<string, unknown>
g.caches = {
  async open() {
    return {
      async match(url: string) {
        const b = store.get(url)
        return b ? new FakeResponse(b) : undefined
      },
      async put(url: string, res: FakeResponse) {
        store.set(url, await res.arrayBuffer())
      },
    }
  },
  async delete() { store.clear(); return true },
}
g.fetch = async (url: string, opts?: { method?: string }) => {
  if (opts?.method === "HEAD") {
    headCalls++
    return new FakeResponse(new ArrayBuffer(0)) as unknown
  }
  networkCalls++
  return new FakeResponse(new ArrayBuffer(FILES[url] ?? 1024)) as unknown
}

const { preloadAssets, assetsCached, clearAssetCache } =
  await import('../../../src/lib/model-cache.ts')

const urls = Object.keys(FILES)
let pass = 0
let fail = 0
function check(name: string, got: unknown, want: unknown) {
  const ok = got === want
  if (ok) { pass++; console.log("  ok   " + name) }
  else { fail++; console.log("  FAIL " + name + "  got " + got + " want " + want) }
}

console.log("")
console.log("cold load:")
check("nothing cached yet", await assetsCached(urls), false)

const seen: number[] = []
const first = await preloadAssets(urls, p => seen.push(p.loaded))
check("all four assets returned", first.size, 4)
check("four network fetches", networkCalls, 4)
check("progress was reported", seen.length > 4, true)

let monotonic = true
for (let i = 1; i < seen.length; i++) if (seen[i] < seen[i - 1]) monotonic = false
check("progress never goes backwards", monotonic, true)

const totalBytes = Object.values(FILES).reduce((a, b) => a + b, 0)
check("final progress equals total bytes", seen[seen.length - 1], totalBytes)

console.log("")
console.log("warm load:")
networkCalls = 0
check("now reported as cached", await assetsCached(urls), true)
const second = await preloadAssets(urls, () => {})
check("all four still returned", second.size, 4)
check("ZERO network fetches", networkCalls, 0)

let sameBytes = true
for (const u of urls) {
  if (first.get(u)!.byteLength !== second.get(u)!.byteLength) sameBytes = false
}
check("cached bytes match the network bytes", sameBytes, true)

console.log("")
console.log("after clearing:")
await clearAssetCache()
check("cache reports empty", await assetsCached(urls), false)
networkCalls = 0
await preloadAssets(urls, () => {})
check("re-downloads after a clear", networkCalls, 4)

console.log("")
console.log(pass + " passed, " + fail + " failed")
if (fail > 0) process.exit(1)
console.log("CACHE OK: " + (totalBytes / 1048576).toFixed(2) + " MiB downloads once")
