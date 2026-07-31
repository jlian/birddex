#!/usr/bin/env node
/**
 * BioCLIP pipeline recalibration experiment.
 *
 * Problem: the production post-LLM pipeline (bird-id.ts) is tuned to GPT's
 * confidence semantics:
 *   1. `confidence >= 0.2` hard floor
 *   2. slice(0,5) BEFORE range adjustment
 *   3. multiplicative range penalty (x0.65 out-of-range)
 * BioCLIP emits softmax-over-11k probabilities where the true species often
 * sits at 0.01-0.05 among many similar congeners, so it gets floored out
 * before range priors can help.
 *
 * This harness reads BioCLIP raw candidate lists (cosine sims, top-50) and
 * tests recalibration strategies against the real range cells + taxonomy.
 *
 * Usage: node scripts/bioclip-pipeline-experiment.mjs [--fixtures DIR]
 */
import { readFileSync, existsSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { gunzipSync } from 'zlib'
import { createHash } from 'crypto'
import { fileURLToPath } from 'url'
import {
  lonLatToEqualEarth as eeProj, xyToCell, nearestNeighborCell,
  parseCellBlob, adjustConfidence,
} from '../../functions/lib/range-adjust.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TAXONOMY = JSON.parse(readFileSync(join(ROOT, 'src/lib/taxonomy.json'), 'utf8'))
const byCommonLower = new Map(), byScientificLower = new Map()
TAXONOMY.forEach(([common, scientific, ebirdCode], appIdx) => {
  const e = { common, scientific, ebirdCode: ebirdCode || '', appIdx }
  byCommonLower.set(common.toLowerCase(), e)
  byScientificLower.set(scientific.toLowerCase(), e)
})
function findBestMatch(name) {
  if (!name) return null
  const raw = name.trim(), rl = raw.toLowerCase()
  const ec = byCommonLower.get(rl); if (ec) return ec
  const pm = raw.match(/^(.+?)\s*\(([^)]+)\)\s*$/)
  if (pm) {
    const s = byScientificLower.get(pm[2].trim().toLowerCase()); if (s) return s
    const c = byCommonLower.get(pm[1].trim().toLowerCase()); if (c) return c
  }
  const es = byScientificLower.get(rl); if (es) return es
  return null
}

const CELLS_DIR = join(ROOT, '.tmp/range-priors/cells')
const RANGE_AVAILABLE = existsSync(CELLS_DIR)
function loadBlob(r, c) { const p = join(CELLS_DIR, `${r}-${c}.bin.gz`); return existsSync(p) ? gunzipSync(readFileSync(p)) : null }
function lookupRange(lat, lon, codes) {
  const out = new Map()
  if (!RANGE_AVAILABLE || codes.length === 0) return out
  const { x, y } = eeProj(lon, lat)
  const cell = xyToCell(x, y)
  if (!cell) { for (const c of codes) out.set(c, { status: 'no-data' }); return out }
  const data = loadBlob(cell.row, cell.col)
  if (!data) { for (const c of codes) out.set(c, { status: 'no-data' }); return out }
  const sm = parseCellBlob(data, new Set(codes)); const oor = []
  for (const c of codes) { const a = sm.get(c); if (a) out.set(c, { status: 'present', ...a }); else oor.push(c) }
  if (oor.length) {
    const nb = nearestNeighborCell(x, y, cell.row, cell.col)
    const nd = nb ? loadBlob(nb.row, nb.col) : null
    if (nd) { const nm = parseCellBlob(nd, new Set(oor)); for (const c of oor) { const a = nm.get(c); out.set(c, a ? { status: 'near-range', ...a } : { status: 'out-of-range' }) } }
    else for (const c of oor) out.set(c, { status: 'out-of-range' })
  }
  return out
}

