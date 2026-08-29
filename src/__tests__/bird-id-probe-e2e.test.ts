/**
 * End-to-end check of the SHIPPED probe path against Python ground truth.
 *
 * Reads the real classifier bytes, reimplements exactly what the engine does
 * between the embedding and pBird, and compares against P_cal values computed
 * by ml/distill/probe_e2e_fixture.py on the same embeddings. This is the test
 * that would catch a wrong row offset, a dropped normalisation, or a Platt
 * pair applied in the wrong order.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { BIRD_PROBE } from '../lib/bird-id-local-adapter'

const EMBED_DIM = 768
const BIN = resolve(__dirname, '../../public/models/text_classifier_int8.bin')
const FIX = resolve(__dirname, 'fixtures/probe-e2e.json')

function probeRow(): Float32Array {
  const buf = new Uint8Array(readFileSync(BIN))
  const n = buf.length / (EMBED_DIM + 4)
  const q = new Int8Array(buf.buffer, buf.byteOffset, n * EMBED_DIM)
  const scales = new Float32Array(buf.buffer.slice(
    buf.byteOffset + n * EMBED_DIM, buf.byteOffset + n * EMBED_DIM + n * 4))
  const s = n - 1
  const out = new Float32Array(EMBED_DIM)
  for (let i = 0; i < EMBED_DIM; i++) out[i] = q[s * EMBED_DIM + i] * scales[s]
  return out
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

function logit(p: number): number {
  const EPS = 1e-7
  const c = p < EPS ? EPS : p > 1 - EPS ? 1 - EPS : p
  return Math.log(c / (1 - c))
}

describe('shipped probe path against Python', () => {
  const fixture = JSON.parse(readFileSync(FIX, 'utf8')) as {
    cases: Array<{ set: string; emb: number[]; pRaw: number; pCal: number; flagged: boolean }>
  }
  const w = probeRow()

  it('reproduces P_cal for real birds and real non-birds', () => {
    for (const c of fixture.cases) {
      // The engine divides the dot by the norm rather than normalising first.
      let norm = 0
      for (let i = 0; i < EMBED_DIM; i++) norm += c.emb[i] * c.emb[i]
      norm = Math.sqrt(norm) || 1
      let dot = 0
      for (let i = 0; i < EMBED_DIM; i++) dot += w[i] * c.emb[i]

      const pRaw = sigmoid(dot / norm + BIRD_PROBE.bias)
      const pCal = sigmoid(BIRD_PROBE.plattA * logit(pRaw) + BIRD_PROBE.plattB)

      // Float32 classifier rows against float64 Python, so this is a
      // precision bound, not a tolerance for disagreement.
      expect(pRaw).toBeCloseTo(c.pRaw, 6)
      expect(pCal).toBeCloseTo(c.pCal, 6)
      expect(pCal < BIRD_PROBE.threshold).toBe(c.flagged)
    }
  })

  it('covers both sides of the gate, or it proves nothing', () => {
    const flagged = fixture.cases.filter(c => c.flagged).length
    expect(flagged).toBeGreaterThan(0)
    expect(flagged).toBeLessThan(fixture.cases.length)
  })
})
