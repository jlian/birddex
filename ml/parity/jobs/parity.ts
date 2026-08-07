/**
 * Stage 1 parity: does the TS resize + crop + normalize match PIL?
 *
 * Starts from the SAME decoded RGB pixels PIL saw (src.npz), so any difference
 * is attributable to the resampling math rather than the JPEG decoder. Decoder
 * differences (ICC, EXIF) are stage 2 and need a real browser.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { preprocess } from './clip-preprocess.ts'

const DIR = process.argv[2]
if (!DIR) { console.error("usage: parity.ts <dir>"); process.exit(2) }

function readU8(p: string): Uint8Array {
  const b = readFileSync(p)
  return new Uint8Array(b.buffer, b.byteOffset, b.length)
}

function readF32(p: string): Float32Array {
  const b = readFileSync(p)
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length))
}

const meta = JSON.parse(readFileSync(join(DIR, "meta.json"), "utf8"))

let worstAbs = 0
let worstIdx = -1
let sumAbs = 0
let n = 0
const rows: string[] = []

for (const ph of meta.photos) {
  const tag = String(ph.i).padStart(3, "0")
  const s = readU8(join(DIR, "src_" + tag + ".u8.bin"))
  const want = readF32(join(DIR, "ref_" + tag + ".f32.bin"))
  const got = preprocess({ data: s, width: ph.w, height: ph.h })
  let mx = 0
  let sa = 0
  for (let i = 0; i < want.length; i++) {
    const d = Math.abs(got[i] - want[i])
    if (d > mx) mx = d
    sa += d
  }
  sumAbs += sa
  n += want.length
  if (mx > worstAbs) { worstAbs = mx; worstIdx = ph.i }
  rows.push(`  [${String(ph.i).padStart(2)}] ${String(ph.w)}x${String(ph.h)}`.padEnd(22) +
            `max ${mx.toExponential(2)}  mean ${(sa / want.length).toExponential(2)}`)
}

console.log(rows.join("\n"))
console.log("")
console.log("photos:        " + meta.photos.length)
console.log("worst |diff|:  " + worstAbs.toExponential(3) + "  (photo " + worstIdx + ")")
console.log("mean  |diff|:  " + (sumAbs / n).toExponential(3))
console.log("")
// Normalized CLIP tensors span about -1.79..2.15, so 1e-2 is well under a
// single uint8 step (1/255/0.26 = 0.0147 in normalized units).
const PASS = 1e-2
if (worstAbs <= PASS) {
  console.log("PARITY PASS: worst diff " + worstAbs.toExponential(3) + " <= " + PASS)
} else {
  console.log("PARITY FAIL: worst diff " + worstAbs.toExponential(3) + " > " + PASS)
  process.exit(1)
}
