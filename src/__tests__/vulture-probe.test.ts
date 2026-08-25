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

  it('displays a confidence near 58 percent, not a saturated one', () => {
    // 0.5795 on the shipped web path at floor 3e-5, k 0.3, T 0.007435,
    // beta 1.1634. The offline harness reports 0.5701 for the SAME photo
    // because it additionally multiplies by the discriminative bird probe
    // (P_cal = 0.9838), which is deliberately not shipped here:
    // 0.5795 * 0.9838 = 0.5701. Once the probe lands, this expectation moves
    // to 0.5701 and not before.
    //
    // The upper bound is the point of the change: at the old floor this read
    // 0.999999, and anything above 0.9 means the floor regressed.
    expect(probs[0]).toBeGreaterThan(0.5)
    expect(probs[0]).toBeLessThan(0.65)
    expect(probs[0]).toBeCloseTo(0.5795, 3)
  })
})
