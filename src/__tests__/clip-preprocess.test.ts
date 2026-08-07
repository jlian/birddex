import { describe, it, expect } from 'vitest'
import { preprocess, resizeShorterSide, centerCrop, CLIP_MEAN, CLIP_STD } from '@/lib/clip-preprocess'

/**
 * CLIP preprocessing geometry.
 *
 * These are regression tests for three real bugs, each of which shifted the
 * crop window by ONE pixel while every dimension still looked correct, and each
 * of which cost accuracy silently rather than throwing:
 *
 *   1. Resize FLOORS. 1024x683 goes to 335 wide, not 336.
 *   2. CenterCrop ROUNDS, the opposite rule from Resize.
 *   3. Python round() is BANKERS rounding, so 52.5 goes to 52, not 53.
 *
 * Worst tensor error against PIL was 2.596 before the fixes and 3.0e-2 after.
 * Nothing here would have failed on the buggy code by throwing; the numbers
 * are the only signal, which is exactly why they are pinned.
 */

function solid(w: number, h: number, v = 128): { data: Uint8Array; width: number; height: number } {
  return { data: new Uint8Array(w * h * 3).fill(v), width: w, height: h }
}

describe('resize geometry', () => {
  it('FLOORS the long side, matching torchvision', () => {
    // 1024 * 224 / 683 = 335.86. Rounding gives 336 and is wrong.
    const r = resizeShorterSide(solid(1024, 683), 224)
    expect(r.width).toBe(335)
    expect(r.height).toBe(224)
  })

  it('scales the SHORTER side to the target, preserving aspect', () => {
    // Portrait: the short side is the width, so width becomes 224.
    const r = resizeShorterSide(solid(556, 800), 224)
    expect(r.width).toBe(224)
    expect(r.height).toBe(322)
  })

  it('handles a square without distortion', () => {
    const r = resizeShorterSide(solid(500, 500), 224)
    expect(r.width).toBe(224)
    expect(r.height).toBe(224)
  })
})

describe('center crop', () => {
  it('produces exactly size x size', () => {
    const r = resizeShorterSide(solid(1024, 683), 224)
    const c = centerCrop(r.data, r.width, r.height, 224)
    expect(c.length).toBe(224 * 224 * 3)
  })

  it('uses BANKERS rounding on an odd margin', () => {
    // 335 wide gives a margin of 111, so the offset is 55.5. Bankers rounding
    // gives 56 here because 55 is odd. Math.round would also give 56, so the
    // discriminating case is an even-floor margin, covered below.
    const w = 335
    const src = new Float64Array(w * 224 * 3)
    // Mark the column that a correct crop must start at.
    for (let y = 0; y < 224; y++) src[(y * w + 56) * 3] = 255
    const c = centerCrop(src, w, 224, 224)
    expect(c[0]).toBe(255)
  })

  it('rounds half to EVEN, not half up', () => {
    // 329 wide gives a margin of 105, so the offset is 52.5. Python gives 52
    // because 52 is even; Math.round gives 53 and is wrong.
    const w = 329
    const src = new Float64Array(w * 224 * 3)
    for (let y = 0; y < 224; y++) src[(y * w + 52) * 3] = 255
    const c = centerCrop(src, w, 224, 224)
    expect(c[0]).toBe(255)
  })
})

describe('full preprocess', () => {
  it('returns a normalised CHW tensor of the right shape', () => {
    const t = preprocess(solid(640, 480))
    expect(t.length).toBe(3 * 224 * 224)
  })

  it('applies the CLIP normalisation per channel', () => {
    // A solid mid-grey image: every pixel of channel c must equal
    // (128/255 - mean[c]) / std[c].
    const t = preprocess(solid(300, 300, 128))
    for (let c = 0; c < 3; c++) {
      const want = (128 / 255 - CLIP_MEAN[c]) / CLIP_STD[c]
      expect(t[c * 224 * 224]).toBeCloseTo(want, 5)
      expect(t[c * 224 * 224 + 12345]).toBeCloseTo(want, 5)
    }
  })

  it('puts channels in CHW order, not HWC', () => {
    // Pure red. In CHW the first plane is all high and the second all low;
    // in HWC the values would interleave.
    const w = 300
    const img = { data: new Uint8Array(w * w * 3), width: w, height: w }
    for (let i = 0; i < w * w; i++) img.data[i * 3] = 255
    const t = preprocess(img)
    const rPlane = (255 / 255 - CLIP_MEAN[0]) / CLIP_STD[0]
    const gPlane = (0 / 255 - CLIP_MEAN[1]) / CLIP_STD[1]
    expect(t[0]).toBeCloseTo(rPlane, 4)
    expect(t[224 * 224]).toBeCloseTo(gPlane, 4)
  })
})

describe('RGBA input', () => {
  // The browser hands us RGBA from getImageData. Packing it down to RGB
  // first cost 3 bytes per source pixel, 72 MB on a 24MP photo, purely to
  // drop an alpha channel the resampler can skip by indexing. That is only
  // safe if the resulting tensor is UNCHANGED, so pin it: a silent drift
  // here would alter every model input with nothing failing.
  function pair(w: number, h: number, seed: number) {
    const rgba = new Uint8ClampedArray(w * h * 4)
    let s = seed
    for (let i = 0; i < w * h; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      rgba[i * 4] = s % 256
      rgba[i * 4 + 1] = (s >> 8) % 256
      rgba[i * 4 + 2] = (s >> 16) % 256
      rgba[i * 4 + 3] = 255
    }
    const rgb = new Uint8Array(w * h * 3)
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      rgb[j] = rgba[i]
      rgb[j + 1] = rgba[i + 1]
      rgb[j + 2] = rgba[i + 2]
    }
    return { rgba, rgb }
  }

  it.each([
    [1024, 683],
    [640, 480],
    [500, 500],
    [333, 777],
  ])('channels:4 matches packed RGB exactly at %ix%i', (w, h) => {
    const { rgba, rgb } = pair(w, h, w + h)
    const packed = preprocess({ data: rgb, width: w, height: h })
    const direct = preprocess({ data: rgba, width: w, height: h, channels: 4 })
    expect(direct.length).toBe(packed.length)
    for (let i = 0; i < packed.length; i++) {
      // Bit-identical, not approximately equal. Only R/G/B are read.
      expect(direct[i]).toBe(packed[i])
    }
  })

  it('ignores the alpha channel entirely', () => {
    const w = 64, h = 48
    const { rgba, rgb } = pair(w, h, 9)
    const opaque = preprocess({ data: rgba, width: w, height: h, channels: 4 })
    // Scribble over alpha; the tensor must not move.
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = (i * 7) % 256
    const scribbled = preprocess({ data: rgba, width: w, height: h, channels: 4 })
    const packed = preprocess({ data: rgb, width: w, height: h })
    for (let i = 0; i < packed.length; i++) {
      expect(scribbled[i]).toBe(opaque[i])
      expect(scribbled[i]).toBe(packed[i])
    }
  })
})

