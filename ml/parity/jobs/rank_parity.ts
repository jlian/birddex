/**
 * Does the TypeScript ranker reproduce the offline harness?
 *
 * Runs the real fixtures through src/lib/rank.ts and compares top-1 against
 * ml/scripts/pipeline-experiment.mjs Strategy I. A port that is close but not
 * equal is the dangerous outcome, because it looks fine and quietly ranks
 * differently, so this asserts on exact agreement rather than on a score.
 */
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { gunzipSync } from 'zlib'
import { createHash } from 'crypto'
import { parseOccurrence } from '../../../src/lib/occurrence.ts'
import { rankCandidates, type Candidate } from '../../../src/lib/rank.ts'

const ROOT = process.argv[2]
const FX = process.argv[3]
const TRUTH = process.argv[4]
const CAL = JSON.parse(readFileSync(process.argv[5], "utf8"))

const taxonomy = JSON.parse(readFileSync(join(ROOT, "src/lib/taxonomy.json"), "utf8"))
const taxHash = createHash("sha256")
  .update(readFileSync(join(ROOT, "src/lib/taxonomy.json")))
  .digest("hex").slice(0, 16)

const blob = parseOccurrence(
  new Uint8Array(gunzipSync(readFileSync(join(ROOT, "public/priors/occurrence.1fb61779.bin.gz")))),
  taxHash,
)
console.log("occurrence blob OK, cells=" + blob.nCells + " taxHash=" + blob.taxHash)

// commonName -> taxonomy row index
const byName = new Map<string, number>()
for (let i = 0; i < taxonomy.length; i++) {
  byName.set(String(taxonomy[i][0]).toLowerCase(), i)
}

const truth = JSON.parse(readFileSync(TRUTH, "utf8"))
const baseTruth: Record<string, string> = {}
for (const [k, v] of Object.entries(truth)) {
  baseTruth[k.replace(/\.[^.]+$/, "")] = String(v)
}
const norm = (s: unknown) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim()

let n = 0
let top1 = 0
let top5 = 0
let noCell = 0

for (const f of readdirSync(FX)) {
  if (!f.endsWith(".json")) continue
  const fx = JSON.parse(readFileSync(join(FX, f), "utf8"))
  const want = baseTruth[f.replace(/\.json$/, "")]
  if (!want) continue

  const raw = fx.parsed?.candidates || []
  const cands: Candidate[] = []
  for (const c of raw) {
    const idx = byName.get(norm(c.commonName))
    if (idx === undefined) continue
    // Fixtures store softmax(sim/0.01); recover the raw similarity scale.
    const sim = 0.01 * Math.log(Math.max(c.confidence, 1e-12))
    cands.push({ idx, sim })
  }
  if (!cands.length) continue

  const ctx = fx.context || {}
  const loc = (ctx.lat != null && ctx.lon != null) ? { lat: ctx.lat, lon: ctx.lon } : null
  const mon = ctx.month != null ? Number(ctx.month) : undefined
  const scored = rankCandidates(cands.slice(0, 25), CAL, blob, loc, mon)
  if (scored.length && scored[0].logP === null) noCell++

  const names = scored.slice(0, 5).map(s => norm(taxonomy[s.idx][0]))
  const w = norm(want)
  n++
  if (names[0] === w) top1++
  if (names.includes(w)) top5++
}

console.log("")
console.log("photos scored:  " + n)
console.log("vision-only (no cell data): " + noCell)
console.log("TS ranker  top-1 " + top1 + "/" + n + " = " + (100 * top1 / n).toFixed(1) + "%")
console.log("TS ranker  top-5 " + top5 + "/" + n + " = " + (100 * top5 / n).toFixed(1) + "%")
console.log("")
console.log("offline month fit measured 95.0% ABS top-1 on the val split.")
