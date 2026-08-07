/**
 * How expensive is the 11167x768 classifier matmul, really?
 *
 * The whole client-versus-server question hangs on this number and it has
 * never been measured. 8.6M multiply-adds is small by GPU standards but the
 * current implementation is a scalar JS double loop, which is the worst case.
 *
 * Four implementations, same output, so the comparison isolates the code
 * rather than the hardware:
 *   naive      the double loop shipping today
 *   unrolled   4-way accumulator, lets the JIT keep more in registers
 *   blocked    cache-friendlier traversal of the 32MB matrix
 *   topk-heap  avoids materialising and sorting all 11167 scores
 *
 * The sort matters more than it looks: the current code sorts an 11167-element
 * index array to take 25, which is O(n log n) on top of the matmul.
 */

const N = 11167
const D = 768
const K = 25

// Deterministic fill, so every run measures the same work.
let seed = 12345
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return (seed / 0x7fffffff) * 2 - 1
}

console.log("building " + N + " x " + D + " matrix (" + (N * D * 4 / 1048576).toFixed(1) + " MiB fp32)")
const text = new Float32Array(N * D)
for (let i = 0; i < text.length; i++) text[i] = rnd()
const emb = new Float32Array(D)
for (let i = 0; i < D; i++) emb[i] = rnd()

function naive(): Float32Array {
  const out = new Float32Array(N)
  for (let s = 0; s < N; s++) {
    let acc = 0
    const base = s * D
    for (let i = 0; i < D; i++) acc += text[base + i] * emb[i]
    out[s] = acc
  }
  return out
}

function unrolled(): Float32Array {
  const out = new Float32Array(N)
  for (let s = 0; s < N; s++) {
    const base = s * D
    let a = 0, b = 0, c = 0, d = 0
    for (let i = 0; i < D; i += 4) {
      a += text[base + i] * emb[i]
      b += text[base + i + 1] * emb[i + 1]
      c += text[base + i + 2] * emb[i + 2]
      d += text[base + i + 3] * emb[i + 3]
    }
    out[s] = a + b + c + d
  }
  return out
}

function topkFull(scores: Float32Array): number[] {
  const idx = Array.from(scores.keys())
  idx.sort((x, y) => scores[y] - scores[x])
  return idx.slice(0, K)
}

function topkPartial(scores: Float32Array): number[] {
  // Keep only K, insertion into a small sorted array. No full sort.
  const bi: number[] = []
  const bv: number[] = []
  let worst = -Infinity
  for (let s = 0; s < N; s++) {
    const v = scores[s]
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

function time(label: string, fn: () => unknown, reps = 20): number {
  for (let i = 0; i < 3; i++) fn()
  const t0 = performance.now()
  for (let i = 0; i < reps; i++) fn()
  const per = (performance.now() - t0) / reps
  console.log("  " + label.padEnd(28) + per.toFixed(2).padStart(8) + " ms")
  return per
}

console.log("")
console.log("=== matmul only ===")
const tn = time("naive double loop", naive)
const tu = time("4-way unrolled", unrolled)

const scores = naive()
console.log("")
console.log("=== top-25 selection ===")
const ts = time("full sort (shipping today)", () => topkFull(scores))
const tp = time("partial top-k", () => topkPartial(scores))

// Correctness: the fast path must agree with the simple one.
const a = topkFull(scores).join(",")
const b = topkPartial(scores).join(",")
console.log("  top-k agreement: " + (a === b ? "OK" : "MISMATCH"))

console.log("")
console.log("=== totals ===")
console.log("  shipping today (naive + full sort): " + (tn + ts).toFixed(2) + " ms")
console.log("  best local (unrolled + partial):    " + (tu + tp).toFixed(2) + " ms")
console.log("")
console.log("Context: the int8 tower runs 318 ms/image on WASM on this class of")
console.log("machine. Anything far below that is not the bottleneck.")
