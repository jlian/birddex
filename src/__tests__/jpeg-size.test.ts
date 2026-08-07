import { describe, it, expect } from 'vitest'
import { readJpegSize } from '@/lib/bird-id-local-adapter'

/**
 * The header walk decides the decode size for every photo. If it is wrong by a
 * byte it returns a plausible but incorrect size, and every image gets quietly
 * distorted, so the marker skipping is worth testing directly.
 */

/** Build a minimal JPEG: SOI, optional segments, then an SOF carrying w/h. */
function jpeg(segments: Array<{ marker: number; body: number[] }>, sof: {
  marker: number; width: number; height: number
}): Blob {
  const bytes: number[] = [0xff, 0xd8]
  for (const s of segments) {
    const len = s.body.length + 2
    bytes.push(0xff, s.marker, (len >> 8) & 0xff, len & 0xff, ...s.body)
  }
  bytes.push(
    0xff, sof.marker, 0x00, 0x11, 0x08,
    (sof.height >> 8) & 0xff, sof.height & 0xff,
    (sof.width >> 8) & 0xff, sof.width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  )
  return new Blob([new Uint8Array(bytes)])
}

describe('readJpegSize', () => {
  it('reads dimensions from a baseline SOF0', async () => {
    const r = await readJpegSize(jpeg([], { marker: 0xc0, width: 4128, height: 6192 }))
    expect(r).toEqual({ width: 4128, height: 6192 })
  })

  it('reads a progressive SOF2, which is common for web photos', async () => {
    const r = await readJpegSize(jpeg([], { marker: 0xc2, width: 1910, height: 2865 }))
    expect(r).toEqual({ width: 1910, height: 2865 })
  })

  it('skips EXIF and ICC segments ahead of the frame header', async () => {
    const r = await readJpegSize(jpeg([
      { marker: 0xe1, body: new Array(2048).fill(0x41) },
      { marker: 0xe2, body: new Array(4096).fill(0x42) },
    ], { marker: 0xc0, width: 800, height: 600 }))
    expect(r).toEqual({ width: 800, height: 600 })
  })

  it('does NOT mistake DHT for a frame header', async () => {
    // 0xc4 sits inside the 0xc0-0xcf range but is a Huffman table, not a SOF.
    // Treating it as one reads table bytes as width and height.
    const r = await readJpegSize(jpeg([
      { marker: 0xc4, body: new Array(64).fill(0x07) },
    ], { marker: 0xc0, width: 320, height: 240 }))
    expect(r).toEqual({ width: 320, height: 240 })
  })

  it('returns null for a non-JPEG so the caller decodes normally', async () => {
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])])
    expect(await readJpegSize(png)).toBeNull()
  })

  it('returns null rather than looping on a truncated header', async () => {
    const trunc = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])])
    expect(await readJpegSize(trunc)).toBeNull()
  })
})
