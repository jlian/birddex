import Foundation

/// Equal Earth (EPSG:8857) projection and grid geometry.
///
/// Port of src/lib/equal-earth.ts. The occurrence prior is keyed by Equal Earth
/// cell, so this decides which cell a photo falls in. A naive lat/lon division
/// would mis-key every lookup, which returns a plausible wrong prior rather
/// than an error, so this stays a straight port and is parity-tested against
/// the TS in BirdIDParityTests.
enum EqualEarth {
    static let gridOriginX = -17_226_000.0
    static let gridOriginY = 8_343_000.0
    static let gridCellSize = 27_000.0
    static let gridCols = 1276
    static let gridRows = 618

    struct Projected: Sendable, Equatable {
        let x: Double
        let y: Double
    }

    struct Cell: Sendable, Equatable {
        let row: Int
        let col: Int
    }

    static func project(lon: Double, lat: Double) -> Projected {
        let a1 = 1.340264, a2 = -0.081106, a3 = 0.000893, a4 = 0.003796
        let a = 6_378_137.0, f = 1.0 / 298.257223563
        let b = a * (1 - f)
        let e2 = 1 - (b * b) / (a * a)
        let e = e2.squareRoot()
        let r = a * (0.5 * (1 + ((1 - e2) / (2 * e)) * log((1 + e) / (1 - e)))).squareRoot()
        let qp = 1 + ((1 - e2) / (2 * e)) * log((1 + e) / (1 - e))
        let lam = lon * .pi / 180
        let phi = lat * .pi / 180
        let sinPhi = sin(phi)
        let eSin = e * sinPhi
        let q = (1 - e2) * (sinPhi / (1 - e2 * sinPhi * sinPhi)
                            - (1 / (2 * e)) * log((1 - eSin) / (1 + eSin)))
        let beta = asin(q / qp)
        let theta = asin((3.0.squareRoot() / 2) * sin(beta))
        let t = theta, t2 = t * t, t6 = t2 * t2 * t2
        let denom = 3 * (a1 + 3 * a2 * t2 + t6 * (7 * a3 + 9 * a4 * t2))
        return Projected(
            x: r * ((2 * 3.0.squareRoot() * lam * cos(t)) / denom),
            y: r * t * (a1 + a2 * t2 + t6 * (a3 + a4 * t2))
        )
    }

    /// Nil when the point falls outside the grid, which is a real case: the
    /// Equal Earth bounding box includes ocean that no cell covers.
    static func cell(x: Double, y: Double) -> Cell? {
        let colD = ((x - gridOriginX) / gridCellSize).rounded(.down)
        let rowD = ((gridOriginY - y) / gridCellSize).rounded(.down)
        guard colD.isFinite, rowD.isFinite else { return nil }
        guard rowD >= 0, rowD < Double(gridRows), colD >= 0, colD < Double(gridCols) else {
            return nil
        }
        return Cell(row: Int(rowD), col: Int(colD))
    }

    static func cell(lat: Double, lon: Double) -> Cell? {
        guard lat.isFinite, lon.isFinite else { return nil }
        let p = project(lon: lon, lat: lat)
        return cell(x: p.x, y: p.y)
    }
}
