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
 *   models/text_classifier_int8.bin     11167 x 768 int8 + per-row fp32 scales
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
import { preloadAssets, type AssetProgress } from './model-cache'
import { preprocess, type Rgb } from './clip-preprocess'
import { parseOccurrence, type OccBlob } from './occurrence'
import { rankCandidates, scoresToProbs, type Calibration, type Candidate } from './rank'

export type IdentifyResult = {
  commonName: string
  scientificName: string
  taxonIdx: number
  confidence: number
  /** Null when no geographic prior applied, so the caller can say so. */
  logP: number | null
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

    // Cache-first and SEQUENTIAL. 61.66 MiB in four parallel streams competes
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
    this.text = decodeInt8Rows(new Uint8Array(textBuf), EMBED_DIM)
    this.nSpecies = this.text.length / EMBED_DIM
    if (!Number.isInteger(this.nSpecies)) {
      throw new Error("text classifier length " + this.text.length +
                      " is not a multiple of " + EMBED_DIM)
    }
    if (this.nSpecies !== a.taxonomy.length) {
      throw new Error("text classifier has " + this.nSpecies +
                      " species but taxonomy has " + a.taxonomy.length)
    }

    // gzip is decoded by DecompressionStream, present in all target browsers.
    const raw = await gunzip(new Uint8Array(occBuf))
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
    if (!this.session || !this.text) throw new Error("call init() first")

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
      confidence: probs[i],
      logP: s.logP,
    }))
  }
}

/**
 * Decode the int8 classifier: an int8 matrix followed by fp32 per-row scales.
 * Row s is q[s] * scale[s].
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

async function gunzip(buf: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip")
  const stream = new Blob([buf as BlobPart]).stream().pipeThrough(ds)
  const out = await new Response(stream).arrayBuffer()
  return new Uint8Array(out)
}
