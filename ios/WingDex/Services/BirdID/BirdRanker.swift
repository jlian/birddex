import Foundation

/// Strategy I, the shipping ranker.
///
///     score = sim / T + beta * log P(species | cell, month)
///
/// Port of src/lib/rank.ts. T and beta are FITTED per model: T sets the scale
/// on which similarity trades against the geographic prior, so reusing another
/// model's T silently mis-weights the prior.
///
/// Cells with no occurrence data fall back to vision-only ranking, which is a
/// graceful degradation rather than a confident wrong answer.
enum BirdRanker {
    /// Absent-from-cell floor. The shipped temperature and beta were fitted at 1e-12.
    static let occFloor = log(1e-12)

    struct Calibration: Sendable, Equatable {
        let temperature: Double
        let beta: Double
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
        if let occurrence, let location,
           let cell = EqualEarth.cell(lat: location.lat, lon: location.lon) {
            cellPriors = occurrence.cellPriors(row: cell.row, col: cell.col, month: month)
        }

        let scored = candidates.map { c -> Scored in
            // A species absent from a POPULATED cell gets occFloor, not zero and
            // not -infinity. Zero would treat "never observed here" as neutral,
            // and -infinity would hard-veto genuine rarities.
            let logP: Double? = cellPriors.map { $0[c.idx] ?? occFloor }
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
