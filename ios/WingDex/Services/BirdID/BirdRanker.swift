import Foundation

/// Strategy I, the shipping ranker.
///
///     score = sim / T + beta * log P(species | cell, month)
///
/// Port of src/lib/rank.ts. T and beta are FITTED per model: T sets the scale
/// on which similarity trades against the geographic prior, so reusing another
/// model's T silently mis-weights the prior.
///
/// THE PRIOR, AND WHY IT DEPENDS ON THE BLOB VERSION.
///
/// Against a v3 blob the prior is simply n_scm / n_cm, that species' share of
/// all sightings in that cell that month, because that normalised ratio is the
/// only thing v3 stores. n_cm is divided out at build time and is not
/// recoverable, so no shrinkage can be applied on the client at all.
///
/// Against a v4 blob the prior is the Dirichlet-multinomial posterior mean
///
///     P(s | c, m) = (n_scm + k * P(s | c)) / (n_cm + k)
///
/// which shrinks a thin cell-month toward that cell's month-agnostic
/// distribution. v4 ships the pooled slice and n_cm precisely so k can live
/// here, as a client constant, and be retuned without rebuilding the asset.
///
/// Cells with no occurrence data fall back to vision-only ranking, which is a
/// graceful degradation rather than a confident wrong answer.
enum BirdRanker {
    /// Absent-from-cell floor, as a log probability.
    ///
    /// RAISED from 1e-12 to 3e-5, together with occBackoffK dropping to 0.3.
    /// The two MUST move together, and T and beta were refitted at this pair.
    ///
    /// At 1e-12 the gap between a species the pooled slice rescues and one that
    /// stays on the floor is about 13.7 logits, against a realistic similarity
    /// gap of 1.11, so the prior decides the ranking outright and the displayed
    /// probability saturates. At 3e-5 with k = 0.3 the shipped
    /// a0.60/int8/248 path reaches 94.27 percent top-1 on the validation split.
    static let occFloor = log(3e-5)

    /// Dirichlet-multinomial backoff strength, in pseudo-counts. Applied ONLY to
    /// a v4 blob, which carries the pooled slice and n_cm needed to compute it;
    /// a v3 blob ignores this entirely and cannot do otherwise.
    ///
    /// WHY k IS NOT ZERO. On 47.9M occurrence observations a majority of
    /// (species, cell, month) triples are singletons, so at k = 0 the
    /// leave-one-out predictive likelihood is -inf. A single pseudo-count is
    /// the standard weakest-informative choice.
    ///
    /// SHIPPED VALUE IS 0.3, not the 1.0 the leave-one-out fit prefers. k trades
    /// against occFloor: a full pseudo-count combined with the raised floor
    /// pulls thin cells too far toward the pooled distribution.
    ///
    /// This is a CLIENT constant on purpose. Baking it into the blob would
    /// freeze it into a cached, immutable asset and make every retune a full
    /// rebuild and re-download. Changing it requires refitting T and beta.
    static let occBackoffK: Double = 0.3

    struct Calibration: Sendable, Equatable {
        let temperature: Double
        let beta: Double
        /// Bird/not-bird probe, applied AFTER the species softmax and never
        /// inside it. Mirrors Calibration in src/lib/rank.ts.
        let probe: BirdProbe
    }

    /// Calibrated bird/not-bird head.
    ///
    /// `bias` completes the linear probe whose 768-d weight vector is the LAST
    /// row of the int8 text classifier. `plattA`/`plattB` map its raw output
    /// onto a calibrated P(bird). `threshold` is on the CALIBRATED scale.
    /// Mirrors BIRD_PROBE in src/lib/bird-id-local-adapter.ts.
    struct BirdProbe: Sendable, Equatable {
        let bias: Double
        let plattA: Double
        let plattB: Double
        let threshold: Double
    }

    struct Candidate: Sendable, Equatable {
        /// Row index into taxonomy.json.
        let idx: Int
        /// Cosine similarity from the vision tower.
        let sim: Double
    }

    struct Scored: Sendable, Equatable {
        let idx: Int
        let sim: Double
        let score: Double
        /// Nil when no geographic prior applied, so the caller can say so.
        let logP: Double?
    }