// Expanded neighbor lookup: check the full 3x3 ring (all 8 neighbors), not
// just the single closest edge. Recovers coastal/edge points where the
// species' range cell is diagonal or on a non-nearest edge (e.g. Great Blue
// Heron @ Drayton Harbor: present in adjacent E/S cells, missed by 1-neighbor).
function lookupRangeExpanded(lat, lon, codes) {
  const out = new Map()
  if (!RANGE_AVAILABLE || codes.length === 0) return out
  const { x, y } = eeProj(lon, lat)
  const cell = xyToCell(x, y)
  if (!cell) { for (const c of codes) out.set(c, { status: 'no-data' }); return out }
  const self = loadBlob(cell.row, cell.col)
  if (!self) { for (const c of codes) out.set(c, { status: 'no-data' }); return out }
  const sm = parseCellBlob(self, new Set(codes)); const oor = []
  for (const c of codes) { const a = sm.get(c); if (a) out.set(c, { status: 'present', ...a }); else oor.push(c) }
  if (oor.length) {
    const remaining = new Set(oor)
    // scan the 8 surrounding cells; first hit => near-range
    for (let dr = -1; dr <= 1 && remaining.size; dr++) {
      for (let dc = -1; dc <= 1 && remaining.size; dc++) {
        if (dr === 0 && dc === 0) continue
        const nd = loadBlob(cell.row + dr, cell.col + dc)
        if (!nd) continue
        const nm = parseCellBlob(nd, remaining)
        for (const c of [...remaining]) { const a = nm.get(c); if (a) { out.set(c, { status: 'near-range', ...a }); remaining.delete(c) } }
      }
    }
    for (const c of remaining) out.set(c, { status: 'out-of-range' })
  }
  return out
}

// ── Ground candidates to taxonomy (keep ALL, carry raw score) ──
function ground(fx) {
  const seen = new Set()
  const out = []
  for (const c of (fx.parsed?.candidates || [])) {
    const m = findBestMatch(c.scientificName ? `${c.commonName} (${c.scientificName})` : c.commonName)
    if (!m) continue
    if (seen.has(m.common)) continue
    seen.add(m.common)
    out.push({ commonName: m.common, ebirdCode: m.ebirdCode, appIdx: m.appIdx, score: Number(c.confidence) })
  }
  return out
}

// ── Strategy A: production as-is (0.2 floor, slice5, then range) ──
function stratProd(fx) {
  const ctx = fx.context || {}
  let c = ground(fx).filter(c => c.score >= 0.2).sort((a, b) => b.score - a.score).slice(0, 5)
  if (ctx.lat != null && ctx.lon != null) {
    const pr = lookupRange(ctx.lat, ctx.lon, c.map(x => x.ebirdCode).filter(Boolean))
    c = c.map(x => ({ ...x, score: adjustConfidence(x.score, pr.get(x.ebirdCode) || { status: 'no-data' }, ctx.month, ctx.lat) }))
      .sort((a, b) => b.score - a.score)
  }
  return c.map(x => x.commonName)
}

// ── Strategy B: keep top-K, range on full set, THEN slice5 ──
function stratTopK(fx, K = 15) {
  const ctx = fx.context || {}
  let c = ground(fx).sort((a, b) => b.score - a.score).slice(0, K)
  if (ctx.lat != null && ctx.lon != null) {
    const pr = lookupRange(ctx.lat, ctx.lon, c.map(x => x.ebirdCode).filter(Boolean))
    c = c.map(x => ({ ...x, score: x.score * rangeMult(pr.get(x.ebirdCode) || { status: 'no-data' }, ctx.month, ctx.lat) }))
  }
  return c.sort((a, b) => b.score - a.score).slice(0, 5).map(x => x.commonName)
}

