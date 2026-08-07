#!/usr/bin/env node
// Step 2 of the Bayesian rerank plan: attach BirdLife range status to every
// candidate of every calibration photo.
//
// Input : calib_cands_*.parquet exported to JSONL (photo lat/lon + top-K
//         candidate app_idx list)
// Output: JSONL with a parallel status array per photo, one of
//         present / near-range / no-data / out-of-range
//
// Uses the SAME lookup the production pipeline uses (range-adjust.js) so the
// fitted weights transfer directly.
import { readFileSync, writeFileSync, existsSync, createReadStream } from 'fs'
import { gunzipSync } from 'zlib'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import readline from 'readline'
import { lonLatToEqualEarth as eeProj, xyToCell, parseCellBlob } from '../../functions/lib/range-adjust.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CELLS = join(ROOT, '.tmp/range-priors/cells')
const TAXONOMY = JSON.parse(readFileSync(join(ROOT, 'src/lib/taxonomy.json'), 'utf8'))
// app_idx is the row index into taxonomy.json; col 2 is the eBird code
const CODE_BY_IDX = TAXONOMY.map(r => (r[2] || ""))

const blobCache = new Map()
function loadBlob(r, c) {
  const k = r + "-" + c
  if (blobCache.has(k)) return blobCache.get(k)
  const p = join(CELLS, k + ".bin.gz")
  let v = null
  if (existsSync(p)) {
    try { v = gunzipSync(readFileSync(p)) } catch { v = null }
  }
  if (blobCache.size > 20000) blobCache.clear()
  blobCache.set(k, v)
  return v
}

// present in this cell -> present; present in any of the 8 neighbours ->
// near-range; cell exists but species absent -> out-of-range; no blob at all
// -> no-data. Mirrors lookupRangeExpanded in pipeline-experiment.mjs.
function statusFor(lat, lon, codes) {
  const out = new Map()
  const { x, y } = eeProj(lon, lat)
  const cell = xyToCell(x, y)
  if (!cell) { for (const c of codes) out.set(c, "no-data"); return out }
  const self = loadBlob(cell.row, cell.col)
  if (!self) { for (const c of codes) out.set(c, "no-data"); return out }
  const want = new Set(codes.filter(Boolean))
  const sm = parseCellBlob(self, want)
  const rest = new Set()
  for (const c of codes) {
    if (sm.get(c)) out.set(c, "present")
    else rest.add(c)
  }
  if (rest.size) {
    for (let dr = -1; dr <= 1 && rest.size; dr++) {
      for (let dc = -1; dc <= 1 && rest.size; dc++) {
        if (dr === 0 && dc === 0) continue
        const nb = loadBlob(cell.row + dr, cell.col + dc)
        if (!nb) continue
        const nm = parseCellBlob(nb, rest)
        for (const c of [...rest]) {
          if (nm.get(c)) { out.set(c, "near-range"); rest.delete(c) }
        }
      }
    }
  }
  for (const c of rest) out.set(c, "out-of-range")
  return out
}

const inPath = process.argv[2]
const outPath = process.argv[3]
const rl = readline.createInterface({ input: createReadStream(inPath), crlfDelay: Infinity })
const results = []
let n = 0
const tally = { present: 0, "near-range": 0, "no-data": 0, "out-of-range": 0 }
for await (const line of rl) {
  if (!line.trim()) continue
  const row = JSON.parse(line)
  const codes = row.cand_idx.map(i => CODE_BY_IDX[i] || "")
  let statuses
  if (row.latitude == null || row.longitude == null) {
    statuses = codes.map(() => "no-data")
  } else {
    const m = statusFor(row.latitude, row.longitude, codes)
    statuses = codes.map(c => m.get(c) || "no-data")
  }
  for (const s of statuses) tally[s] = (tally[s] || 0) + 1
  results.push({ photo_id: row.photo_id, status: statuses })
  n++
  if (n % 2000 === 0) console.error(n + " photos...")
}
writeFileSync(outPath, results.map(r => JSON.stringify(r)).join("\n") + "\n")
console.error("photos: " + n)
console.error("candidate-status tally: " + JSON.stringify(tally))
console.error("=== RANGE STATUS DONE ===")
