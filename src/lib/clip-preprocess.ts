/**
 * CLIP preprocessing that matches open_clip / PIL exactly.
 *
 * Resize(224, BICUBIC) then CenterCrop(224), then normalize. Resize takes the
 * SHORTER side to 224 and keeps aspect ratio; drawing straight into a 224x224
 * canvas squashes the image instead, which is a different picture and costs
 * accuracy silently.
 *
 * The resampling is implemented here rather than delegated to canvas
 * drawImage. Canvas smoothing is implementation-defined and does not match
 * PIL bicubic, so the tensor would drift per browser with nothing failing.
 *
 * PIL uses a=-0.5 in the bicubic kernel and, when downscaling, STRETCHES the
 * kernel by the scale factor so it averages over all source pixels. Using a
 * fixed 4-tap kernel when downscaling 6000px to 224px would sample about 4 of
 * every 27 pixels and alias badly.
 */

export const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073] as const
export const CLIP_STD = [0.26862954, 0.26130258, 0.27577711] as const
export const CLIP_SIZE = 224

export type Rgb = { data: Uint8Array; width: number; height: number }

/** PIL bicubic kernel, a = -0.5. */
function cubic(x: number): number {
  const a = -0.5
  const ax = Math.abs(x)
  if (ax < 1) return ((a + 2) * ax - (a + 3)) * ax * ax + 1
  if (ax < 2) return ((ax - 5) * ax + 8) * ax * a - 4 * a
  return 0
}

/**
 * Resample one axis with PIL semantics.
 * Reads planar RGB from any ArrayLike (the source Uint8Array on the first
 * pass, a Float64Array intermediate on the second) and writes Float64 so no
 * rounding happens between passes. Reading uint8 values directly is exactly
 * equal to copying them into a float buffer first, but skips a full-resolution
 * allocation.
 */
function resampleAxis(
  src: ArrayLike<number>,
  srcW: number,
  srcH: number,
  dstLen: number,
  horizontal: boolean,
): Float64Array {
  const srcLen = horizontal ? srcW : srcH
  const scale = srcLen / dstLen
  // Stretch the kernel when downscaling; keep it at 2.0 when upscaling.
  const filterScale = Math.max(scale, 1)
  const support = 2 * filterScale

  const dstW = horizontal ? dstLen : srcW
  const dstH = horizontal ? srcH : dstLen
  const out = new Float64Array(dstW * dstH * 3)

  for (let d = 0; d < dstLen; d++) {
    const center = (d + 0.5) * scale
    let lo = Math.floor(center - support + 0.5)
    let hi = Math.ceil(center + support - 0.5)
    if (lo < 0) lo = 0
    if (hi > srcLen) hi = srcLen

    const n = hi - lo
    if (n <= 0) continue
    const w = new Float64Array(n)
    let wsum = 0
    for (let k = 0; k < n; k++) {
      const v = cubic((lo + k + 0.5 - center) / filterScale)
      w[k] = v
      wsum += v
    }
    if (wsum !== 0) for (let k = 0; k < n; k++) w[k] /= wsum

    if (horizontal) {
      for (let y = 0; y < srcH; y++) {
        for (let c = 0; c < 3; c++) {
          let acc = 0
          for (let k = 0; k < n; k++) acc += w[k] * src[(y * srcW + lo + k) * 3 + c]
          out[(y * dstW + d) * 3 + c] = acc
        }
      }
    } else {
      for (let x = 0; x < srcW; x++) {
        for (let c = 0; c < 3; c++) {
          let acc = 0
          for (let k = 0; k < n; k++) acc += w[k] * src[((lo + k) * srcW + x) * 3 + c]
          out[(d * dstW + x) * 3 + c] = acc
        }
      }
    }
  }
  return out
}

/** Resize so the SHORTER side is `size`, preserving aspect ratio. */
export function resizeShorterSide(img: Rgb, size: number): {
  data: Float64Array; width: number; height: number
} {
  const { width: w, height: h } = img
  let nw: number
  let nh: number
  // torchvision Resize uses FLOOR, not round. For 1024x683 that is
  // 1024*224/683 = 335.86 -> 335, where round gives 336. A one-pixel
  // difference shifts every subsequent pixel and silently wrecks parity.
  if (w <= h) {
    nw = size
    nh = Math.floor((size * h) / w)
  } else {
    nh = size
    nw = Math.floor((size * w) / h)
  }

  // Horizontal then vertical, matching PIL pass order. Feed the source bytes
  // straight into the first pass instead of copying them into a
  // full-resolution Float64Array first. That copy cost 3*8 bytes per source
  // pixel (~576 MB for a 24MP photo, on top of the RGBA/RGB buffers) and
  // OOM'd mobile browsers. The resampled values are identical either way.
  const hpass = resampleAxis(img.data, w, h, nw, true)
  const vpass = resampleAxis(hpass, nw, h, nh, false)
  return { data: vpass, width: nw, height: nh }
}

/**
 * Python round(), which is round-half-to-EVEN, not half-up.
 * Math.round(52.5) is 53 but Python gives 52, and that one-pixel shift
 * breaks parity on every odd crop margin while all dimensions still look
 * correct. Verified: margins 105, 77, 149, 125 and 113 all diverge.
 */
function bankersRound(x: number): number {
  const f = Math.floor(x)
  const d = x - f
  if (d > 0.5) return f + 1
  if (d < 0.5) return f
  return f % 2 === 0 ? f : f + 1
}

/** Center crop to size x size. */
export function centerCrop(
  src: Float64Array,
  w: number,
  h: number,
  size: number,
): Float64Array {
  // Resize floors, CenterCrop ROUNDS. They genuinely differ, and mixing
  // them up shifts the window by one pixel on odd margins, which silently
  // wrecks parity while every dimension still looks correct.
  // Verified by brute-forcing the offset against the PIL reference:
  // 335 wide -> left 56 (floor gives 55), 291 wide -> left 34 (floor 33).
  const left = bankersRound((w - size) / 2.0)
  const top = bankersRound((h - size) / 2.0)
  const out = new Float64Array(size * size * 3)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sy = top + y
      const sx = left + x
      for (let c = 0; c < 3; c++) {
        out[(y * size + x) * 3 + c] = src[(sy * w + sx) * 3 + c]
      }
    }
  }
  return out
}

/**
 * Full CLIP preprocess: resize, crop, scale to 0..1, normalize, to CHW.
 * Returns Float32Array of shape (1, 3, 224, 224).
 */
export function preprocess(img: Rgb, size = CLIP_SIZE): Float32Array {
  const r = resizeShorterSide(img, size)
  const c = centerCrop(r.data, r.width, r.height, size)
  const out = new Float32Array(3 * size * size)
  for (let ch = 0; ch < 3; ch++) {
    const m = CLIP_MEAN[ch]
    const s = CLIP_STD[ch]
    for (let p = 0; p < size * size; p++) {
      // PIL rounds to uint8 after resampling, before ToTensor.
      let v = c[p * 3 + ch]
      v = Math.round(v)
      if (v < 0) v = 0
      if (v > 255) v = 255
      out[ch * size * size + p] = (v / 255 - m) / s
    }
  }
  return out
}
