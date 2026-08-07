/**
 * Strategy I: the shipping ranker.
 *
 *   score = sim / T + beta * log P(species | cell, month)
 *
 * The month term is worth +1.2 points of absolute top-1, 93.8 to 95.0, with a
 * bootstrap 95% CI of [+0.81, +1.69]. The prior is simply n_scm / n_cm, that
 * species' share of all sightings in that cell that month. A backoff toward the
 * month-agnostic prior was fitted and lands at zero, so thin cell-months need no
 * shrinkage.
 *
 * T and beta are FITTED per model. T sets the scale on which similarity trades
 * against the geographic prior, so reusing another model's T silently
 * mis-weights the prior. Values live in the calibration JSON, not here.
 *
 * No BirdLife range status. The ablation showed it adds 0.30 points once
 * occurrence counts exist, and the fitted alpha lands around 1e-10, which puts
 * the status term about ten orders of magnitude below the counts. It is
 * mathematically inert, so it is not shipped.
 *
 * Cells with no occurrence data fall back to vision-only ranking. That is a
 * graceful degradation rather than a confident wrong answer.
 */

import { lonLatToEqualEarth, xyToCell } from './equal-earth'
import { occCell, type OccBlob } from './occurrence'

/** Absent-from-cell floor. The shipped temperature and beta were fitted at 1e-12. */
export const OCC_FLOOR = Math.log(1e-12)

export type Calibration = {
  temperature: number
  beta: number
}

export type Candidate = {
  /** Row index into taxonomy.json. */
  idx: number
  /** Cosine similarity from the vision tower. */
  sim: number
}

export type Scored = Candidate & {
  score: number
  logP: number | null
}

/**
 * Rank candidates. When `occ` or the location is missing, or the cell carries
 * no data, this degrades to ordering by similarity alone.
 */
export function rankCandidates(
  cands: Candidate[],
  cal: Calibration,
  occ: OccBlob | null,
  loc: { lat: number; lon: number } | null,
  /** 1-12, from photo EXIF. Required by a v3 blob, ignored by v2. */
  month?: number,
): Scored[] {
  const T = cal.temperature
  const beta = cal.beta

  let cellPriors: Map<number, number> | null = null
  if (occ && loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon)) {
    const { x, y } = lonLatToEqualEarth(loc.lon, loc.lat)
    const cell = xyToCell(x, y)
    if (cell) cellPriors = occCell(occ, cell.row, cell.col, month)
  }

  const out: Scored[] = cands.map(c => {
    const lp = cellPriors ? cellPriors.get(c.idx) : undefined
    // A species absent from a POPULATED cell gets OCC_FLOOR, not zero and not
    // -Infinity. Zero would treat "never observed here" as neutral, and
    // -Infinity would hard-veto genuine rarities. This matches the offline
    // harness exactly; the two must not drift.
    const logP = cellPriors ? (lp === undefined ? OCC_FLOOR : lp) : null
    const score = c.sim / T + (logP === null ? 0 : beta * logP)
    return { ...c, score, logP }
  })

  out.sort((a, b) => b.score - a.score)
  return out
}

/** Softmax over the ranked scores, for a calibrated confidence readout. */
export function scoresToProbs(scored: Scored[]): number[] {
  if (!scored.length) return []
  // max(), not scored[0].score. rankCandidates does return sorted output, but
  // reading position 0 as the maximum makes this silently wrong for any other
  // caller, and the softmax would no longer sum to 1.
  let mx = -Infinity
  for (const s of scored) if (s.score > mx) mx = s.score
  const ex = scored.map(s => Math.exp(s.score - mx))
  const sum = ex.reduce((a, b) => a + b, 0)
  return ex.map(e => e / sum)
}
