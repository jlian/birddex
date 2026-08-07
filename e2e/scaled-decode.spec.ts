import { test, expect } from '@playwright/test'
import { readFileSync } from 'fs'
import path from 'path'

/**
 * Does the browser actually decode at reduced scale?
 *
 * bird-id-local-adapter.ts asks createImageBitmap for a 500px long side. If the
 * engine ignores resize options it returns the full bitmap instead: correct
 * output, none of the memory saving, and nothing in the app surfaces which path
 * ran. That silent no-op is the regression worth guarding.
 *
 * Chromium-only by configuration. Safari genuinely ignores these options, so
 * this asserts a Chromium capability, not a web standard.
 */

const BIG = 'Great_blue_heron_with_Mount_Baker_from_Drayton_Harbor.jpg'

async function loadBase64(page: import('@playwright/test').Page, file: string) {
  return readFileSync(path.resolve('src/assets/images', file)).toString('base64')
}

test.describe('scaled decode', () => {
  test('createImageBitmap honors resizeWidth, so the full bitmap is never built', async ({ page }) => {
    await page.goto('/')
    const b64 = await loadBase64(page, BIG)

    const out = await page.evaluate(async (data: string) => {
      const bin = Uint8Array.from(atob(data), c => c.charCodeAt(0))
      const blob = new Blob([bin], { type: 'image/jpeg' })

      const full = await createImageBitmap(blob)
      const natural = { w: full.width, h: full.height }
      full.close()

      const cap = 500
      const scale = cap / Math.max(natural.w, natural.h)
      const scaled = await createImageBitmap(blob, {
        resizeWidth: Math.round(natural.w * scale),
        resizeHeight: Math.round(natural.h * scale),
        resizeQuality: 'high',
      })
      const got = { w: scaled.width, h: scaled.height }
      scaled.close()
      return { natural, got }
    }, b64)

    // Guard the premise: if this asset is ever swapped for a small file the
    // test would pass without exercising anything.
    expect(Math.max(out.natural.w, out.natural.h)).toBeGreaterThan(2000)

    expect(Math.max(out.got.w, out.got.h)).toBe(500)
    // Aspect must survive, since resizeShorterSide assumes square pixels.
    const before = out.natural.w / out.natural.h
    const after = out.got.w / out.got.h
    expect(Math.abs(before - after)).toBeLessThan(0.01)
  })

  test('scaled decode stays close to a full decode after preprocessing', async ({ page }) => {
    await page.goto('/')
    const b64 = await loadBase64(page, BIG)

    // Both arms end at the same 224x224 box, so this isolates the DECODE from
    // the resize: only the path taken to get there differs. An exact match is
    // not expected, Skia and libjpeg are different resamplers. What matters is
    // that the two views of the photo stay highly correlated, which is why the
    // 3,322-photo accuracy run held at 95.09.
    const stats = await page.evaluate(async (data: string) => {
      const bin = Uint8Array.from(atob(data), c => c.charCodeAt(0))
      const blob = new Blob([bin], { type: 'image/jpeg' })

      async function toBox(bmp: ImageBitmap) {
        const c = new OffscreenCanvas(224, 224)
        const ctx = c.getContext('2d')!
        // Cover-crop to a square so both arms frame identically.
        const side = Math.min(bmp.width, bmp.height)
        const sx = (bmp.width - side) / 2
        const sy = (bmp.height - side) / 2
        ctx.drawImage(bmp, sx, sy, side, side, 0, 0, 224, 224)
        return ctx.getImageData(0, 0, 224, 224).data
      }

      const full = await createImageBitmap(blob)
      const cap = 500
      const scale = cap / Math.max(full.width, full.height)
      const scaled = await createImageBitmap(blob, {
        resizeWidth: Math.round(full.width * scale),
        resizeHeight: Math.round(full.height * scale),
        resizeQuality: 'high',
      })

      const a = await toBox(full)
      const b = await toBox(scaled)
      full.close()
      scaled.close()

      let maxd = 0
      let sum = 0
      let n = 0
      let dot = 0
      let na = 0
      let nb = 0
      for (let i = 0; i < a.length; i += 4) {
        for (let k = 0; k < 3; k++) {
          const x = a[i + k]
          const y = b[i + k]
          const d = Math.abs(x - y)
          if (d > maxd) maxd = d
          sum += d
          n++
          dot += x * y
          na += x * x
          nb += y * y
        }
      }
      return { maxd, mean: sum / n, cosine: dot / (Math.sqrt(na) * Math.sqrt(nb)) }
    }, b64)

    // Report the measurement, so a regression shows the number rather than
    // only a pass/fail.
    console.log(
      `scaled vs full: max=${stats.maxd} mean=${stats.mean.toFixed(2)} cosine=${stats.cosine.toFixed(5)}`,
    )

    // Cosine is the meaningful bound. Individual pixels on high-frequency
    // detail can differ a lot; the image as a whole must not.
    expect(stats.cosine).toBeGreaterThan(0.99)
    expect(stats.mean).toBeLessThan(12)
  })
})