// ── range multiplier tuned for BioCLIP (harder out-of-range exclusion) ──
function rangeMult(range, month, lat, opts = {}) {
  const OOR = opts.oor ?? 0.25   // harder than GPT's 0.65
  const NEAR = opts.near ?? 0.7
  if (range.status === 'no-data') return 1.0
  if (range.status === 'out-of-range') return OOR
  // reuse presence/origin/seasonal from adjustConfidence by calling it on 1.0
  const base = range.status === 'near-range' ? NEAR : 1.0
  // approximate layered trust via adjustConfidence on a unit score / status present
  const layered = adjustConfidence(1.0, { ...range, status: range.status === 'near-range' ? 'present' : range.status }, month, lat)
  return base * layered
}

// ── Strategy D: tiered sort. Hard-partition by range tier, keep BioCLIP
// order within each tier. In-range always outranks near-range outranks OOR.
// This matches how a birder reasons: eliminate impossible species first,
// then rank the plausible ones by visual similarity.
const TIER = { 'present': 0, 'near-range': 1, 'no-data': 2, 'out-of-range': 3 }
let TIERED_EXPANDED = false
function stratTiered(fx, K = 15) {
  const ctx = fx.context || {}
  const rangeLookup = TIERED_EXPANDED ? lookupRangeExpanded : lookupRange
  let c = ground(fx).sort((a, b) => b.score - a.score).slice(0, K)
  if (ctx.lat != null && ctx.lon != null) {
    const pr = rangeLookup(ctx.lat, ctx.lon, c.map(x => x.ebirdCode).filter(Boolean))
    c = c.map(x => {
      const r = pr.get(x.ebirdCode) || { status: 'no-data' }
      // seasonal/presence still nudge within-tier via adjustConfidence
      const layered = adjustConfidence(x.score, { ...r, status: r.status === 'out-of-range' ? 'present' : r.status }, ctx.month, ctx.lat)
      return { ...x, tier: TIER[r.status] ?? 2, adj: layered, status: r.status }
    })
    c.sort((a, b) => a.tier - b.tier || b.adj - a.adj)
  }
  return c.slice(0, 5).map(x => x.commonName)
}

// ── Strategy E: tiered but no-data treated as plausible (tier with present) ──
function stratTieredSoft(fx, K = 15) {
  const ctx = fx.context || {}
  let c = ground(fx).sort((a, b) => b.score - a.score).slice(0, K)
  if (ctx.lat != null && ctx.lon != null) {
    const pr = lookupRange(ctx.lat, ctx.lon, c.map(x => x.ebirdCode).filter(Boolean))
    const softTier = { 'present': 0, 'near-range': 0, 'no-data': 0, 'out-of-range': 1 }
    c = c.map(x => {
      const r = pr.get(x.ebirdCode) || { status: 'no-data' }
      const layered = adjustConfidence(x.score, { ...r, status: r.status === 'out-of-range' ? 'present' : r.status }, ctx.month, ctx.lat)
      return { ...x, tier: softTier[r.status] ?? 0, adj: layered }
    })
    c.sort((a, b) => a.tier - b.tier || b.adj - a.adj)
  }
  return c.slice(0, 5).map(x => x.commonName)
}

// ── Strategy F: confidence-gated tiering. If BioCLIP's top candidate
// dominates (score - 2nd >= domMargin), TRUST the visual ID and keep raw
// order (morphology authoritative, per the GPT prompt philosophy). This
// guards against coarse-grid range-data artifacts wrongly demoting a
// confident, correct, actually-present bird. Otherwise (ambiguous), apply
// hard OOR-demotion to let range priors break the tie.
function stratGated(fx, K = 15, opts = {}) {
  const domMargin = opts.domMargin ?? 0.5
  const rangeLookup = opts.expanded ? lookupRangeExpanded : lookupRange
  let c = ground(fx).sort((a, b) => b.score - a.score).slice(0, K)
  const ctx = fx.context || {}
  const dominant = c.length >= 1 && (c[0].score - (c[1]?.score ?? 0)) >= domMargin
  if (dominant || ctx.lat == null || ctx.lon == null) {
    return c.slice(0, 5).map(x => x.commonName)
  }
  const pr = rangeLookup(ctx.lat, ctx.lon, c.map(x => x.ebirdCode).filter(Boolean))
  c = c.map(x => {
    const r = pr.get(x.ebirdCode) || { status: 'no-data' }
    const layered = adjustConfidence(x.score, { ...r, status: r.status === 'out-of-range' ? 'present' : r.status }, ctx.month, ctx.lat)
    return { ...x, tier: TIER[r.status] ?? 2, adj: layered }
  })
  c.sort((a, b) => a.tier - b.tier || b.adj - a.adj)
  return c.slice(0, 5).map(x => x.commonName)
}

