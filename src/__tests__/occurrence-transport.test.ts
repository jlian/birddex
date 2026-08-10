import { describe, it, expect } from 'vitest'
import { gzipSync } from 'node:zlib'
import { gunzipIfNeeded } from '@/lib/bird-id-local'

/**
 * The occurrence blob ships as a .gz asset, and hosts disagree about what that
 * means. Cloudflare serves it as an opaque body, so the raw gzip arrives here.
 * `wrangler dev` labels it `Content-Encoding: gzip` off the extension, so the
 * browser decodes it in transit and the loader sees the decompressed payload.
 *
 * The old loader assumed the first case and threw on the second, which broke
 * the model download on localhost while every mocked-fetch test stayed green.
 */
describe('gunzipIfNeeded', () => {
  const payload = new TextEncoder().encode('WDOP\u0003\u0005 occurrence blob')

  const gzip = (bytes: Uint8Array) => new Uint8Array(gzipSync(bytes))
  // DecompressionStream returns an array from another realm under jsdom, so compare bytes.
  const bytes = (value: Uint8Array) => Array.from(value)

  it('decompresses a body the transport left alone', async () => {
    const compressed = gzip(payload)
    expect(compressed[0]).toBe(0x1f)
    expect(compressed[1]).toBe(0x8b)
    expect(bytes(await gunzipIfNeeded(compressed))).toEqual(bytes(payload))
  })

  it('passes through a body the transport already decoded', async () => {
    expect(bytes(await gunzipIfNeeded(payload))).toEqual(bytes(payload))
  })

  it('cannot confuse the two, because a decoded blob starts with WDOP', async () => {
    expect(payload[0]).not.toBe(0x1f)
    expect(bytes(await gunzipIfNeeded(await gunzipIfNeeded(gzip(payload))))).toEqual(bytes(payload))
  })
})
