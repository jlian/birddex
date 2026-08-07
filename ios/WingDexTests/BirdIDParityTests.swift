@testable import WingDex
import XCTest

/// Parity between the Swift bird-ID math and the TypeScript it was ported from.
///
/// The vectors come from src/__tests__/birdid-golden.test.ts, which pins the
/// web output to Fixtures/birdid-golden.json. Two implementations of the same
/// math drift, and the failure mode is silent: a mis-keyed cell or a shifted
/// month still returns a plausible ranked list. Regenerate both sides with
/// `UPDATE_GOLDEN=1 npx vitest run birdid-golden` from the repo root.
final class BirdIDParityTests: XCTestCase {
    // MARK: Golden fixture

    private struct Golden: Decodable {
        struct Cell: Decodable { let row: Int; let col: Int }
        struct Point: Decodable {
            let name: String
            let lat: Double
            let lon: Double
            let x: Double
            let y: Double
            let cell: Cell?
        }
        struct CellPrior: Decodable {
            let name: String
            let row: Int
            let col: Int
            let month: Int
            let count: Int?
            let sample: [[Double]]?
        }
        struct BadMonth: Decodable { let month: Int; let count: Int? }
        struct Candidate: Decodable { let idx: Int; let sim: Double }
        struct ScoredRow: Decodable {
            let idx: Int
            let sim: Double
            let score: Double
            let logP: Double?
        }
        struct RankCase: Decodable {
            let name: String
            let lat: Double?
            let lon: Double?
            let month: Int?
            let scored: [ScoredRow]
            let probs: [Double]
        }
        struct Calibration: Decodable { let temperature: Double; let beta: Double }

        let taxonomySha16: String
        let calibration: Calibration
        let blobVersion: Int
        let blobTaxHash: String
        let candidates: [Candidate]
        let projection: [Point]
        let cellPriors: [CellPrior]
        let badMonths: [BadMonth]
        let ranking: [RankCase]
    }

    /// Fixtures live beside this source file, not in a bundle: the raw prior is
    /// 23 MiB and generated, so it is gitignored rather than embedded.
    private static let fixtureDir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .appendingPathComponent("Fixtures")

    private static func loadGolden() throws -> Golden {
        let url = fixtureDir.appendingPathComponent("birdid-golden.json")
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(Golden.self, from: data)
    }

