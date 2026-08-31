/**
 * The Guatemala vulture, end to end through the SHIPPED path.
 *
 * This photo is the reason OCC_FLOOR moved off 1e-12. At that floor a species
 * the pooled slice rescues sits about 13.7 logits above one on the floor,
 * against a similarity gap of 1.11, so the prior decided the answer outright
 * and Black Vulture displayed 99.9999 percent. That is a claim the evidence
 * does not support, and no amount of downstream calibration fixes a ranker
 * that has already saturated.
 *
 * Real 25-candidate shortlist, real cell, real shipped blob and calibration.
 * Numbers here are the WEB path; iOS is pinned separately against the golden.
 *
 * The shortlist is emitted through the SHIPPED path on BOTH sides of the dot
 * product: the int8 ONNX encoder for the image, and the dequantised int8 text
 * rows the browser decodes out of text_classifier_int8.bin for the species.
 * Quantisation is not cosmetic. Against the fp32 PyTorch student it reorders
 * the top-25 (19 of 25 in common, max |dsim| 0.044); fixing the text side on
 * top of that swapped one more member (max |dsim| 0.00037 on the rest).
 */
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { parseOccurrence } from '@/lib/occurrence'
import { rankCandidates, scoresToProbs, type Candidate } from '@/lib/rank'
import { lonLatToEqualEarth, xyToCell } from '@/lib/equal-earth'
import { MODEL_ASSETS, MODEL_ASSET_URLS } from '@/lib/bird-id-local-adapter'
import taxonomy from '@/lib/taxonomy.json'

const BLOB = resolve(
  __dirname,
  '../../public',
  (MODEL_ASSET_URLS.find(u => u.startsWith('/priors/')) as string).slice(1),
)

const FIX = resolve(__dirname, 'fixtures/vulture-shortlist.json')

describe('Guatemala vulture', () => {
  const fix = JSON.parse(readFileSync(FIX, 'utf8')) as {
    lat: number; lon: number; month: number
    cand_idx: number[]; cand_sim: number[]
    p_bird: number
  }
  const occ = parseOccurrence(new Uint8Array(gunzipSync(readFileSync(BLOB))),
                              MODEL_ASSETS.taxonomySha16)

  const cands: Candidate[] = fix.cand_idx.map((idx, i) => ({
    idx, sim: fix.cand_sim[i],
  }))
  const scored = rankCandidates(cands, MODEL_ASSETS.calibration, occ,
                                { lat: fix.lat, lon: fix.lon }, fix.month)
  const probs = scoresToProbs(scored)
  const names = taxonomy as unknown as string[][]

  it('lands in the cell the offline harness used', () => {
    const { x, y } = lonLatToEqualEarth(fix.lon, fix.lat)
    expect(xyToCell(x, y)).toEqual({ row: 239, col: 319 })
  })

  it('ranks Black Vulture first', () => {
    expect(names[scored[0].idx][0]).toBe('Black Vulture')
  })

  it('displays a confidence near 61 percent, not a saturated one', () => {
    // This asserts the DISPLAYED value, which is what the user reads:
    //   pBird * P(species | bird) = 0.9878 * 0.6163 = 0.6088
    // scoresToProbs returns only the species term, so asserting it alone
    // would leave the shipped probe multiplier untested on this photo.
    //
    // Every number here is the SHIPPED path: the int8 ONNX shortlist in the
    // fixture, floor 3e-5, k 0.3, T 0.007435, beta 1.1634, and the probe from
    // BIRD_PROBE. An earlier revision asserted 0.5795, which was the species
    // term under an fp32 PyTorch shortlist the browser never computes. It then
    // read 0.6131, which used the ONNX encoder but still scored against fp32
    // build_text() rows rather than the dequantised int8 text rows the browser
    // decodes. Fixing the TEXT side too swapped one shortlist member
    // (942 out, 2821 in) and moved this to 0.6088.
    //
    // Dropping the 152 extinct species moved it again, to 0.6159. One of the
    // 25 shortlist members was itself extinct (old index 3985), so the
    // fixture now carries 24 candidates and the softmax denominator lost a
    // term. A smaller denominator raises every surviving probability, which
    // is why this went UP by 0.007 without the ranking changing. Black
    // Vulture still wins and the bounds below still hold.
    //
    // The upper bound is the point of the change: at the old floor this read
    // 0.999999, and anything above 0.9 means the floor regressed.
    const displayed = fix.p_bird * probs[0]
    expect(displayed).toBeGreaterThan(0.5)
    expect(displayed).toBeLessThan(0.65)
    expect(displayed).toBeCloseTo(0.6159, 3)
    // The probe only scales, so it cannot have moved the winner.
    expect(fix.p_bird).toBeGreaterThan(MODEL_ASSETS.calibration.probe.threshold)
  })
})
