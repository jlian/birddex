/**
 * Client-side bird identification: ONNX vision tower plus the Strategy I ranker.
 *
 * Replaces the server-side GPT call in functions/lib/bird-id.ts. The model runs
 * in the browser, so identification costs nothing per request and works offline
 * once the weights are cached.
 *
 * Assets, all served from public/:
 *   models/wingclip_visual_int8.onnx    13.72 MiB graph
 *   models/wingclip_visual_int8.data    24.00 MiB weights, external data
 *   models/text_classifier_int8.bin     11168 x 768 int8 + per-row fp32 scales
 *                                       (11167 species, then the bird probe)
 *   priors/occurrence.<hash>.bin.gz     15.71 MiB v3 geographic prior
 *
 * The .data file is referenced by the `location` string inside the graph, and
 * onnxruntime-web cannot read the file system, so it must be handed over
 * through the externalData session option. A path mismatch produces
 * "Failed to load external data file, File not found in preloaded files".
 */

// The `/wasm` entry point, NOT the package root. The root re-exports every
// backend, so the bundler emits the jsep (WebGPU) runtime at 25.58 MiB, which
// exceeds the 25 MiB Workers per-file cap and makes the whole deploy fail.
// This entry ships only the plain WASM runtime at 12.86 MiB, which is also the
// provider measured fastest for a model this small.
import * as ort from 'onnxruntime-web/wasm'
import ortWasmModuleUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url'
import ortWasmBinaryUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import { preloadAssets, type AssetProgress } from './model-cache'
import { preprocess, type Rgb } from './clip-preprocess'
import { parseOccurrence, type OccBlob } from './occurrence'
import { rankCandidates, scoresToProbs, type Calibration, type Candidate } from './rank'

ort.env.wasm.wasmPaths = {
  mjs: ortWasmModuleUrl,
  wasm: ortWasmBinaryUrl,
}

export type IdentifyResult = {
  commonName: string
  scientificName: string
  taxonIdx: number
  /**
   * Displayed confidence: P_cal * P(species | bird).
   *
   * The probe multiplier is the SAME positive scalar on every candidate of one
   * photo, so it cannot reorder them. See the order assertion in
   * bird-id-probe.test.ts, which measures that rather than assuming it.
   */
  confidence: number
  /** Null when no geographic prior applied, so the caller can say so. */
  logP: number | null
  /**
   * Calibrated P(bird) for the whole photo. Identical across the candidates of
   * one identify() call; carried per result only because that is the shape the
   * caller already consumes.
   */
  pBird: number
}

export type EngineAssets = {
  modelUrl: string
  modelDataUrl: string
  textClassifierUrl: string
  occurrenceUrl: string
  taxonomy: Array<[string, string, ...unknown[]]>
  taxonomySha16: string
  calibration: Calibration
}

const EMBED_DIM = 768

export class BirdIdEngine {
  private session: ort.InferenceSession | null = null
  private text: Float32Array | null = null
  /** Last row of the classifier: the 768-d bird/not-bird probe weights. */
  private probeW: Float32Array | null = null
  private nSpecies = 0
  private occ: OccBlob | null = null
  private readonly assets: EngineAssets
  private readonly onProgress?: (p: AssetProgress) => void
  private readonly totalBytes: number

  constructor(
    assets: EngineAssets,
    onProgress?: (p: AssetProgress) => void,
    totalBytes = 0,
  ) {
    this.assets = assets
    this.onProgress = onProgress
    this.totalBytes = totalBytes
  }

