/**
 * Does the optimised selection return EXACTLY the old candidate set?
 *
 * rank_parity.ts exercises the ranker but not the engine internals, and the
 * two changes here are inside BirdIdEngine: a 4-way unrolled dot product and a
 * partial top-K instead of a full sort.
 *
 * Unrolling changes floating-point ASSOCIATIVITY, so sums can differ in the
 * last bits. That is normally harmless but it can reorder two candidates whose
 * similarities are within an ulp, which would silently change results. So this
 * compares the old and new implementations directly on real embeddings.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import ort from 'onnxruntime-node'

const ROOT = process.argv[2]
const EMBED = 768
const K = 25

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

const tb = readFileSync(join(ROOT, "public/models/text_classifier_fp16.bin"))
const text = f16ToF32(new Uint16Array(tb.buffer, tb.byteOffset, tb.length / 2))
const N = text.length / EMBED

const session = await ort.InferenceSession.create(
  join(ROOT, "public/models/wingclip_visual_int8.onnx"))
const meta = JSON.parse(readFileSync(join(ROOT, "ml/parity/meta.json"), "utf8"))

function simsNaive(emb: Float32Array, norm: number): Float32Array {
  const out = new Float32Array(N)
  for (let s = 0; s < N; s++) {
    let acc = 0
    const base = s * EMBED
    for (let i = 0; i < EMBED; i++) acc += text[base + i] * emb[i]
    out[s] = acc / norm
  }
  return out
}

function simsUnrolled(emb: Float32Array, norm: number): Float32Array {
  const out = new Float32Array(N)
  for (let s = 0; s < N; s++) {
    const base = s * EMBED
    let a = 0, b = 0, c = 0, d = 0
    for (let i = 0; i < EMBED; i += 4) {
      a += text[base + i] * emb[i]
      b += text[base + i + 1] * emb[i + 1]
      c += text[base + i + 2] * emb[i + 2]
      d += text[base + i + 3] * emb[i + 3]
    }
    out[s] = (a + b + c + d) / norm
  }
  return out
}

function topFull(sims: Float32Array): number[] {
  const idx = Array.from(sims.keys())
  idx.sort((a, b) => sims[b] - sims[a])
  return idx.slice(0, K)
}

function topPartial(sims: Float32Array): number[] {
  const bi: number[] = []
  const bv: number[] = []
  let worst = -Infinity
  for (let s = 0; s < N; s++) {
    const v = sims[s]
    if (bi.length === K && v <= worst) continue
    let p = bi.length
    while (p > 0 && bv[p - 1] < v) p--
    bi.splice(p, 0, s)
    bv.splice(p, 0, v)
    if (bi.length > K) { bi.pop(); bv.pop() }
    worst = bv[bv.length - 1]
  }
  return bi
}

let n = 0
let setSame = 0
let orderSame = 0
let maxDelta = 0

for (const ph of meta.photos) {
  const tag = String(ph.i).padStart(3, "0")
  const t = new Float32Array(
    readFileSync(join(ROOT, "ml/parity/js_" + tag + ".f32.bin")).buffer.slice(0))
  const o = await session.run({ [session.inputNames[0]]:
    new ort.Tensor("float32", t, [1, 3, 224, 224]) })
  const emb = o[session.outputNames[0]].data as Float32Array
  let norm = 0
  for (let i = 0; i < EMBED; i++) norm += emb[i] * emb[i]
  norm = Math.sqrt(norm) || 1

  const sa = simsNaive(emb, norm)
  const sb = simsUnrolled(emb, norm)
  for (let i = 0; i < N; i++) {
    const d = Math.abs(sa[i] - sb[i])
    if (d > maxDelta) maxDelta = d
  }

  const oldSel = topFull(sa)
  const newSel = topPartial(sb)
  n++
  if (oldSel.join(",") === newSel.join(",")) orderSame++
  if (new Set(oldSel).size === new Set([...oldSel, ...newSel]).size) setSame++
}

console.log("")
console.log("photos:                 " + n)
console.log("max |sim| difference:   " + maxDelta.toExponential(3))
console.log("identical candidate SET: " + setSame + "/" + n)
console.log("identical ORDER too:     " + orderSame + "/" + n)
console.log("")
if (setSame === n && orderSame === n) console.log("SELECTION PARITY PASS")
else { console.log("SELECTION PARITY FAIL"); process.exit(1) }