// ── scoring ──
// -- Strategy H: BAYESIAN log-sum. Replaces the hand-rolled gate/tier stack.
//
//   score = log P(image|species) + log P(species|location)
//         = sim/T                + w[range_status]
//
// No confidence floor, no dominance margin, no tiers, no special cases. A
// strong visual match produces a large enough likelihood term to overcome an
// unfavourable prior on its own; a weak one does not. That is exactly the
// behaviour Strategy F hand-codes with dom>=0.5.
//
// Our range data is CATEGORICAL (present/near-range/no-data/out-of-range), not
// a probability, so w[] is a LEARNED log-prior per status rather than an
// invented P. w[out-of-range] is a fitted floor, which also avoids log(0):
// out-of-range means "rare", never "impossible".
//
// NOTE: fixtures store softmax(sim/0.01) probabilities, so we recover the
// underlying sim as 0.01*log(p) (+const, which cancels in a softmax/argsort).
function stratBayes(fx, K = 25, opts = {}) {
  const T = opts.T ?? 0.007809  // FITTED 2026-07-30 on 11k leak-free set
  // FITTED jointly with T by max-likelihood on 11,070 leak-free photos.
  // Note w[no-data] fitted to EXACTLY 0: do not punish ignorance like
  // absence. And w[out-of-range] = -3.86 is far harsher than the
  // hand-set 0.25x multiplier (~-1.39 in log space).
  const w = opts.w ?? { present: 0.0, "near-range": -0.5726, "no-data": 0.0, "out-of-range": -3.8552 }
  const ctx = fx.context || {}
  const rangeLookup = opts.expanded ? lookupRangeExpanded : lookupRange
  let c = ground(fx).sort((a, b) => b.score - a.score).slice(0, K)
  if (!c.length) return []
  // undo the fixture temperature to get back to a raw-similarity scale
  c = c.map(x => ({ ...x, sim: 0.01 * Math.log(Math.max(x.score, 1e-12)) }))
  if (ctx.lat == null || ctx.lon == null) {
    return c.sort((a, b) => b.sim - a.sim).slice(0, 5).map(x => x.commonName)
  }
  const pr = rangeLookup(ctx.lat, ctx.lon, c.map(x => x.ebirdCode).filter(Boolean))
  c = c.map(x => {
    const st = (pr.get(x.ebirdCode) || { status: "no-data" }).status
    const logprior = w[st] ?? w["no-data"]
    return { ...x, post: x.sim / T + logprior }
  })
  return c.sort((a, b) => b.post - a.post).slice(0, 5).map(x => x.commonName)
}

