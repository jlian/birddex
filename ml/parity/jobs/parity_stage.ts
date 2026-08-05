/** Which stage breaks parity: the resize, or the crop? */
import { readFileSync } from 'fs'
import { join } from 'path'
import { resizeShorterSide, centerCrop } from './clip-preprocess.ts'

const DIR = process.argv[2]
const meta = JSON.parse(readFileSync(join(DIR, "meta.json"), "utf8"))
const rmeta = JSON.parse(readFileSync(join(DIR, "resize_meta.json"), "utf8"))

function readU8(p: string): Uint8Array {
  const b = readFileSync(p)
  return new Uint8Array(b.buffer, b.byteOffset, b.length)
}

let worstR = 0
let worstH = 0
const rows: string[] = []

for (const ph of meta.photos) {
  const tag = String(ph.i).padStart(3, "0")
  const src = readU8(join(DIR, "src_" + tag + ".u8.bin"))
  const want = readU8(join(DIR, "rs_" + tag + ".u8.bin"))
  const wantH = readU8(join(DIR, "hz_" + tag + ".u8.bin"))
  const dims = rmeta[String(ph.i)]

  const r = resizeShorterSide({ data: src, width: ph.w, height: ph.h }, 224)

  if (r.width !== dims.nw || r.height !== dims.nh) {
    console.log(`  [${tag}] DIM MISMATCH js ${r.width}x${r.height} vs pil ${dims.nw}x${dims.nh}`)
    continue
  }

  let mx = 0
  for (let i = 0; i < want.length; i++) {
    let v = Math.round(r.data[i])
    if (v < 0) v = 0
    if (v > 255) v = 255
    const d = Math.abs(v - want[i])
    if (d > mx) mx = d
  }
  if (mx > worstR) worstR = mx

  rows.push(`  [${tag}] ${ph.w}x${ph.h} -> ${dims.nw}x${dims.nh}`.padEnd(34) +
            `resize max |d| ${String(mx).padStart(4)} (uint8 levels)`)
}

console.log(rows.join("\n"))
console.log("")
console.log("worst resize diff: " + worstR + " uint8 levels")
console.log("")
if (worstR <= 1) {
  console.log("RESIZE OK -> the fault is in the CROP")
} else {
  console.log("RESIZE MISMATCH -> the fault is in the resampling")
}
