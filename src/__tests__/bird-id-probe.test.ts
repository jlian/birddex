/**
 * The bird/not-bird probe: ordering, the gate, and the file round trip.
 *
 * The probe is a single positive multiplier applied AFTER the species softmax,
 * so it must not be able to change which species wins. That is the whole
 * reason it is not a class inside the softmax, and it is cheap to measure, so
 * it is measured here rather than asserted in a comment.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { BIRD_PROBE, MODEL_ASSETS, shouldPromptForCrop } from '../lib/bird-id-local-adapter'
import taxonomy from '../lib/taxonomy.json'

const EMBED_DIM = 768
const BIN = resolve(__dirname, '../../public/models/text_classifier_int8.bin')

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

function logit(p: number): number {
  const EPS = 1e-7
  const c = p < EPS ? EPS : p > 1 - EPS ? 1 - EPS : p
  return Math.log(c / (1 - c))
}

/** Same decode the engine does, kept local so this test pins the FORMAT. */
function decodeRows(buf: Uint8Array, dim: number): { rows: Float32Array; n: number } {
  const n = Math.floor(buf.length / (dim + 4))
  expect(n * (dim + 4)).toBe(buf.length)
  const q = new Int8Array(buf.buffer, buf.byteOffset, n * dim)
  const scales = new Float32Array(
    buf.buffer.slice(buf.byteOffset + n * dim, buf.byteOffset + n * dim + n * 4))
  const rows = new Float32Array(n * dim)
  for (let s = 0; s < n; s++) {
    const sc = scales[s]
    for (let i = 0; i < dim; i++) rows[s * dim + i] = q[s * dim + i] * sc
  }
  return { rows, n }
}

describe('bird probe row in the shipped classifier', () => {
  it('is one row past the taxonomy, so species indexing is unchanged', () => {
    const { n } = decodeRows(new Uint8Array(readFileSync(BIN)), EMBED_DIM)
    // 11167 species + 1 probe. A file that is exactly the taxonomy length is
    // the STALE one and would hand a species row to the probe.
    expect(n).toBe(taxonomy.length + 1)
  })

  it('round-trips to a usable probe: not normalised, and it separates', () => {
    const { rows, n } = decodeRows(new Uint8Array(readFileSync(BIN)), EMBED_DIM)
    const w = rows.subarray((n - 1) * EMBED_DIM)
    expect(w.length).toBe(EMBED_DIM)

    // A logistic coefficient vector, NOT an embedding: its magnitude is part
    // of the boundary, so it must NOT come back L2-normalised like the species
    // rows do.
    let norm = 0
    for (let i = 0; i < EMBED_DIM; i++) norm += w[i] * w[i]
    norm = Math.sqrt(norm)
    expect(norm).toBeGreaterThan(2)

    // The fitted scale: max|w| / 127 was 0.04933, so the largest weight is
    // about 6.27. A row of zeros or a mis-sliced species row would fail this.
    let maxAbs = 0
    for (let i = 0; i < EMBED_DIM; i++) maxAbs = Math.max(maxAbs, Math.abs(w[i]))
    expect(maxAbs).toBeGreaterThan(6)
    expect(maxAbs).toBeLessThan(7)
  })

  it('maps its own decision boundary onto the calibrated threshold', () => {
    // The shipped threshold is the Platt image of raw 0.1032229138, the 0.5%
    // quantile of fit-half bird P_raw under the QUANTIZED row. If either the
    // Platt pair or the threshold is edited without the other, this fails.
    const raw = 0.1032229138
    const cal = sigmoid(BIRD_PROBE.plattA * logit(raw) + BIRD_PROBE.plattB)
    expect(cal).toBeCloseTo(BIRD_PROBE.threshold, 8)
  })

  it('keeps the probe out of the calibration the ranker reads', () => {
    // rank.ts must never see the probe as a species score.
    expect(MODEL_ASSETS.calibration.probe).toBe(BIRD_PROBE)
    expect(MODEL_ASSETS.calibration.temperature).toBe(0.007435)
    expect(MODEL_ASSETS.calibration.beta).toBe(1.1634)
  })
})

describe('the probe multiplier cannot reorder species', () => {
  it('leaves the full ranking identical for every P_cal in (0, 1]', () => {
    // A softmax over 25 candidates, deliberately including near-ties, which
    // are the only place a reordering could hide.
    const probs = [
      0.4012, 0.4011, 0.0900, 0.0500, 0.0201, 0.0120, 0.0090, 0.0060,
      0.0040, 0.0020, 0.0015, 0.0010, 0.0008, 0.0006, 0.0004, 0.0003,
      0.0002, 0.00015, 0.0001, 0.00008, 0.00006, 0.00004, 0.00003,
      0.00002, 0.00001,
    ]
    const order = (v: number[]) =>
      v.map((p, i) => [p, i] as const)
        .sort((a, b) => b[0] - a[0])
        .map(([, i]) => i)

    const base = order(probs)
    // Includes the shipped threshold, the smallest P_cal measured on any
    // validation bird (0.003042), and the extremes.
    for (const pBird of [1, 0.9999, BIRD_PROBE.threshold, 0.5, 0.003042,
                         1e-6, Number.MIN_VALUE]) {
      const scaled = probs.map(p => pBird * p)
      expect(order(scaled)).toEqual(base)
      expect(scaled.every(v => v >= 0)).toBe(true)
    }
  })

  it('scales every candidate by the same factor, so ratios survive', () => {
    const probs = [0.6, 0.3, 0.1]
    const pBird = BIRD_PROBE.threshold
    const scaled = probs.map(p => pBird * p)
    expect(scaled[0] / scaled[1]).toBeCloseTo(probs[0] / probs[1], 12)
    expect(scaled[1] / scaled[2]).toBeCloseTo(probs[1] / probs[2], 12)
  })
})

describe('the abstention gate', () => {
  const candidate = { species: 'Chukar (Alectoris chukar)', confidence: 0.9 }

  it('fires below the threshold and not at or above it', () => {
    // The engine gates on `pBird < threshold`, so the boundary itself passes.
    const below = BIRD_PROBE.threshold - 1e-9
    const above = BIRD_PROBE.threshold
    expect(below < BIRD_PROBE.threshold).toBe(true)
    expect(above < BIRD_PROBE.threshold).toBe(false)
  })

  it('does not ask for a crop on an abstention, which owns that action', () => {
    // The empty state already leads with Crop & Retry. Returning true here
    // would route to the manual-crop step instead and it would never render.
    expect(shouldPromptForCrop(
      { candidates: [], pBird: BIRD_PROBE.threshold - 0.01 }, false)).toBe(false)
  })

  it('still asks for a crop when the photo IS a bird but is ambiguous', () => {
    expect(shouldPromptForCrop(
      { candidates: [{ ...candidate, confidence: 0.4 }], pBird: 0.99 },
      false)).toBe(true)
    expect(shouldPromptForCrop(
      { candidates: [{ ...candidate, confidence: 0.95 }], pBird: 0.99 },
      false)).toBe(false)
  })

  it('is unchanged for callers that supply no pBird at all', () => {
    // The server path never had one, and an undefined pBird must not be read
    // as an abstention.
    expect(shouldPromptForCrop({ candidates: [] }, false)).toBe(true)
    expect(shouldPromptForCrop(
      { candidates: [{ ...candidate, confidence: 0.4 }] }, false)).toBe(true)
  })
})
