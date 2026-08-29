/** Write the JS preprocessed tensors so Python and Swift can be checked against them. */
import { readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { preprocess } from '../../../src/lib/clip-preprocess.ts'

const DIR = process.argv[2] ?? resolve(import.meta.dirname, '..')
const meta = JSON.parse(readFileSync(join(DIR, "meta.json"), "utf8"))
for (const ph of meta.photos) {
  const tag = String(ph.i).padStart(3, "0")
  const b = readFileSync(join(DIR, "src_" + tag + ".u8.bin"))
  const src = new Uint8Array(b.buffer, b.byteOffset, b.length)
  const t = preprocess({ data: src, width: ph.w, height: ph.h })
  writeFileSync(join(DIR, "js_" + tag + ".f32.bin"), Buffer.from(t.buffer))
}
console.log("wrote js_*.f32.bin for " + meta.photos.length + " photos")
