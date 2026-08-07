/**
 * Golden vectors shared by the web ranker and the iOS Swift port.
 *
 * The Swift port in ios/WingDex/Services/BirdID reimplements equal-earth.ts,
 * occurrence.ts and rank.ts. Two implementations of the same math drift, and
 * the failure is silent: a mis-keyed cell or a shifted month still returns a
 * plausible ranked list. This test pins the TS output to a file that
 * WingDexTests reads back, so a change here fails the web suite until the
 * golden is regenerated, and the regenerated file is what iOS is then tested
 * against.
 *
 * Regenerate with UPDATE_GOLDEN=1 npx vitest run birdid-golden
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { lonLatToEqualEarth, xyToCell } from '../lib/equal-earth'
import { parseOccurrence, occCell } from '../lib/occurrence'
import { rankCandidates, scoresToProbs, type Candidate } from '../lib/rank'
import { MODEL_ASSETS } from '../lib/bird-id-local-adapter'

const FIXTURES = resolve(__dirname, '../../ios/WingDexTests/Fixtures')
const GOLDEN = resolve(FIXTURES, 'birdid-golden.json')
/**
 * iOS reads the prior UNCOMPRESSED. Apple's Compression framework does raw
 * deflate, not gzip, so decoding the shipped .gz on device would mean
 * hand-parsing gzip headers or linking zlib. Raw costs 23.0 MiB against 15.7
 * MiB gzipped, and the IPA is compressed for delivery anyway, so the 7.3 MiB
 * buys away a whole dependency. This writes the copy the Swift tests read.
 */
const RAW_OUT = resolve(FIXTURES, 'occurrence.bin')
const BLOB = resolve(__dirname, '../../public/priors/occurrence.1fb61779.bin.gz')

/** Chosen to cover populated land cells, both hemispheres, and off-grid input. */
const POINTS: Array<{ name: string; lat: number; lon: number }> = [
  { name: 'central-park-nyc', lat: 40.7813, lon: -73.9665 },
  { name: 'point-reyes-ca', lat: 38.0431, lon: -122.8797 },
  { name: 'london-uk', lat: 51.5072, lon: -0.1276 },
  { name: 'sydney-au', lat: -33.8688, lon: 151.2093 },
  { name: 'nairobi-ke', lat: -1.2921, lon: 36.8219 },
  { name: 'quito-ec', lat: -0.1807, lon: -78.4678 },
  { name: 'antimeridian-east', lat: 0, lon: 180 },
  { name: 'antimeridian-west', lat: 0, lon: -180 },
  { name: 'north-pole', lat: 89.9, lon: 0 },
  { name: 'south-pole', lat: -89.9, lon: 0 },
]

function loadBlob() {
  const gz = readFileSync(BLOB)
  const raw = new Uint8Array(gunzipSync(gz))
  return { occ: parseOccurrence(raw, MODEL_ASSETS.taxonomySha16), raw }
}

function build() {
  const { occ } = loadBlob()

  const projection = POINTS.map(p => {
    const { x, y } = lonLatToEqualEarth(p.lon, p.lat)
    const cell = xyToCell(x, y)
    return { ...p, x, y, cell }
  })

  // Priors for a populated cell across every month, plus one off-grid point and
  // the rejected month values that must degrade to vision-only.
  const cellPriors: unknown[] = []
  for (const p of projection) {
    if (!p.cell) continue
    for (const month of [1, 6, 12]) {
      const m = occCell(occ, p.cell.row, p.cell.col, month)
      cellPriors.push({
        name: p.name,
        row: p.cell.row,
        col: p.cell.col,
        month,
        // null distinguishes "no data for this cell-month" from "empty map".
        count: m === null ? null : m.size,
        // First 8 by species index keeps the file small and order-independent.
        sample: m === null ? null :
          [...m.entries()].sort((a, b) => a[0] - b[0]).slice(0, 8),
      })
    }
  }

  // Month values the ranker must refuse. 0 is the old 0-11 API convention and
  // is the one a naive iOS port would send.
  const badMonths = [0, 13, -1].map(month => {
    const c = projection.find(p => p.name === 'central-park-nyc')!.cell!
    return { month, count: occCell(occ, c.row, c.col, month)?.size ?? null }
  })

  // Candidates drawn from a real populated cell so the scored path exercises
  // both a present species and one that falls to OCC_FLOOR.
  const ref = projection.find(p => p.name === 'central-park-nyc')!.cell!
  const present = [...occCell(occ, ref.row, ref.col, 6)!.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([idx]) => idx)
  const cands: Candidate[] = [
    ...present.map((idx, i) => ({ idx, sim: 0.32 - i * 0.011 })),
    { idx: 11166, sim: 0.27 },
    { idx: 0, sim: 0.26 },
  ]

  const ranking = [
    { name: 'with-prior-june', lat: 40.7813, lon: -73.9665, month: 6 },
    { name: 'with-prior-january', lat: 40.7813, lon: -73.9665, month: 1 },
    { name: 'no-location', lat: null, lon: null, month: 6 },
    { name: 'no-month', lat: 40.7813, lon: -73.9665, month: null },
    { name: 'off-grid', lat: 89.9, lon: 0, month: 6 },
  ].map(c => {
    const loc = c.lat === null || c.lon === null ? null : { lat: c.lat, lon: c.lon }
    const scored = rankCandidates(cands, MODEL_ASSETS.calibration, occ, loc,
                                  c.month ?? undefined)
    const probs = scoresToProbs(scored)
    return {
      ...c,
      scored: scored.map(s => ({ idx: s.idx, sim: s.sim, score: s.score, logP: s.logP })),
      probs,
    }
  })

  return {
    note: 'Generated by src/__tests__/birdid-golden.test.ts. Do not hand-edit.',
    taxonomySha16: MODEL_ASSETS.taxonomySha16,
    calibration: MODEL_ASSETS.calibration,
    blobVersion: occ.version,
    blobTaxHash: occ.taxHash,
    candidates: cands,
    projection,
    cellPriors,
    badMonths,
    ranking,
  }
}

describe('bird ID golden vectors', () => {
  it('matches the committed fixture that WingDexTests reads', () => {
    const built = build()
    if (process.env.UPDATE_GOLDEN) {
      mkdirSync(dirname(GOLDEN), { recursive: true })
      writeFileSync(GOLDEN, JSON.stringify(built, null, 2) + '\n')
      writeFileSync(RAW_OUT, loadBlob().raw)
    }
    const onDisk = JSON.parse(readFileSync(GOLDEN, 'utf8'))
    expect(built).toEqual(onDisk)
  })

  it('rejects the 0-11 month convention the old API used', () => {
    const built = build()
    for (const b of built.badMonths) expect(b.count).toBeNull()
  })
})
