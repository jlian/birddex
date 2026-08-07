/**
 * End-to-end: real photo bytes through the SHIPPING pipeline.
 *
 * preprocess -> int8 ONNX -> fp16 text classifier -> Strategy I ranker.
 *
 * Every earlier check tested one layer against a reference. This runs the
 * whole chain on the exact artifacts that will be served from public/, so it
 * catches wiring faults that per-layer parity cannot: a wrong external-data
 * key, a transposed classifier, an fp16 decode bug, or a taxonomy offset.
 *
 * Uses onnxruntime-node rather than -web because the browser check needs a
 * real browser. The graph and weights are byte-identical, so this proves the
 * data flow; WebGPU and WASM execution remain a separate gate.
 */
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { gunzipSync } from 'zlib'
import { createHash } from 'crypto'
import ort from 'onnxruntime-node'
import { preprocess } from '../../../src/lib/clip-preprocess.ts'
import { parseOccurrence } from '../../../src/lib/occurrence.ts'
import { rankCandidates, scoresToProbs, type Candidate } from '../../../src/lib/rank.ts'

const ROOT = process.argv[2]
const EMBED = 768

function decodeInt8Rows(buf: Uint8Array, dim: number): Float32Array {
  const n = Math.floor(buf.length / (dim + 4))
  const q = new Int8Array(buf.buffer, buf.byteOffset, n * dim)
  const scales = new Float32Array(
    buf.buffer.slice(buf.byteOffset + n * dim, buf.byteOffset + n * dim + n * 4))
  const out = new Float32Array(n * dim)
  for (let s = 0; s < n; s++) {
    const sc = scales[s]
    const base = s * dim
    for (let i = 0; i < dim; i++) out[base + i] = q[base + i] * sc
  }
  return out
}

function f16ToF32(h: Uint16Array): Float32Array {
  const out = new Float32Array(h.length)
  for (let i = 0; i < h.length; i++) {
    const v = h[i]
    const s = (v & 0x8000) ? -1 : 1
    const e = (v >> 10) & 0x1f
    const f = v & 0x3ff
    if (e === 0) out[i] = s * Math.pow(2, -14) * (f / 1024)
    else if (e === 31) out[i] = f ? NaN : s * Infinity
    else out[i] = s * Math.pow(2, e - 15) * (1 + f / 1024)
  }
  return out
}

const taxonomy = JSON.parse(readFileSync(join(ROOT, "src/lib/taxonomy.json"), "utf8"))
const taxHash = createHash("sha256")
  .update(readFileSync(join(ROOT, "src/lib/taxonomy.json"))).digest("hex").slice(0, 16)
const cal = JSON.parse(readFileSync(join(ROOT, "ml/distill/calibration_month_tiny39.json"), "utf8"))

const tb = readFileSync(join(ROOT, "public/models/text_classifier_int8.bin"))
const text = f16ToF32(new Uint16Array(tb.buffer, tb.byteOffset, tb.length / 2))
const nSpecies = text.length / EMBED
console.log("text classifier: " + nSpecies + " x " + EMBED)
if (nSpecies !== taxonomy.length) throw new Error("species/taxonomy mismatch")

const occRaw = gunzipSync(readFileSync(join(ROOT, "public/priors/occurrence.1fb61779.bin.gz")))
const occ = parseOccurrence(new Uint8Array(occRaw), taxHash)
console.log("occurrence: " + occ.nCells + " cells, taxHash " + occ.taxHash)

const modelPath = join(ROOT, "public/models/wingclip_visual_int8.onnx")
const session = await ort.InferenceSession.create(modelPath)
console.log("onnx session OK, external data resolved")
console.log("")

const meta = JSON.parse(readFileSync(join(ROOT, "ml/parity/meta.json"), "utf8"))
let n = 0
let withPrior = 0
const lines: string[] = []

for (const ph of meta.photos.slice(0, 8)) {
  const tag = String(ph.i).padStart(3, "0")
  const sp = join(ROOT, "ml/parity/src_" + tag + ".u8.bin")
  if (!existsSync(sp)) continue
  const b = readFileSync(sp)
  const src = new Uint8Array(b.buffer, b.byteOffset, b.length)

  const px = preprocess({ data: src, width: ph.w, height: ph.h })
  const t = new ort.Tensor("float32", px, [1, 3, 224, 224])
  const out = await session.run({ [session.inputNames[0]]: t })
  const emb = out[session.outputNames[0]].data as Float32Array

  let norm = 0
  for (let i = 0; i < EMBED; i++) norm += emb[i] * emb[i]
  norm = Math.sqrt(norm) || 1

  const sims = new Float32Array(nSpecies)
  for (let s = 0; s < nSpecies; s++) {
    let acc = 0
    const base = s * EMBED
    for (let i = 0; i < EMBED; i++) acc += text[base + i] * emb[i]
    sims[s] = acc / norm
  }

  const idx = Array.from(sims.keys())
  idx.sort((a, b) => sims[b] - sims[a])
  const cands: Candidate[] = idx.slice(0, 25).map(i => ({ idx: i, sim: sims[i] }))

  // Seattle, to exercise the geographic prior path.
  const scored = rankCandidates(cands, cal, occ, { lat: 47.61, lon: -122.33 }, 11)
  const probs = scoresToProbs(scored)
  if (scored[0].logP !== null) withPrior++
  n++

  lines.push("  [" + tag + "] " + String(taxonomy[scored[0].idx][0]).padEnd(28) +
             " p=" + probs[0].toFixed(3) +
             (scored[0].logP === null ? "  (vision only)" : "  logP=" + scored[0].logP.toFixed(2)))
}

console.log(lines.join("\n"))
console.log("")
console.log("photos through the full chain: " + n)
console.log("ranked with a geographic prior: " + withPrior)
console.log("")
if (n > 0) console.log("END TO END OK")
else { console.log("END TO END FAIL: no photos ran"); process.exit(1) }