// -- Strategy I: the SHIPPING ranker. Bayesian log-sum over an EMPIRICAL
// P(species|cell) read from the real blob at public/priors/occurrence-v1.bin.gz.
//
//   score = sim/T + beta * log P(species | cell)
//
// No BirdLife: the ablation showed it adds +0.30 pts once occurrence counts
// exist, so it is not shipped. Cells with no occurrence data fall back to
// vision-only ranking, which is a graceful degradation (72.94 vs 88.29 abs)
// rather than a confident wrong answer.
//
// This decodes the blob EXACTLY as the client will: binary-search the sorted
// cell index, slice, walk varint deltas. Verified against DuckDB (0 mismatches).
let OCC = null
function loadOccurrence() {
  if (OCC !== null) return OCC
  const p = join(ROOT, "public/priors/occurrence-v1.bin.gz")
  if (!existsSync(p)) { OCC = false; return OCC }
  const raw = gunzipSync(readFileSync(p))
  if (raw.subarray(0, 4).toString("ascii") !== "WDOP") throw new Error("bad magic")
  const version = raw[4]
  const qbits = raw[5]
  // v2 inserts an 8-byte taxonomy hash before n_cells. Species are keyed
  // by ROW INDEX into taxonomy.json, so a reordered taxonomy would
  // silently mis-key every prior -- the client MUST check this.
  const hashLen = version >= 2 ? 8 : 0
  const taxHash = version >= 2 ? raw.subarray(8, 16).toString('hex') : null
  const nCells = raw.readUInt32LE(8 + hashLen)
  const idxStart = 12 + hashLen
  const payloadStart = idxStart + (nCells + 1) * 8
  if (taxHash) {
    const want = createHash('sha256').update(readFileSync(join(ROOT, 'src/lib/taxonomy.json'))).digest('hex').slice(0, 16)
    if (want !== taxHash) {
      throw new Error(`prior blob taxonomy hash ${taxHash} != taxonomy.json ${want} -- rebuild the blob`)
    }
  }
  OCC = { raw, nCells, idxStart, payloadStart, qbits, scale: 2.5 }
  return OCC
}

// Returns Map<appIdx, logProb> for one cell, or null when the cell is absent.
function occCell(row, col) {
  const o = loadOccurrence()
  if (!o) return null
  const want = row * 1276 + col
  let lo = 0, hi = o.nCells - 1, found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const key = o.raw.readUInt32LE(o.idxStart + mid * 8)
    if (key === want) { found = mid; break }
    if (key < want) lo = mid + 1; else hi = mid - 1
  }
  if (found < 0) return null
  const start = o.raw.readUInt32LE(o.idxStart + found * 8 + 4)
  const end = o.raw.readUInt32LE(o.idxStart + (found + 1) * 8 + 4)
  const out = new Map()
  let p = o.payloadStart + start
  const stop = o.payloadStart + end
  let cur = 0
  while (p < stop) {
    let shift = 0, v = 0, b
    do { b = o.raw[p++]; v |= (b & 0x7f) << shift; shift += 7 } while (b & 0x80)
    cur += v
    const q = o.raw[p++]
    out.set(cur, -q / o.scale)
  }
  return out
}

function stratOccurrence(fx, K = 25, opts = {}) {
  const T = opts.T ?? 0.00845     // FITTED with beta on the 11k leak-free set
  const beta = opts.beta ?? 1.33  // weight on log P(species|cell)
  const ctx = fx.context || {}
  let c = ground(fx).sort((a, b) => b.score - a.score).slice(0, K)
  if (!c.length) return []
  // fixtures store softmax(sim/0.01); recover the raw-similarity scale
  c = c.map(x => ({ ...x, sim: 0.01 * Math.log(Math.max(x.score, 1e-12)) }))
  if (ctx.lat == null || ctx.lon == null) {
    return c.sort((a, b) => b.sim - a.sim).slice(0, 5).map(x => x.commonName)
  }
  const { x, y } = eeProj(ctx.lon, ctx.lat)
  const cell = xyToCell(x, y)
  const m = cell ? occCell(cell.row, cell.col) : null
  if (!m) {
    // no coverage -> vision only, by design
    return c.sort((a, b) => b.sim - a.sim).slice(0, 5).map(x => x.commonName)
  }
  const FLOOR = Math.log(1e-9)
  c = c.map(x => {
    const lp = x.appIdx != null && m.has(x.appIdx) ? m.get(x.appIdx) : FLOOR
    return { ...x, post: x.sim / T + beta * lp }
  })
  return c.sort((a, b) => b.post - a.post).slice(0, 5).map(x => x.commonName)
}

