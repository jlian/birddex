/** Find the crop offset that matches PIL, by trying candidates. */
import { readFileSync } from 'fs'
import { join } from 'path'
import { resizeShorterSide } from './clip-preprocess.ts'

const DIR = process.argv[2]
const meta = JSON.parse(readFileSync(join(DIR, "meta.json"), "utf8"))
const rmeta = JSON.parse(readFileSync(join(DIR, "resize_meta.json"), "utf8"))
const MEAN = [0.48145466, 0.4578275, 0.40821073]
const STD = [0.26862954, 0.26130258, 0.27577711]

function readU8(p: string): Uint8Array {
  const b = readFileSync(p)
  return new Uint8Array(b.buffer, b.byteOffset, b.length)
}
function readF32(p: string): Float32Array {
  const b = readFileSync(p)
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length))
}

// Use PIL resize output as the source so ONLY the crop varies.
for (const ph of meta.photos.slice(0, 4)) {
  const tag = String(ph.i).padStart(3, "0")
  const rs = readU8(join(DIR, "rs_" + tag + ".u8.bin"))
  const want = readF32(join(DIR, "ref_" + tag + ".f32.bin"))
  const d = rmeta[String(ph.i)]
  const S = 224

  const cands: Array<[string, number, number]> = [
    ["round", Math.round((d.nw - S) / 2), Math.round((d.nh - S) / 2)],
    ["floor", Math.floor((d.nw - S) / 2), Math.floor((d.nh - S) / 2)],
    ["ceil", Math.ceil((d.nw - S) / 2), Math.ceil((d.nh - S) / 2)],
    ["trunc+1", Math.trunc((d.nw - S) / 2) + 1, Math.trunc((d.nh - S) / 2)],
  ]

  const out: string[] = []
  for (const [name, left, top] of cands) {
    if (left < 0 || top < 0 || left + S > d.nw || top + S > d.nh) {
      out.push(name + "=oob")
      continue
    }
    let mx = 0
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        for (let c = 0; c < 3; c++) {
          const v = rs[((top + y) * d.nw + (left + x)) * 3 + c]
          const got = (v / 255 - MEAN[c]) / STD[c]
          const w = want[c * S * S + y * S + x]
          const dd = Math.abs(got - w)
          if (dd > mx) mx = dd
        }
      }
    }
    out.push(name + "(" + left + "," + top + ")=" + mx.toExponential(2))
  }
  console.log("[" + tag + "] " + d.nw + "x" + d.nh + "  " + out.join("  "))
}
