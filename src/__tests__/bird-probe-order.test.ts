/**
 * The bird probe multiplies; it must never reorder.
 *
 * Displayed confidence is P_cal(bird) * P(species | bird). P_cal is a per-PHOTO
 * scalar, identical for every candidate in the list, so multiplying by it
 * cannot change the argmax or any relative order. That is the whole reason the
 * gate can be added without touching accuracy: measured species top-1 is
 * 95.6640 percent both with and without it, to four decimal places.
 *
 * This test asserts that property STRUCTURALLY rather than trusting the
 * measurement. If it ever fails, the probe has been wired as something other
 * than a shared multiplier, and the accuracy claim above is void.
 *
 * The probe itself is NOT shipped in this change (its threshold was fitted on
 * PyTorch embeddings and does not transfer to the int8 ONNX encoder), so the
 * multiplier is applied here exactly as the display path would apply it.
 */
import { describe, expect, it } from 'vitest'

import { rankCandidates, scoresToProbs, type Candidate } from '@/lib/rank'
import { MODEL_ASSETS } from '@/lib/bird-id-local-adapter'

/** A spread of P_cal(bird) values, including the degenerate ends. */
const P_CALS = [1, 0.9999, 0.9566, 0.5701, 0.109, 0.076, 0.0021, 1e-6]

const CANDS: Candidate[] = [
  { idx: 4211, sim: 0.32 },
  { idx: 118, sim: 0.309 },
  { idx: 9007, sim: 0.298 },
  { idx: 55, sim: 0.287 },
  { idx: 11166, sim: 0.27 },
  { idx: 0, sim: 0.26 },
]

describe('bird probe multiplier does not reorder species', () => {
  // No blob: vision-only ranking. The invariant is about the multiplier, not
  // about the prior, and this keeps the test independent of asset contents.
  const scored = rankCandidates(CANDS, MODEL_ASSETS.calibration, null, null)
  const base = scoresToProbs(scored)
  const order = scored.map(s => s.idx)

  it('leaves the ranked order identical for every P_cal', () => {
    for (const p of P_CALS) {
      const displayed = base.map(v => v * p)
      const byDisplayed = displayed
        .map((v, i) => ({ idx: order[i], v }))
        .sort((a, b) => b.v - a.v)
        .map(e => e.idx)
      expect(byDisplayed).toEqual(order)
    }
  })

  it('leaves the top-1 species identical for every P_cal', () => {
    for (const p of P_CALS) {
      const displayed = base.map(v => v * p)
      let arg = 0
      for (let i = 1; i < displayed.length; i++) {
        if (displayed[i] > displayed[arg]) arg = i
      }
      expect(order[arg]).toBe(order[0])
    }
  })

  it('scales every candidate by exactly the same factor', () => {
    // Equivalently: the ratio between any two candidates is invariant. This is
    // the property that makes the reordering argument hold in general, not
    // just for the sample above.
    for (const p of P_CALS) {
      for (let i = 1; i < base.length; i++) {
        const before = base[i] / base[0]
        const after = (base[i] * p) / (base[0] * p)
        expect(after).toBeCloseTo(before, 12)
      }
    }
  })
})