  /** Load once. Safe to call repeatedly; later calls are no-ops. */
  async init(): Promise<void> {
    if (this.session) return
    const a = this.assets

    // Cache-first and SEQUENTIAL. 56.39 MiB in four parallel streams competes
    // for bandwidth on a phone and makes progress reporting meaningless.
    const urls = [a.modelUrl, a.modelDataUrl, a.textClassifierUrl, a.occurrenceUrl]
    const bufs = await preloadAssets(urls, this.onProgress, this.totalBytes)
    const modelBuf = bufs.get(a.modelUrl)!
    const dataBuf = bufs.get(a.modelDataUrl)!
    const textBuf = bufs.get(a.textClassifierUrl)!
    const occBuf = bufs.get(a.occurrenceUrl)!

    // The key MUST equal the `location` string baked into the graph, which is
    // the bare file name. Strip any cache-busting query string first.
    const dataName = a.modelDataUrl.split("/").pop()!.split("?")[0]
    this.session = await ort.InferenceSession.create(modelBuf, {
      // WASM ONLY, measured. 318 ms/image against 516 ms for WebGPU on this
      // model, with 192 ms session setup against 1753 ms. WebGPU loses because
      // dispatch, buffer upload and readback exceed the compute for a model
      // this small.
      //
      // Listing "webgpu" at all pulls in the jsep runtime build, which is
      // 25.58 MiB and EXCEEDS the 25 MiB Workers per-file cap, so the deploy
      // is rejected outright. Plain WASM is 12.86 MiB. Keeping a fallback that
      // is both slower and undeployable costs 12.72 MiB for nothing.
      executionProviders: ["wasm"],
      externalData: [{ path: dataName, data: new Uint8Array(dataBuf) }],
    })

    // int8 with PER-ROW scales, selected in G17 over all 24,633 NABirds
    // images: 8.22 MiB at 86.96 top-1 against fp32 32.72 MiB at 86.91. A
    // single global scale scored 86.88, because one scale cannot cover 11,167
    // unrelated species embeddings. Round-trip row cosine is 0.999866 worst.
    const rows = decodeInt8Rows(new Uint8Array(textBuf), EMBED_DIM)
    const nRows = rows.length / EMBED_DIM
    if (!Number.isInteger(nRows)) {
      throw new Error("text classifier length " + rows.length +
                      " is not a multiple of " + EMBED_DIM)
    }

    // The LAST row is the bird/not-bird probe, not a species. Splitting it off
    // here keeps the similarity loop below exactly as wide as the taxonomy, so
    // the probe can never appear as a candidate.
    //
    // The count check is what catches a stale cached classifier: an older
    // 11167-row file decodes fine and would otherwise silently hand its last
    // SPECIES row to the probe. That is why MODEL_VERSION moved with these
    // bytes.
    this.nSpecies = nRows - 1
    if (this.nSpecies !== a.taxonomy.length) {
      throw new Error("text classifier has " + this.nSpecies +
                      " species rows plus a probe row but taxonomy has " +
                      a.taxonomy.length)
    }
    this.text = rows.subarray(0, this.nSpecies * EMBED_DIM)
    this.probeW = rows.subarray(this.nSpecies * EMBED_DIM)

    // Servers disagree about whether a .gz asset is a gzip body or a gzip-encoded
    // one, so the bytes arrive raw or already decoded depending on the host.
    const raw = await gunzipIfNeeded(new Uint8Array(occBuf))
    this.occ = parseOccurrence(raw, a.taxonomySha16)
  }