    static func rank(
        _ candidates: [Candidate],
        calibration: Calibration,
        occurrence: OccurrenceBlob?,
        location: (lat: Double, lon: Double)?,
        month: Int?
    ) -> [Scored] {
        var cellPriors: [Int: Double]?
        var pooled: [Int: Double]?
        var nCM: Int?
        if let occurrence, let location,
           location.lat.isFinite, location.lon.isFinite,
           let cell = EqualEarth.cell(lat: location.lat, lon: location.lon) {
            cellPriors = occurrence.cellPriors(row: cell.row, col: cell.col, month: month)
            // Backoff is deliberately gated on the MONTHLY slice existing.
            // Without a month, cellPriors returns nil and v3 degrades to
            // vision-only; letting total() fall back to n_c here would instead
            // apply the pooled prior and silently change the no-month and
            // unpopulated-cell-month cases from "no prior" to "month-agnostic
            // prior". That may well be an improvement, but it is a separate
            // product decision from adding shrinkage, and it would arrive
            // unmeasured and unfitted. Keep the v3 fallback surface.
            if occurrence.version >= 4, cellPriors != nil {
                pooled = occurrence.pooledPriors(row: cell.row, col: cell.col)
                nCM = occurrence.total(row: cell.row, col: cell.col, month: month)
            }
        }

        // Backoff needs BOTH the denominator and the distribution to shrink
        // toward. Missing either means falling back to the plain v3 ratio rather
        // than improvising: a missing n_cm treated as zero would silently
        // replace the monthly prior with the pooled one.
        let backoff: (pooled: [Int: Double], nCM: Double)?
        if let pooled, let nCM, occBackoffK > 0 {
            backoff = (pooled, Double(nCM))
        } else {
            backoff = nil
        }

        let scored = candidates.map { c -> Scored in
            let lp = cellPriors?[c.idx]
            var logP: Double?
            if let backoff {
                // n_scm is reconstructed as p_hat * n_cm. p_hat carries the
                // blob's 5-bit quantisation error, but that identical error is
                // already in the ratio the v3 path uses today, so backoff adds
                // no new source of error.
                let nscm = lp.map { exp($0) * backoff.nCM } ?? 0
                let ppv = backoff.pooled[c.idx].map { exp($0) } ?? 0
                let num = nscm + occBackoffK * ppv
                // Absent from BOTH the monthly and the pooled slice: the
                // numerator is exactly zero and log would be -infinity, which
                // hard-vetoes rather than ranking. occFloor keeps the same
                // semantics as the v3 path.
                logP = num > 0 ? log(num / (backoff.nCM + occBackoffK)) : occFloor
            } else {
                // A species absent from a POPULATED cell gets occFloor, not zero
                // and not -infinity. Zero would treat "never observed here" as
                // neutral, and -infinity would hard-veto genuine rarities.
                logP = cellPriors.map { _ in lp ?? occFloor }
            }
            // Never let a floor-only value read as better than the floor.
            if let v = logP, v < occFloor { logP = occFloor }
            let score = c.sim / calibration.temperature + (logP.map { calibration.beta * $0 } ?? 0)
            return Scored(idx: c.idx, sim: c.sim, score: score, logP: logP)
        }

        // JS Array.prototype.sort is stable per spec, and the web ranker relies
        // on that for equal scores. Swift's sort is not stable, so ties fall
        // back to input order explicitly.
        return scored.enumerated()
            .sorted { a, b in
                a.element.score == b.element.score
                    ? a.offset < b.offset
                    : a.element.score > b.element.score
            }
            .map(\.element)
    }

    /// Softmax over the ranked scores, for a calibrated confidence readout.
    static func scoresToProbs(_ scored: [Scored]) -> [Double] {
        // Reading position 0 as the maximum would be silently wrong for any
        // caller that has not already sorted, and overflows exp on NaN scores.
        guard let top = scored.map(\.score).max() else { return [] }
        let ex = scored.map { exp($0.score - top) }
        let sum = ex.reduce(0, +)
        return ex.map { $0 / sum }
    }
}
