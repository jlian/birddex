#!/usr/bin/env node
// Fail the build if any asset exceeds the Cloudflare Workers per-file cap.
//
// Written after CI rejected a deploy for a 25.58 MiB file that was not a model
// at all: importing the onnxruntime-web package ROOT pulls in the jsep WebGPU
// runtime, and the bundler emitted it even though the code asks for the wasm
// provider. Three phases of work went into fitting the models under this cap,
// and a transitive dependency broke it in one import.
//
// The models are checked in and easy to reason about. Bundled assets are not:
// they change when a dependency changes, silently, and the failure appears in
// CI minutes later as a deploy rejection. This makes it a local build error.
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const CAP = 25 * 1024 * 1024
const DIST = "dist"

function walk(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

let files
try {
  files = walk(DIST)
} catch {
  console.error("asset-cap: no dist/ directory. Run the build first.")
  process.exit(1)
}

const over = []
let biggest = { p: "", b: 0 }
for (const p of files) {
  const b = statSync(p).size
  if (b > biggest.b) biggest = { p, b }
  if (b > CAP) over.push({ p, b })
}

const mib = (b) => (b / 1048576).toFixed(2) + " MiB"

if (over.length > 0) {
  console.error("asset-cap: FAIL. Cloudflare Workers rejects assets over 25 MiB.")
  for (const { p, b } of over) console.error("  " + mib(b) + "  " + p)
  console.error("")
  console.error("If this is an onnxruntime file, import onnxruntime-web/wasm")
  console.error("rather than the package root, which bundles every backend.")
  process.exit(1)
}

console.log("asset-cap: OK, " + files.length + " files, biggest " +
            mib(biggest.b) + " (" + biggest.p + ")")
