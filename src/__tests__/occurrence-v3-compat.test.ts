/**
 * The v4 reader must still read a v3 blob, and the ranker must still rank
 * against one.
 *
 * v4 inserts a uint32 n_cm table between the index and the payload and adds a
 * pooled per-cell slice under month code 12. Both are additive, so a v3 blob
 * stays parseable, but "stays parseable" is exactly the kind of claim that is
 * true until someone computes an offset from the wrong start. v3 blobs are
 * still live in the wild: the shipped file name carries a content hash, so a
 * client holding a cached v3 asset keeps using it until the new name is
 * fetched.
 *
 * Both blobs are the real shipped assets, not synthetic fixtures.
 */
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { parseOccurrence, occCell, occCellPooled, occTotal } from '@/lib/occurrence'
import { rankCandidates, type Candidate } from '@/lib/rank'
import { lonLatToEqualEarth, xyToCell } from '@/lib/equal-earth'
import { MODEL_ASSETS } from '@/lib/bird-id-local-adapter'

const PRIORS = resolve(__dirname, '../../public/priors')
const V3 = resolve(PRIORS, 'occurrence.1fb61779.bin.gz')
const V4 = resolve(PRIORS, 'occurrence.7c39b341.bin.gz')

/**
 * The v3 asset was built against the PRE-extinct-drop taxonomy and is frozen:
 * it is the artifact a client may still hold in cache, so it cannot be
 * rebuilt. Pass its own taxonomy hash rather than the current one, otherwise
 * this test only proves the hash guard fires, which taxonomy-hash.test.ts
 * already covers.
 */
const V3_TAX_SHA16 = '04951673b96b11bf'

const load = (p: string, sha: string = MODEL_ASSETS.taxonomySha16) =>
  parseOccurrence(new Uint8Array(gunzipSync(readFileSync(p))), sha)

/** Central Park, a densely populated cell in both blobs. */
const CELL = (() => {
  const { x, y } = lonLatToEqualEarth(-73.9665, 40.7813)
  return xyToCell(x, y)!
})()

describe('v4 reader against a v3 blob', () => {
  const v3 = load(V3, V3_TAX_SHA16)
  const v4 = load(V4)

  it('reports the version each blob actually is', () => {
    expect(v3.version).toBe(3)
    expect(v4.version).toBe(4)
  })

  it('reads each blob\'s own taxonomy hash', () => {
    // These used to be equal. The v3 asset is frozen at the pre-extinct-drop
    // taxonomy, so after dropping 152 EX/EW species they legitimately differ.
    // What still must hold: each blob reports ITS OWN hash faithfully, and
    // the shipped v4 matches the current taxonomy.
    expect(v3.taxHash).toBe(V3_TAX_SHA16)
    expect(v4.taxHash).toBe(MODEL_ASSETS.taxonomySha16)
    expect(v3.taxHash).not.toBe(v4.taxHash)
  })

  it('returns monthly priors from a v3 blob', () => {
    const p = occCell(v3, CELL.row, CELL.col, 6)
    expect(p).not.toBeNull()
    expect(p!.size).toBeGreaterThan(0)
  })

  it('returns NOTHING for the v4-only accessors on a v3 blob', () => {
    // The absent case must be reported, not improvised. A pooled slice
    // silently defaulting to the monthly one would replace the prior with a
    // different distribution and nothing would fail.
    expect(occCellPooled(v3, CELL.row, CELL.col)).toBeNull()
    expect(occTotal(v3, CELL.row, CELL.col, 6)).toBeNull()
  })

  it('supplies both v4-only accessors on a v4 blob', () => {
    expect(occCellPooled(v4, CELL.row, CELL.col)).not.toBeNull()
    expect(occTotal(v4, CELL.row, CELL.col, 6)).toBeGreaterThan(0)
  })

  it('ranks against a v3 blob without backoff and produces finite scores', () => {
    const priors = occCell(v3, CELL.row, CELL.col, 6)!
    const idxs = [...priors.keys()].slice(0, 8)
    const cands: Candidate[] = idxs.map((idx, i) => ({ idx, sim: 0.32 - i * 0.011 }))
    const scored = rankCandidates(cands, MODEL_ASSETS.calibration, v3,
                                  { lat: 40.7813, lon: -73.9665 }, 6)
    expect(scored).toHaveLength(cands.length)
    for (const s of scored) {
      expect(Number.isFinite(s.score)).toBe(true)
      expect(s.logP).not.toBeNull()
      expect(Number.isFinite(s.logP as number)).toBe(true)
    }
    // Sorted descending, as the ranker contract promises.
    for (let i = 1; i < scored.length; i++) {
      expect(scored[i - 1].score).toBeGreaterThanOrEqual(scored[i].score)
    }
  })
})
