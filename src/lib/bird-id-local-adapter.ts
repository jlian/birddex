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
 *                  list can never mean "no bird found". Callers must switch to
 *                  the confidence gate below.
 *
 * CONFIDENCE. `confidence` is the post-rerank softmax, which is what the gate
 * should read. Measured on the 3,322-photo validation split: at 0.7 it keeps
 * 94.9% of photos at 97.91% accuracy, against 52.1% / 97.81% for a vision-only
 * gate. So prompting below 0.7 asks the user about roughly 5% of uploads.
 */

import { BirdIdEngine, type EngineAssets, type IdentifyResult } from './bird-id-local.ts'
import { assetsCached, type AssetProgress } from './model-cache.ts'
import taxonomy from './taxonomy.json'
import type { BirdIdResult } from './ai-inference'

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
 * The four served assets, 61.66 MiB total. Versioned so a new model can never
 * be served from a stale immutable cache entry: the prior carries its CONTENT
 * HASH in the file name, and the three model files carry MODEL_VERSION as a
 * query string that changes the Cache API key. Taxonomy is bundled rather than
 * fetched: it is already in the app, and the prior blob carries a hash of it so
 * a mismatch throws instead of silently mis-keying every species.
 */
export const MODEL_ASSET_URLS = [
  `/models/wingclip_visual_int8.onnx?v=${MODEL_VERSION}`,
  `/models/wingclip_visual_int8.data?v=${MODEL_VERSION}`,
  `/models/text_classifier_int8.bin?v=${MODEL_VERSION}`,
  "/priors/occurrence.1fb61779.bin.gz",
]

export const MODEL_BYTES = 64_657_000

/**
 * The full asset bundle the engine needs.
 *
 * Calibration is inlined rather than fetched. It is 200 bytes, it MUST match
 * the model and the blob version, and shipping it as a fifth request is one
 * more thing to get out of sync. temperature and beta are the k=0 month fit,
 * which scored 94.94 percent absolute top-1 on the held-out split.
 */
export const MODEL_ASSETS: EngineAssets = {
  modelUrl: MODEL_ASSET_URLS[0],
  modelDataUrl: MODEL_ASSET_URLS[1],
  textClassifierUrl: MODEL_ASSET_URLS[2],
  occurrenceUrl: MODEL_ASSET_URLS[3],
  taxonomy: taxonomy as EngineAssets["taxonomy"],
  taxonomySha16: "04951673b96b11bf",
  calibration: { temperature: 0.007545354776084423, beta: 0.5435083508491516 },
}

/** Prompt below this. See the coverage table above. */
export const CONFIDENCE_PROMPT_THRESHOLD = 0.7

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
    const engine = new BirdIdEngine(assets, onProgress)
    enginePromise = engine.init().then(() => engine).catch(err => {
      // Reset so a transient network failure does not poison the session.
      enginePromise = null
      throw err
    })
  }
  return enginePromise
}

/** Decode an image data URL to raw RGB, which is what preprocess() wants. */
async function toRgb(
  dataUrl: string,
): Promise<{ data: Uint8ClampedArray; width: number; height: number; channels: number }> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image()
    i.onload = () => resolve(i)
    i.onerror = reject
    i.src = dataUrl
  })
  const canvas = document.createElement("canvas")
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  if (!ctx) throw new Error("canvas 2d unavailable")
  ctx.drawImage(img, 0, 0)
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

  return {
    candidates: results.map(r => ({
      species: r.commonName,
      confidence: r.confidence,
      // rangeStatus is BirdLife vocabulary. The Bayesian prior has no notion
      // of present or out-of-range, only a probability, so it is omitted
      // rather than faked from a threshold.
    })),
    // cropBox and multipleBirds intentionally absent, see the header.
    rangeAdjusted: results.some(r => r.logP !== null),
  }
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