  /**
   * Identify one image. `loc` is optional; without it the ranker degrades to
   * vision-only rather than guessing a location.
   */
  async identify(
    img: Rgb,
    loc: { lat: number; lon: number } | null,
    /** 1-12 from EXIF. Without it a v3 prior cannot be used at all. */
    month?: number,
    topK = 5,
  ): Promise<IdentifyResult[]> {
    if (!this.session || !this.text || !this.probeW) {
      throw new Error("call init() first")
    }

    // preprocess() resizes the SHORTER side to 248 then centre-crops 224.
    // The tensor stays 224: the ONNX input is fixed at [1, 3, 224, 224], and
    // only the resize target changed. See clip-preprocess.ts.
    const px = preprocess(img)
    const input = new ort.Tensor("float32", px, [1, 3, 224, 224])
    const inputName = this.session.inputNames[0]
    const out = await this.session.run({ [inputName]: input })
    const emb = out[this.session.outputNames[0]].data as Float32Array

    // L2-normalise, since the text classifier is already normalised and the
    // dot product is then a cosine.
    let norm = 0
    for (let i = 0; i < EMBED_DIM; i++) norm += emb[i] * emb[i]
    norm = Math.sqrt(norm) || 1

    // Bird/not-bird probe on the SAME normalised embedding the species
    // similarity uses. P_raw = sigmoid(w . e + bias), then a Platt map onto a
    // calibrated P(bird). This is deliberately OUTSIDE the species softmax: a
    // "not a bird" class inside it would compete with the species and change
    // which one wins, whereas a multiplier applied afterwards scales all of
    // them equally and preserves the ranking.
    const probe = this.assets.calibration.probe
    const pw = this.probeW
    let dot = 0
    for (let i = 0; i < EMBED_DIM; i++) dot += pw[i] * emb[i]
    const pRaw = sigmoid(dot / norm + probe.bias)
    const pBird = sigmoid(probe.plattA * logit(pRaw) + probe.plattB)

    // Full 11167-way similarity, then keep the top 25 for reranking.
    // Four accumulators so the JIT does not serialise on a single one.
    // 23.51 ms to 16.22 ms on a Cortex-A76. EMBED_DIM is 768, so no tail.
    const sims = new Float32Array(this.nSpecies)
    const text = this.text
    for (let s = 0; s < this.nSpecies; s++) {
      const base = s * EMBED_DIM
      let a = 0, b = 0, c = 0, d = 0
      for (let i = 0; i < EMBED_DIM; i += 4) {
        a += text[base + i] * emb[i]
        b += text[base + i + 1] * emb[i + 1]
        c += text[base + i + 2] * emb[i + 2]
        d += text[base + i + 3] * emb[i + 3]
      }
      sims[s] = (a + b + c + d) / norm
    }

    // Partial top-K, not a full sort. Sorting all 11167 to take 25 measured
    // 5.90 ms against 0.16 ms here on a Cortex-A76, for identical output.
    const K = 25
    const bi: number[] = []
    const bv: number[] = []
    let worst = -Infinity
    for (let s = 0; s < this.nSpecies; s++) {
      const v = sims[s]
      if (bi.length === K && v <= worst) continue
      let p = bi.length
      while (p > 0 && bv[p - 1] < v) p--
      bi.splice(p, 0, s)
      bv.splice(p, 0, v)
      if (bi.length > K) { bi.pop(); bv.pop() }
      worst = bv[bv.length - 1]
    }
    const cands: Candidate[] = bi.map(i => ({ idx: i, sim: sims[i] }))

    const scored = rankCandidates(cands, this.assets.calibration, this.occ, loc, month)
    const probs = scoresToProbs(scored)

    return scored.slice(0, topK).map((s, i) => ({
      commonName: String(this.assets.taxonomy[s.idx][0]),
      scientificName: String(this.assets.taxonomy[s.idx][1]),
      taxonIdx: s.idx,
      // P_cal * P(species | bird). probs[] is already the ranked softmax, so
      // this only rescales it; `scored` fixed the order before pBird was ever
      // multiplied in.
      confidence: pBird * probs[i],
      logP: s.logP,
      pBird,
    }))
  }
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

/**
 * Inverse of sigmoid, clamped.
 *
 * The probe saturates on obvious birds, and Float32 rounds those to exactly 1,
 * where an unclamped logit is +Infinity and the Platt map returns NaN. EPS
 * matches the 1e-7 clip the Platt pair was fitted under, so the clamp is part
 * of the fitted function rather than a patch over it.
 */
function logit(p: number): number {
  const EPS = 1e-7
  const c = p < EPS ? EPS : p > 1 - EPS ? 1 - EPS : p
  return Math.log(c / (1 - c))
}

/**
 * Decode the int8 rows: an int8 matrix followed by fp32 per-row scales.
 * Row s is q[s] * scale[s]. The last row is the probe, not a species.
 */
function decodeInt8Rows(buf: Uint8Array, dim: number): Float32Array {
  // n*dim int8 bytes + n*4 scale bytes = buf.length, so n = len / (dim + 4).
  const n = Math.floor(buf.length / (dim + 4))
  // Flooring a truncated classifier would drop the tail rows silently and then
  // fail much later as a species-count mismatch, or not at all if the count
  // happened to line up. An exact division is the only valid input.
  if (n < 1 || n * (dim + 4) !== buf.length) {
    throw new Error("text classifier is " + buf.length +
                    " bytes, not a whole number of " + (dim + 4) + "-byte rows")
  }
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

/**
 * Decompress the occurrence blob, unless the transport already did it.
 *
 * Cloudflare serves the .gz asset as an opaque body, so the raw gzip arrives and
 * has to be decoded here. `wrangler dev` instead labels it `Content-Encoding: gzip`
 * off the file extension, so the browser decodes it in transit and this receives
 * the 24 MiB payload rather than the 16 MiB file. The gzip magic says which
 * happened, and it cannot collide: a decoded blob starts with "WDOP".
 */
export async function gunzipIfNeeded(buf: Uint8Array): Promise<Uint8Array> {
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) return buf
  const ds = new DecompressionStream("gzip")
  const writer = ds.writable.getWriter()
  void writer.write(buf)
  void writer.close()
  const out = await new Response(ds.readable).arrayBuffer()
  return new Uint8Array(out)
}
