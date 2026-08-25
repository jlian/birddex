/**
 * Strategy I: the shipping ranker.
 *
 *   score = sim / T + beta * log P(species | cell, month)
 *
 * The month term is worth +1.2 points of absolute top-1, 93.8 to 95.0, with a
 * bootstrap 95% CI of [+0.81, +1.69].
 *
 * THE PRIOR, AND WHY IT DEPENDS ON THE BLOB VERSION.
 *
 * Against a v3 blob the prior is simply n_scm / n_cm, that species' share of
 * all sightings in that cell that month, because that normalised ratio is the
 * only thing v3 stores. n_cm is divided out at build time and is not
 * recoverable, so no shrinkage can be applied on the client at all.
 *
 * Against a v4 blob the prior is the Dirichlet-multinomial posterior mean
 *
 *   P(s | c, m) = (n_scm + k * P(s | c)) / (n_cm + k)
 *
 * which shrinks a thin cell-month toward that cell's month-agnostic
 * distribution. v4 ships the pooled slice and n_cm precisely so k can live
 * here, as a client constant, and be retuned without rebuilding the asset.
 *
 * WHY k IS NOT ZERO. On 47.9M occurrence observations a majority of
 * (species, cell, month) triples are singletons, so at k = 0 the leave-one-out
 * predictive likelihood is -inf: the held-out sighting is the only one, and
 * removing it makes the model assign the observed event probability zero. A
 * fit that lands at zero is reporting that the training data has no held-out
 * mass to explain, not that shrinkage is unwarranted. A single pseudo-count is
 * the standard weakest-informative choice, and it is what rescues the
 * sparse-cell case where n_cm is in the single digits.
 *
 * SHIPPED VALUE IS 0.3, not the 1.0 the leave-one-out fit prefers. k trades
 * against OCC_FLOOR: a full pseudo-count combined with the raised floor pulls
 * thin cells too far toward the pooled distribution. At k = 0.3 with
 * floor = 3e-5 the validation top-1 is 95.66 percent, identical to k = 1 at
 * the old floor, and the displayed probabilities stop saturating.
 *
 * T and beta are FITTED per model. T sets the scale on which similarity trades
 * against the geographic prior, so reusing another model's T silently
 * mis-weights the prior. Values live in the calibration JSON, not here.
 * Changing k changes the scale of logP, so T and beta MUST be refitted
 * whenever k moves.
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
import { occCell, occCellPooled, occTotal, type OccBlob } from './occurrence'

/**
 * Absent-from-cell floor, as a log probability.
 *
 * RAISED from 1e-12 to 3e-5, together with OCC_BACKOFF_K dropping to 0.3.
 * The two MUST move together, and T and beta were refitted at this pair.
 *
 * WHY 1e-12 IS WRONG ONCE BACKOFF EXISTS. At that floor the gap between a
 * species the pooled slice rescues and one that stays on the floor is about
 * 13.7 logits, while a realistic similarity gap is around 1.11. The prior
 * therefore decides the ranking outright and the displayed probability
 * saturates: John's Guatemala vulture read 99.9999 percent, which is a
 * confident number the evidence does not support.
 *
 * At 3e-5 with k = 0.3 that gap is survivable, the vulture displays 57.0
 * percent, and species top-1 on the 3,321-photo validation split is UNCHANGED
 * at 95.66 percent. The floor buys calibration, not accuracy, which is exactly
 * what it should do.
 */
export const OCC_FLOOR = Math.log(3e-5)

/**
 * Dirichlet-multinomial backoff strength, in pseudo-counts. Applied ONLY to a
 * v4 blob, which carries the pooled slice and n_cm needed to compute it; a v3
 * blob ignores this entirely and cannot do otherwise.
 *
 * This is a CLIENT constant on purpose. Baking it into the blob would freeze
 * it into a cached, immutable asset and make every retune a full rebuild and
 * re-download. Changing it requires refitting T and beta.
 */
export const OCC_BACKOFF_K = 0.3

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
  let pooled: Map<number, number> | null = null
  let nCM: number | null = null
  if (occ && loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon)) {
    const { x, y } = lonLatToEqualEarth(loc.lon, loc.lat)
    const cell = xyToCell(x, y)
    if (cell) {
      cellPriors = occCell(occ, cell.row, cell.col, month)
      // Backoff is deliberately gated on the MONTHLY slice existing. Without a
      // month, occCell returns null and v3 degrades to vision-only; letting
      // occTotal fall back to n_c here would instead apply the pooled prior
      // and silently change the no-month and unpopulated-cell-month cases from
      // "no prior" to "month-agnostic prior". That may well be an improvement,
      // but it is a separate product decision from adding shrinkage, and it
      // would arrive unmeasured and unfitted. Keep the v3 fallback surface.
      if (occ.version >= 4 && cellPriors) {
        pooled = occCellPooled(occ, cell.row, cell.col)
        nCM = occTotal(occ, cell.row, cell.col, month)
      }
    }
  }

  // Backoff needs BOTH the denominator and the distribution to shrink toward.
  // Missing either means falling back to the plain v3 ratio rather than
  // improvising: a missing n_cm treated as zero would silently replace the
  // monthly prior with the pooled one.
  const useBackoff = pooled !== null && nCM !== null && OCC_BACKOFF_K > 0

  const out: Scored[] = cands.map(c => {
    const lp = cellPriors ? cellPriors.get(c.idx) : undefined
    let logP: number | null
    if (useBackoff) {
      // n_scm is reconstructed as p_hat * n_cm. p_hat carries the blob's 5-bit
      // quantisation error, but that identical error is already in the ratio
      // the v3 path uses today, so backoff adds no new source of error.
      const nscm = lp === undefined ? 0 : Math.exp(lp) * (nCM as number)
      const pp = pooled!.get(c.idx)
      const ppv = pp === undefined ? 0 : Math.exp(pp)
      const num = nscm + OCC_BACKOFF_K * ppv
      // Absent from BOTH the monthly and the pooled slice: the numerator is
      // exactly zero and log would be -Infinity, which hard-vetoes rather than
      // ranking. OCC_FLOOR keeps the same semantics as the v3 path.
      logP = num > 0
        ? Math.log(num / ((nCM as number) + OCC_BACKOFF_K))
        : OCC_FLOOR
    } else {
      // A species absent from a POPULATED cell gets OCC_FLOOR, not zero and not
      // -Infinity. Zero would treat "never observed here" as neutral, and
      // -Infinity would hard-veto genuine rarities. This matches the offline
      // harness exactly; the two must not drift.
      logP = cellPriors ? (lp === undefined ? OCC_FLOOR : lp) : null
    }
    // Never let a floor-only value read as better than the floor.
    if (logP !== null && logP < OCC_FLOOR) logP = OCC_FLOOR
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
