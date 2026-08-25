/**
 * Local (on-device) bird identification, drop-in for identifyBirdInPhoto.
 *
 * Same signature and same BirdIdResult shape as the server path in
 * ai-inference.ts, so AddPhotosFlow keeps calling one function and the swap is
 * a routing decision rather than a rewrite.
 *
 * THREE FIELDS THE SERVER RETURNED AND THIS CANNOT (see G21):
 *
 *   cropBox        GPT returned birdCenter and birdSize. A classifier sees the
 *                  whole frame and localises nothing. Left undefined, so the
 *                  auto-crop preview simply never appears.
 *   multipleBirds  Nothing here counts birds. Left undefined. The user knows
 *                  better than a threshold does.
 *   empty results  The server returned zero candidates for "no bird". A
 *                  classifier ALWAYS returns 25 ranked species, so an empty
 *                  list can never mean "no bird found". The AddPhotosFlow
 *                  empty state is therefore still UNREACHABLE on this path.
 *                  Reaching it needs an explicit abstention signal, not an
 *                  empty list. A discriminative bird/not-bird probe was built
 *                  and measured for exactly this, but it is NOT shipped: its
 *                  threshold was fitted on PyTorch embeddings and does not
 *                  transfer to the int8 ONNX encoder this file loads. See the
 *                  parity note in the pull request; do not wire a gate to that
 *                  empty state until the probe is refitted on ONNX outputs.
 *
 * CONFIDENCE. `confidence` is the post-rerank softmax, which is what the gate
 * should read. Measured on the 3,322-photo validation split: at 0.7 it keeps
 * 94.9% of photos at 97.91% accuracy, against 52.1% / 97.81% for a vision-only
 * gate. So prompting below 0.7 asks the user about roughly 5% of uploads.
 */

import { BirdIdEngine, type EngineAssets, type IdentifyResult } from './bird-id-local'
import { assetsCached, type AssetProgress } from './model-cache'
import taxonomy from './taxonomy.json'

interface VisionResult {
  species: string
  confidence: number
  wikiTitle?: string
  plumage?: string
  rangeStatus?: 'present' | 'near-range' | 'out-of-range' | 'no-data'
}

/** Shape the add-photos flow consumes. Named for the server response it replaced. */
export interface BirdIdResult {
  candidates: VisionResult[]
  cropBox?: { x: number; y: number; width: number; height: number }
  multipleBirds?: boolean
  rangeAdjusted?: boolean
}

export function mapIdentifyResults(results: IdentifyResult[]): BirdIdResult {
  return {
    candidates: results.map(result => ({
      species: `${result.commonName} (${result.scientificName})`,
      confidence: result.confidence,
    })),
    rangeAdjusted: results.some(result => result.logP !== null),
  }
}

/**
 * Bumped whenever the served model bytes change. The three /models/ files are
 * served immutable for a year (public/_headers) and the Cache API is
 * cache-first, so a fixed URL would hand every existing user stale bytes after
 * a rebuild; if the tensor dimensions still matched, init would succeed and
 * silently identify the wrong species. The occurrence prior dodges this by
 * carrying its content hash in the FILE NAME, but the model file names are
 * fixed, so they get the same protection through a version query string. It is
 * the combined sha256 prefix of the three files: regenerate it when they change
 * (`cat wingclip_visual_int8.onnx wingclip_visual_int8.data
 * text_classifier_int8.bin | sha256sum`).
 */
export const MODEL_VERSION = "cb8f129a"

/**
 * The four served assets, 67.53 MiB total. Versioned so a new model can never
 * be served from a stale immutable cache entry: the prior carries its CONTENT
 * HASH in the file name, and the three model files carry MODEL_VERSION as a
 * query string that changes the Cache API key. Taxonomy is bundled rather than
 * fetched: it is already in the app, and the prior blob carries a hash of it so
 * a mismatch throws instead of silently mis-keying every species.
 *
 * MODEL_VERSION is deliberately NOT bumped for the v4 prior. It is defined as
 * the combined hash of the three MODEL files, and those bytes are unchanged;
 * the prior moved to a new content-hashed file name, which already gives it a
 * fresh cache key. Bumping it here would evict 52 MiB of correctly cached
 * model data to deliver an identical model.
 */
