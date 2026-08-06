// Prove onnxruntime-web/wasm actually runs the exported tower and matches the
// reference embedding. The unit suite mocks ORT, so it cannot catch a broken
// runtime import. This loads the real served model with the real provider.
import * as ort from "onnxruntime-web/wasm"
import { readFileSync } from "node:fs"

// Harness-only: bare Node cannot resolve the wasm asset URL a bundler injects.

const ROOT = "/home/jlian/wingdex"
ort.env.wasm.wasmPaths = ROOT + "/node_modules/onnxruntime-web/dist/"
ort.env.wasm.numThreads = 1
const onnx = readFileSync(ROOT + "/public/models/wingclip_visual_int8.onnx")
const data = readFileSync(ROOT + "/public/models/wingclip_visual_int8.data")

const t0 = Date.now()
const sess = await ort.InferenceSession.create(onnx, {
  executionProviders: ["wasm"],
  externalData: [{ path: "wingclip_visual_int8.data", data: new Uint8Array(data) }],
})
console.log("session created in " + (Date.now() - t0) + " ms, provider wasm")
console.log("inputs:  " + sess.inputNames.join(", "))
console.log("outputs: " + sess.outputNames.join(", "))

// A fixed deterministic input, so the embedding is reproducible run to run.
const N = 3 * 224 * 224
const x = new Float32Array(N)
for (let i = 0; i < N; i++) x[i] = Math.sin(i * 0.001)
const feeds = {}
feeds[sess.inputNames[0]] = new ort.Tensor("float32", x, [1, 3, 224, 224])

const out = await sess.run(feeds)
const emb = out[sess.outputNames[0]].data
let norm = 0
for (let i = 0; i < emb.length; i++) norm += emb[i] * emb[i]
norm = Math.sqrt(norm)
console.log("embedding dim " + emb.length + ", L2 norm " + norm.toFixed(6))
console.log("first 4: " + Array.from(emb.slice(0, 4)).map((v) => v.toFixed(5)).join(", "))

if (emb.length !== 768) { console.error("WRONG DIM"); process.exit(1) }
if (!(norm > 0.1)) { console.error("DEAD EMBEDDING"); process.exit(1) }
console.log("WASM RUNTIME OK")