    private static func loadBlob(_ g: Golden) throws -> OccurrenceBlob {
        let url = fixtureDir.appendingPathComponent("occurrence.bin")
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw XCTSkip(
                "Missing \(url.path). Generate it with "
                + "`UPDATE_GOLDEN=1 npx vitest run birdid-golden` from the repo root."
            )
        }
        return try OccurrenceBlob(raw: [UInt8](Data(contentsOf: url)),
                                  taxonomySha16: g.taxonomySha16)
    }

    // MARK: Projection

    func testEqualEarthProjectionMatchesWeb() throws {
        let g = try Self.loadGolden()
        for p in g.projection {
            let got = EqualEarth.project(lon: p.lon, lat: p.lat)
            // Metres. The grid cell is 27 km, so 1e-6 m is far inside the
            // rounding that could change a cell.
            XCTAssertEqual(got.x, p.x, accuracy: 1e-6, "x for \(p.name)")
            XCTAssertEqual(got.y, p.y, accuracy: 1e-6, "y for \(p.name)")
        }
    }

    func testGridCellMatchesWebIncludingOffGrid() throws {
        let g = try Self.loadGolden()
        var offGrid = 0
        for p in g.projection {
            let got = EqualEarth.cell(lat: p.lat, lon: p.lon)
            if let want = p.cell {
                XCTAssertEqual(got?.row, want.row, "row for \(p.name)")
                XCTAssertEqual(got?.col, want.col, "col for \(p.name)")
            } else {
                offGrid += 1
                XCTAssertNil(got, "\(p.name) should fall outside the grid")
            }
        }
        XCTAssertGreaterThan(offGrid, 0, "fixture should cover the off-grid path")
    }

    // MARK: Occurrence blob

    func testBlobHeaderMatchesWeb() throws {
        let g = try Self.loadGolden()
        let occ = try Self.loadBlob(g)
        XCTAssertEqual(occ.version, g.blobVersion)
        XCTAssertEqual(occ.taxonomyHash, g.blobTaxHash)
    }

    func testBlobRejectsWrongTaxonomyHash() throws {
        let g = try Self.loadGolden()
        let url = Self.fixtureDir.appendingPathComponent("occurrence.bin")
        try XCTSkipUnless(FileManager.default.fileExists(atPath: url.path))
        let raw = [UInt8](try Data(contentsOf: url))
        XCTAssertThrowsError(try OccurrenceBlob(raw: raw, taxonomySha16: "deadbeefdeadbeef")) {
            guard case OccurrenceBlob.ParseError.taxonomyMismatch = $0 else {
                return XCTFail("expected taxonomyMismatch, got \($0)")
            }
        }
        XCTAssertNoThrow(try OccurrenceBlob(raw: raw, taxonomySha16: g.taxonomySha16))
    }

    func testBlobRejectsTruncatedIndex() throws {
        let g = try Self.loadGolden()
        let url = Self.fixtureDir.appendingPathComponent("occurrence.bin")
        try XCTSkipUnless(FileManager.default.fileExists(atPath: url.path))
        // Truncating AFTER the 16-byte header passes magic, version and hash.
        let raw = [UInt8]((try Data(contentsOf: url)).prefix(64))
        XCTAssertThrowsError(try OccurrenceBlob(raw: raw, taxonomySha16: g.taxonomySha16)) {
            guard case OccurrenceBlob.ParseError.truncatedIndex = $0 else {
                return XCTFail("expected truncatedIndex, got \($0)")
            }
        }
    }

    func testCellPriorsMatchWeb() throws {
        let g = try Self.loadGolden()
        let occ = try Self.loadBlob(g)
        for c in g.cellPriors {
            let got = occ.cellPriors(row: c.row, col: c.col, month: c.month)
            guard let count = c.count else {
                XCTAssertNil(got, "\(c.name) month \(c.month) should have no data")
                continue
            }
            XCTAssertEqual(got?.count, count, "species count for \(c.name) month \(c.month)")
            for pair in c.sample ?? [] {
                let idx = Int(pair[0])
                XCTAssertEqual(got?[idx] ?? .nan, pair[1], accuracy: 1e-12,
                               "logP for species \(idx) in \(c.name) month \(c.month)")
            }
        }
    }

    /// The old server API took month 0-11 and iOS sent `component(.month) - 1`.
    /// The v3 blob takes 1-12, so a port that kept the subtraction would send 0
    /// for January and shift every other month back by one, with no error.
    func testRejectsTheOldZeroBasedMonthConvention() throws {
        let g = try Self.loadGolden()
        let occ = try Self.loadBlob(g)
        let ref = g.cellPriors.first { $0.count != nil }!
        for bad in g.badMonths {
            XCTAssertNil(occ.cellPriors(row: ref.row, col: ref.col, month: bad.month),
                         "month \(bad.month) must not resolve")
        }
        XCTAssertNil(occ.cellPriors(row: ref.row, col: ref.col, month: nil),
                     "a v3 blob needs a month")
    }

    // MARK: Ranking

    func testRankingMatchesWeb() throws {
        let g = try Self.loadGolden()
        let occ = try Self.loadBlob(g)
        let cal = BirdRanker.Calibration(temperature: g.calibration.temperature,
                                         beta: g.calibration.beta)
        let cands = g.candidates.map { BirdRanker.Candidate(idx: $0.idx, sim: $0.sim) }

        for c in g.ranking {
            let loc = c.lat.flatMap { lat in c.lon.map { (lat: lat, lon: $0) } }
            let got = BirdRanker.rank(cands, calibration: cal, occurrence: occ,
                                      location: loc, month: c.month)
            XCTAssertEqual(got.map(\.idx), c.scored.map(\.idx), "order for \(c.name)")
            for (i, want) in c.scored.enumerated() {
                XCTAssertEqual(got[i].score, want.score, accuracy: 1e-9,
                               "score \(i) for \(c.name)")
                if let wantLogP = want.logP {
                    XCTAssertEqual(got[i].logP ?? .nan, wantLogP, accuracy: 1e-12,
                                   "logP \(i) for \(c.name)")
                } else {
                    XCTAssertNil(got[i].logP, "logP \(i) for \(c.name) should be nil")
                }
            }
            let probs = BirdRanker.scoresToProbs(got)
            XCTAssertEqual(probs.count, c.probs.count, "prob count for \(c.name)")
            for (i, want) in c.probs.enumerated() {
                XCTAssertEqual(probs[i], want, accuracy: 1e-12, "prob \(i) for \(c.name)")
            }
        }
    }

    func testScoresToProbsIsEmptyForNoCandidates() {
        XCTAssertTrue(BirdRanker.scoresToProbs([]).isEmpty)
    }
}