export const MODEL_ASSET_URLS = [
  `/models/wingclip_visual_int8.onnx?v=${MODEL_VERSION}`,
  `/models/wingclip_visual_int8.data?v=${MODEL_VERSION}`,
  `/models/text_classifier_int8.bin?v=${MODEL_VERSION}`,
  "/priors/occurrence.4f5c1a15.bin.gz",
]

/**
 * Bytes actually transferred, measured with `Accept-Encoding: gzip`.
 *
 * Not the sum of the file sizes. The server compresses the two biggest files
 * in transport (onnx 14.4 -> 10.6 MB, data 25.2 -> 17.3 MB) and the prior is
 * already gzipped on disk, so the real download is well under what `ls` shows.
 * The earlier figure counted only the prior's compression and overstated this
 * by 22 percent. Production may negotiate brotli and send less again.
 *
 * The v4 prior is 21.58 MiB against v3's 15.71 MiB, so the bundle grows by
 * 5.87 MiB (+10.4 percent of the total download). That pays for the pooled
 * per-cell slice and the n_cm table, which are what let the backoff strength
 * live on the client instead of being frozen into the asset.
 */
export const MODEL_BYTES = 10_560_123 + 17_325_400 + 8_620_924 + 22_623_826

/**
 * Bytes exposed to the fetch reader across the four assets.
 *
 * The reader sees transport-compressed responses after decoding, but the prior
 * is already a .gz file served without Content-Encoding, so it stays compressed.
 * This progress total is deliberately not shown to the user: quoting decoded
 * transport sizes is what made the gate claim 72 MB for a 53 MB transfer.
 */
export const MODEL_DECODED_BYTES = 14_386_199 + 25_165_824 + 8_620_924 + 22_623_826

/**
 * The full asset bundle the engine needs.
 *
 * Calibration is inlined rather than fetched. It is 200 bytes, it MUST match
 * the model and the blob version, and shipping it as a fifth request is one
 * more thing to get out of sync.
 *
 * temperature and beta are REFITTED for the v4 blob at OCC_FLOOR = 3e-5 and
 * OCC_BACKOFF_K = 0.3. They are not transferable across either constant: T
 * sets the scale on which similarity trades against the prior, and both the
 * floor and k change the scale of logP. The previous pair
 * (0.007545354776084423 / 0.5435083508491516) was the k = 0 month fit at
 * floor 1e-12 and MUST NOT be used with backoff enabled.
 *
 * Measured on the 3,321-photo validation split: species top-1 95.66 percent,
 * unchanged from the previous shipped configuration.
 */
export const MODEL_ASSETS: EngineAssets = {
  modelUrl: MODEL_ASSET_URLS[0],
  modelDataUrl: MODEL_ASSET_URLS[1],
  textClassifierUrl: MODEL_ASSET_URLS[2],
  occurrenceUrl: MODEL_ASSET_URLS[3],
  taxonomy: taxonomy as EngineAssets["taxonomy"],
  taxonomySha16: "04951673b96b11bf",
  calibration: { temperature: 0.007435, beta: 1.1634 },
}

/**
 * Prompt below this. Measured on 400 labelled held-out photos plus 393
 * Imagenette non-birds: 0.8 keeps 93% of real birds and rejects 76% of dog
 * photos, against 95% / 70% at 0.7.
 *
 * A dog is the hard case and no threshold fixes it, because this is zero-shot
 * cosine over 11,167 BIRD names with no "not a bird" class, so a furry
 * four-legged animal lands somewhere plausible. Dogs come back as African
 * Penguin and Sooty Owl. A pre-rerank vision gate was measured as an
 * alternative and is WORSE on dogs (32.5% pass at 0.3 against 30% here) while
 * costing 17 points of bird coverage, so it is not shipped.
 */
export const CONFIDENCE_PROMPT_THRESHOLD = 0.8

/**
 * Format a confidence for display.
 *
 * Confidence is never actually zero, but 91% of the 2nd-to-5th candidates fall
 * below 0.5% and round to a flat "0%", which reads as "impossible" rather than
 * "very unlikely". 0.005 is exactly where integer rounding starts producing 0,
 * so below it the value is reported as a bound instead.
 *
 * The number itself is left alone. Measured against ground truth it is well
 * calibrated (mean 0.963 against 94.3% accuracy, ECE 0.021) and refitting a
 * display temperature made it worse.
 */
export function formatConfidence(confidence: number): string {
  if (!Number.isFinite(confidence) || confidence < 0) return "-"
  if (confidence < 0.005) return "<0.5%"
  return `${Math.round(confidence * 100)}%`
}