const truth = JSON.parse(readFileSync(join(ROOT, 'ml/truth.json'), 'utf8'))
const baseTruth = {}; for (const [k, v] of Object.entries(truth)) baseTruth[k.replace(/\.[^.]+$/, '')] = v
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()

const args = process.argv.slice(2)
const fxDir = args.includes('--fixtures') ? args[args.indexOf('--fixtures') + 1] : join(ROOT, 'ml/fixtures')

const strategies = {
  'A_production(0.2 floor,slice5,range)': fx => stratProd(fx),
  'D_tiered_nogate_1neighbor': fx => { TIERED_EXPANDED = false; return stratTiered(fx, 15) },
  'D_tiered_nogate_8neighbor': fx => { TIERED_EXPANDED = true; return stratTiered(fx, 15) },
  'F_gated_dom0.5_1neighbor': fx => stratGated(fx, 15, { domMargin: 0.5 }),
  'G_gated_dom0.5_8neighbor': fx => stratGated(fx, 15, { domMargin: 0.5, expanded: true }),
  'H_bayes_logsum': fx => stratBayes(fx, 25, { expanded: true }),
  'I_occurrence_SHIPPING': fx => stratOccurrence(fx, 25),
}

const results = {}
for (const name of Object.keys(strategies)) results[name] = { n: 0, t1: 0, t5: 0 }
const perImage = []

for (const file of readdirSync(fxDir).filter(f => f.endsWith('.json'))) {
  const base = file.replace(/\.json$/, '')
  const gt = baseTruth[base]
  if (!gt) continue
  const fx = JSON.parse(readFileSync(join(fxDir, file), 'utf8'))
  const row = { base, gt }
  for (const [name, fn] of Object.entries(strategies)) {
    const preds = fn(fx)
    const h1 = norm(preds[0]) === norm(gt)
    const h5 = preds.some(p => norm(p) === norm(gt))
    results[name].n++; if (h1) results[name].t1++; if (h5) results[name].t5++
    row[name] = h1 ? 'Y' : (h5 ? '5' : '.')
  }
  perImage.push(row)
}

const mainStrat = 'G_gated_dom0.5_8neighbor'
console.log(`${'image'.padEnd(46)} ${'truth'.padEnd(22)}  A  G`)
for (const r of perImage) console.log(`${r.base.slice(0, 46).padEnd(46)} ${r.gt.slice(0, 22).padEnd(22)}  ${r['A_production(0.2 floor,slice5,range)']}  ${r[mainStrat]}`)
console.log('-'.repeat(80))
for (const [name, s] of Object.entries(results)) {
  console.log(`${name.padEnd(42)} top-1 ${s.t1}/${s.n}=${(s.t1 / s.n * 100).toFixed(0)}%  top-5 ${s.t5}/${s.n}=${(s.t5 / s.n * 100).toFixed(0)}%`)
}
console.log(`\nGPT-5.4mini (reference)                    top-1 83%  top-5 87%`)

// ── dominance-margin sweep to confirm the gate isn't overfit ──
if (process.argv.includes('--sweep')) {
  console.log('\n=== dominance-margin sweep (Strategy F) ===')
  for (const dm of [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7]) {
    let n = 0, t1 = 0, t5 = 0
    for (const file of readdirSync(fxDir).filter(f => f.endsWith('.json'))) {
      const base = file.replace(/\.json$/, ''); const gt = baseTruth[base]; if (!gt) continue
      const fx = JSON.parse(readFileSync(join(fxDir, file), 'utf8'))
      const preds = stratGated(fx, 15, { domMargin: dm })
      n++; if (norm(preds[0]) === norm(gt)) t1++; if (preds.some(p => norm(p) === norm(gt))) t5++
    }
    console.log(`  domMargin=${dm.toFixed(2)}  top-1 ${t1}/${n}=${(t1 / n * 100).toFixed(0)}%  top-5 ${t5}/${n}=${(t5 / n * 100).toFixed(0)}%`)
  }
}