let enginePromise: Promise<BirdIdEngine> | null = null

/** True when every asset is already local, so identification is instant. */
export function modelReady(): Promise<boolean> {
  return assetsCached(MODEL_ASSET_URLS)
}

/**
 * Download the model without identifying anything.
 *
 * Exists so the UI can pull 61.66 MiB behind a progress bar at a moment the
 * user chose, instead of discovering it mid-identification. Calling it twice
 * is safe: the second call resolves off the cache.
 */
export function preloadModel(
  assets: EngineAssets,
  onProgress?: (p: AssetProgress) => void,
): Promise<BirdIdEngine> {
  return getEngine(assets, onProgress)
}

/**
 * Load the engine once per session. The assets are 61.66 MiB, so this is
 * called on first identify rather than at page load, and the browser cache
 * makes every later session free.
 */
export function getEngine(
  assets: EngineAssets,
  onProgress?: (p: AssetProgress) => void,
): Promise<BirdIdEngine> {
  if (!enginePromise) {
    const engine = new BirdIdEngine(assets, onProgress, MODEL_DECODED_BYTES)
    enginePromise = engine.init().then(() => engine).catch(err => {
      // Reset so a transient network failure does not poison the session.
      enginePromise = null
      throw err
    })
  }
  return enginePromise
}

/**
 * Read pixel dimensions from a JPEG header without decoding it.
 *
 * Walks the marker segments looking for a Start Of Frame. SOF0/1/2 are
 * baseline, extended and progressive; the rest of the SOFn range is skipped
 * along with DHT (c4), DNL (c8) and DAC (cc), which share the same high
 * nibble but are not frame headers. Returns null for anything that is not a
 * JPEG, which the caller treats as "decode normally".
 */
export async function readJpegSize(blob: Blob): Promise<{ width: number; height: number } | null> {
  // 64 KiB covers EXIF, ICC profiles and thumbnails ahead of the frame header.
  const head = new DataView(await blob.slice(0, 65536).arrayBuffer())
  if (head.byteLength < 4 || head.getUint16(0) !== 0xffd8) return null
  let off = 2
  while (off + 9 < head.byteLength) {
    if (head.getUint8(off) !== 0xff) return null
    const marker = head.getUint8(off + 1)
    const size = head.getUint16(off + 2)
    if (size < 2) return null
    const isSof =
      marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      return { height: head.getUint16(off + 5), width: head.getUint16(off + 7) }
    }
    off += 2 + size
  }
  return null
}
/**
 * Decode to an ImageBitmap, capped at DECODE_CAP on the long side.
 *
 * Falls back to HTMLImageElement when createImageBitmap is unavailable or
 * rejects. The cap preserves aspect ratio: passing only resizeWidth would
 * stretch the image, and resizeShorterSide() downstream assumes square
 * pixels.
 */
async function decodeScaled(dataUrl: string): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      const blob = await (await fetch(dataUrl)).blob()
      // Read the dimensions from the JPEG header rather than decoding a probe
      // bitmap. Decoding twice, once at full size to measure and once scaled,
      // would allocate the very buffer this function exists to avoid.
      const dim = await readJpegSize(blob)
      if (!dim) return await createImageBitmap(blob)
      const long = Math.max(dim.width, dim.height)
      if (long <= DECODE_CAP) return await createImageBitmap(blob)
      const scale = DECODE_CAP / long
      return await createImageBitmap(blob, {
        resizeWidth: Math.max(1, Math.round(dim.width * scale)),
        resizeHeight: Math.max(1, Math.round(dim.height * scale)),
        resizeQuality: "high",
      })
    } catch {
      // Fall through: a decoder that cannot do this is not an error.
    }
  }
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image()
    i.onload = () => resolve(i)
    i.onerror = reject
    i.src = dataUrl
  })
}

/**
 * Longest side we ask the decoder for. The model sees 224x224 after a resize
 * to 248 on the SHORTER side (see clip-preprocess.ts: the checkpoint's timm
 * config is 248 -> 224, not 224 -> 224), so anything above ~500 is detail the
 * tensor throws away. 500 also matches the size the model was trained and
 * calibrated on: the iNat corpus is "medium", 500px on the long side.
 *
 * Deliberately UNCHANGED by the 224 -> 248 resize fix. 500 is a LONG-side cap
 * and the resize target is a SHORT-side target, so the cap only starts
 * discarding useful detail once the aspect ratio exceeds 500/248 = 2.02,
 * against 500/224 = 2.23 before. Both are past the point where a bird photo is
 * mostly sky, and the training-corpus argument for 500 is the stronger one
 * anyway.
 */
const DECODE_CAP = 500

/**
 * Decode a data URL to raw pixels, asking the decoder to scale DURING decode
 * when it can.
 *
 * A JPEG is DCT coefficients, not pixels, so there is no way to resize before
 * decoding. What IS possible is decoding at reduced scale: libjpeg discards
 * high-frequency coefficients per 8x8 block and reconstructs at 1/2, 1/4 or
 * 1/8, so the full-size bitmap is never allocated. createImageBitmap exposes
 * this through resizeWidth/resizeHeight.
 *
 * Measured on 27 real photos up to 25.6 MP: 334.5 MP decoded drops to 24.6 MP
 * and 1338 MB of RGBA drops to 99 MB, a 13.6x reduction. The worst single
 * photo, 4128x6192, goes from 102 MB to 2 MB.
 *
 * This DOES change the tensor. An earlier comment here refused a canvas-side
 * downscale because it moved values by up to 1.99; scaled decode moves them
 * more, because the intermediate lands on a different resampling chain. That
 * was worth re-testing rather than assuming, and accuracy is unchanged:
 * ABSOLUTE top-1 on the 3,322-photo held-out split is 95.09 with the month
 * prior against 95.00 for full-resolution decode, with the vision-only arms
 * inside 0.12 points. The perturbation lands on texture the classifier does
 * not key on.
 *
 * Safari has createImageBitmap but ignores the resize options, and unknown
 * dictionary members are silently dropped rather than throwing. Those users
 * get a full-size bitmap and today's memory profile, not a failure:
 * resizeShorterSide() reads width/height off the actual input, so the tensor
 * is identical either way. The iOS app should downscale natively instead.
 */
async function toRgb(
  dataUrl: string,
): Promise<{ data: Uint8ClampedArray; width: number; height: number; channels: number }> {
  const bitmap = await decodeScaled(dataUrl)
  const canvas = document.createElement("canvas")
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  if (!ctx) throw new Error("canvas 2d unavailable")
  ctx.drawImage(bitmap, 0, 0)
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data

  // Hand the RGBA buffer to preprocess() directly instead of packing it down to
  // RGB first. That copy cost another 3 bytes per source pixel, 72 MB on a 24MP
  // photo, purely to drop an alpha channel the resampler can simply skip.
  //
  // Full resolution is still passed on purpose: letting the canvas downscale
  // first applies ITS resampling, which does not match PIL and would break the
  // parity the preprocessing work established. Measured on real photos, a
  // canvas-side resize moves the tensor by up to 1.99 per value (cosine 0.98),
  // and capping at 640 was no worse than 2000, which shows the damage is the
  // FILTER mismatch rather than lost detail.
  return { data: d, width: canvas.width, height: canvas.height, channels: 4 }
}

export async function identifyBirdLocally(
  assets: EngineAssets,
  imageDataUrl: string,
  location?: { lat: number; lon: number },
  month?: number,
): Promise<BirdIdResult> {
  const engine = await getEngine(assets)
  const rgb = await toRgb(imageDataUrl)
  const results: IdentifyResult[] = await engine.identify(
    rgb,
    location ?? null,
    month,
    5,
  )

  // rangeStatus is BirdLife vocabulary. The Bayesian prior has no notion of
  // present or out-of-range, only a probability, so it is omitted rather than
  // faked from a threshold. cropBox and multipleBirds are absent by design.
  return mapIdentifyResults(results)
}

/**
 * Should the app ask the user to crop?
 *
 * Only when the top candidate is below threshold, which is about 5% of
 * uploads. `alreadyPrompted` exists because confidence tracks SPECIES
 * AMBIGUITY, not framing (Pearson 0.051 against relative bird area), so a crop
 * often does not raise it. Prompting again on the cropped image is an infinite
 * loop, and this is the guard against it.
 */
export function shouldPromptForCrop(
  result: BirdIdResult,
  alreadyPrompted: boolean,
): boolean {
  if (alreadyPrompted) return false
  const top = result.candidates[0]
  if (!top) return true
  return top.confidence < CONFIDENCE_PROMPT_THRESHOLD
}
