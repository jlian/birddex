@testable import WingDex
import XCTest

/// WDOP v4 backoff, checked against a hand-built blob.
///
/// BirdIDParityTests already reads the shipped v4 artifact
/// (public/priors/occurrence.d0abc168.bin.gz), so end-to-end parity against
/// the bytes the app ships is covered there. These tests deliberately do NOT
/// use that file, for three reasons.
///
/// 1. Every quantity is known in closed form. n_cm, the monthly counts and the
///    pooled distribution are chosen here, so the expected logP is DERIVED from
///    the backoff formula rather than copied out of an oracle. A test that
///    reads its expectation from the same artifact it is validating cannot
///    catch a formula error in both implementations at once.
/// 2. The byte layout is hand-checkable. A slice built in a few lines can be
///    read by eye, so a failure points at a specific field (a totals-table
///    offset, a sentinel index entry, a varint delta) instead of at 33 MiB.
/// 3. It exercises cases the shipped blob cannot supply on demand: a cell
///    whose month 3 slice is absent while the cell itself has data, a
///    single-observation cell where backoff has to bite hardest, and a blob
///    truncated inside the totals table, which must throw rather than decode
///    the payload at a shifted offset.
///
/// The numbers were cross-checked against the TypeScript in src/lib/rank.ts
/// running on the real v4 blob; agreement was exact (worst |delta| 0.0 over 18
/// cases spanning a dense cell, a singleton cell, and species present in the
/// pooled slice but absent from the monthly one).
final class OccurrenceV4Tests: XCTestCase {
    // MARK: Blob construction

    /// One slice: an index key and its (species, quantised byte) run.
    private struct Slice {
        let key: UInt32
        let total: UInt32
        let entries: [(idx: Int, q: UInt8)]
    }

    /// Quantise a probability the way ml/distill/jobs/build_prior_blob_month.py
    /// does: q = clamp(round(-log(p) * SCALE), 0, 31).
    private static func quant(_ p: Double) -> UInt8 {
        let v = (-log(max(p, 1e-9)) * OccurrenceBlob.scale).rounded()
        return UInt8(max(0, min(31, v)))
    }

    /// Dequantise back, which is what the reader stores: logP = -q / SCALE.
    private static func dequantLog(_ q: UInt8) -> Double {
        -Double(q) / OccurrenceBlob.scale
    }

    private static func varint(_ v: Int) -> [UInt8] {
        var out: [UInt8] = []
        var n = v
        while true {
            let b = UInt8(n & 0x7f)
            n >>= 7
            if n != 0 { out.append(b | 0x80) } else { out.append(b); return out }
        }
    }

    private static func le32(_ v: UInt32) -> [UInt8] {
        [UInt8(v & 0xff), UInt8((v >> 8) & 0xff), UInt8((v >> 16) & 0xff), UInt8((v >> 24) & 0xff)]
    }

    /// Assemble a WDOP blob. `version` 3 omits the totals table entirely, which
    /// is what makes this a regression test for the v3 path and not just a v4
    /// test: the same reader must place the payload correctly for both.
    private static func makeBlob(version: UInt8, slices: [Slice],
                                 taxHash: [UInt8] = [0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04]) -> [UInt8] {
        let sorted = slices.sorted { $0.key < $1.key }
        var payload: [UInt8] = []
        var index: [(UInt32, UInt32)] = []
        for s in sorted {
            index.append((s.key, UInt32(payload.count)))
            var prev = 0
            for e in s.entries {
                payload += varint(e.idx - prev)
                prev = e.idx
                payload.append(e.q)
            }
        }

        var out: [UInt8] = Array("WDOP".utf8)
        out += [version, 5, 4, 0]
        out += taxHash
        out += le32(UInt32(index.count))
        for (k, off) in index { out += le32(k); out += le32(off) }
        out += le32(0xFFFF_FFFF); out += le32(UInt32(payload.count))
        if version >= 4 {
            // Parallel to the index, same order, one uint32 per entry.
            for s in sorted { out += le32(s.total) }
        }
        out += payload
        return out
    }

    private static func key(row: Int, col: Int, monthCode: Int) -> UInt32 {
        UInt32((row * EqualEarth.gridCols + col) << OccurrenceBlob.monthBits | monthCode)
    }

    // MARK: Fixture

    /// One cell, June, holding a single species out of a 4-species pooled
    /// distribution. This is the case that motivates k > 0: v3 asserts
    /// P = 1.0 from one sighting.
    private static let row = 100
    private static let col = 200
    private static let month = 6
    private static let nCM: UInt32 = 1

    /// Shared calibration for every rank() call in this file.
    ///
    /// T and beta are DELIBERATELY not the shipped values: these tests
    /// assert logP, which rank() computes before either is applied, so
    /// round numbers keep the arithmetic readable. The probe is required
    /// by the type and is set to an identity-ish pass-through, because
    /// nothing here exercises the bird/not-bird gate; BirdIdEngine owns
    /// that and BirdIdProbeTests covers it.
    private static let calibration = BirdRanker.Calibration(
        temperature: 0.05,
        beta: 0.1,
        probe: BirdRanker.BirdProbe(bias: 0, plattA: 1, plattB: 0, threshold: 0))


    /// Monthly: species 7 only, with the full mass (q = 0 means logP = 0).
    private static let monthlyEntries: [(idx: Int, q: UInt8)] = [(7, 0)]
    /// Pooled: four species, one of which (7) is the monthly one.
    private static let pooledProbs: [(idx: Int, p: Double)] =
        [(3, 0.5), (7, 0.25), (11, 0.15), (19, 0.10)]
    private static let nC: UInt32 = 20

    private static func v4Blob() -> [UInt8] {
        makeBlob(version: 4, slices: [
            Slice(key: key(row: row, col: col, monthCode: month - 1),
                  total: nCM, entries: monthlyEntries),
            Slice(key: key(row: row, col: col, monthCode: OccurrenceBlob.pooledMonthCode),
                  total: nC, entries: pooledProbs.map { ($0.idx, quant($0.p)) }),
            // A second cell-month, so the binary search has more than one key
            // to walk and an off-by-one in the totals offset shows up.
            Slice(key: key(row: row, col: col, monthCode: 0),
                  total: 500, entries: [(3, quant(0.9)), (7, quant(0.1))]),
        ])
    }

    // MARK: Header and layout

    func testV4HeaderAndTotals() throws {
        let occ = try OccurrenceBlob(raw: Self.v4Blob())
        XCTAssertEqual(occ.version, 4)
        XCTAssertEqual(occ.taxonomyHash, "deadbeef01020304")
        XCTAssertEqual(occ.total(row: Self.row, col: Self.col, month: Self.month), Int(Self.nCM))
        XCTAssertEqual(occ.total(row: Self.row, col: Self.col, month: 1), 500)
        // month nil resolves the POOLED total, n_c, not a monthly one.
        XCTAssertEqual(occ.total(row: Self.row, col: Self.col, month: nil), Int(Self.nC))
    }

    /// The payload starts after the totals table. Getting that offset wrong by
    /// one table width still decodes, and returns plausible garbage rather than
    /// throwing, so the decoded values are checked and not just the sizes.
    func testV4PayloadIsNotShiftedByTheTotalsTable() throws {
        let occ = try OccurrenceBlob(raw: Self.v4Blob())
        let monthly = try XCTUnwrap(occ.cellPriors(row: Self.row, col: Self.col, month: Self.month))
        XCTAssertEqual(monthly.count, 1)
        XCTAssertEqual(try XCTUnwrap(monthly[7]), 0.0, accuracy: 1e-12)

        let pooled = try XCTUnwrap(occ.pooledPriors(row: Self.row, col: Self.col))
        XCTAssertEqual(pooled.count, Self.pooledProbs.count)
        for (idx, p) in Self.pooledProbs {
            XCTAssertEqual(try XCTUnwrap(pooled[idx]),
                           Self.dequantLog(Self.quant(p)), accuracy: 1e-12,
                           "pooled logP for species \(idx)")
        }
    }

    func testPooledSliceIsNotReachableAsAMonth() throws {
        let occ = try OccurrenceBlob(raw: Self.v4Blob())
        // Month 13 would pack to code 12, the pooled code. The range guard must
        // reject it, or a caller could read the pooled slice as a month.
        XCTAssertNil(occ.cellPriors(row: Self.row, col: Self.col, month: 13))
        XCTAssertNil(occ.total(row: Self.row, col: Self.col, month: 13))
        XCTAssertNil(occ.cellPriors(row: Self.row, col: Self.col, month: 0))
    }

    // MARK: v3 must be untouched

    func testV3BlobHasNoPooledSliceAndNoTotals() throws {
        let v3 = Self.makeBlob(version: 3, slices: [
            Slice(key: Self.key(row: Self.row, col: Self.col, monthCode: Self.month - 1),
                  total: 0, entries: [(7, Self.quant(0.4)), (11, Self.quant(0.6))]),
        ])
        let occ = try OccurrenceBlob(raw: v3)
        XCTAssertEqual(occ.version, 3)
        // A v3 blob carries neither, and the reader must say so rather than
        // reading the first payload bytes as a uint32 count.
        XCTAssertNil(occ.pooledPriors(row: Self.row, col: Self.col))
        XCTAssertNil(occ.total(row: Self.row, col: Self.col, month: Self.month))
        let m = try XCTUnwrap(occ.cellPriors(row: Self.row, col: Self.col, month: Self.month))
        XCTAssertEqual(m.count, 2)
        XCTAssertEqual(try XCTUnwrap(m[7]), Self.dequantLog(Self.quant(0.4)), accuracy: 1e-12)
    }

    /// Against a v3 blob the ranker must return the stored ratio unchanged. If
    /// backoff ever leaked into the v3 path the shipped T and beta would be
    /// mis-fitted with no error anywhere.
    func testV3RankingIsTheUnshrunkRatio() throws {
        let v3 = Self.makeBlob(version: 3, slices: [
            Slice(key: Self.key(row: Self.row, col: Self.col, monthCode: Self.month - 1),
                  total: 0, entries: [(7, Self.quant(0.4)), (11, Self.quant(0.6))]),
        ])
        let occ = try OccurrenceBlob(raw: v3)
        let loc = Self.cellCentre(row: Self.row, col: Self.col)
        let scored = BirdRanker.rank(
            [.init(idx: 7, sim: 0.5), .init(idx: 11, sim: 0.5), .init(idx: 999, sim: 0.5)],
            calibration: Self.calibration,
            occurrence: occ, location: loc, month: Self.month)
        let byIdx = Dictionary(uniqueKeysWithValues: scored.map { ($0.idx, $0.logP) })
        XCTAssertEqual(try XCTUnwrap(byIdx[7] ?? nil),
                       Self.dequantLog(Self.quant(0.4)), accuracy: 1e-12)
        XCTAssertEqual(try XCTUnwrap(byIdx[11] ?? nil),
                       Self.dequantLog(Self.quant(0.6)), accuracy: 1e-12)
        // Absent from a POPULATED cell is the floor, not zero and not -inf.
        XCTAssertEqual(try XCTUnwrap(byIdx[999] ?? nil), BirdRanker.occFloor, accuracy: 1e-12)
    }

    // MARK: Backoff

    /// logP = log((n_scm + k * P_pooled) / (n_cm + k)), computed here from the
    /// closed form rather than from a recorded oracle.
    private static func expectedBackoff(monthlyLogP: Double?, pooledLogP: Double?) -> Double {
        let nscm = monthlyLogP.map { exp($0) * Double(nCM) } ?? 0
        let ppv = pooledLogP.map { exp($0) } ?? 0
        let num = nscm + BirdRanker.occBackoffK * ppv
        guard num > 0 else { return BirdRanker.occFloor }
        return max(log(num / (Double(nCM) + BirdRanker.occBackoffK)), BirdRanker.occFloor)
    }

    private static func cellCentre(row: Int, col: Int) -> (lat: Double, lon: Double) {
        // Invert the projection onto the cell centre. y depends only on lat and
        // is monotonic, so bisect; x is linear in lon at a fixed lat.
        let targetY = EqualEarth.gridOriginY - (Double(row) + 0.5) * EqualEarth.gridCellSize
        var lo = -89.999, hi = 89.999
        for _ in 0..<200 {
            let mid = (lo + hi) / 2
            if EqualEarth.project(lon: 0, lat: mid).y < targetY { lo = mid } else { hi = mid }
        }
        let lat = (lo + hi) / 2
        let targetX = EqualEarth.gridOriginX + (Double(col) + 0.5) * EqualEarth.gridCellSize
        return (lat, targetX / EqualEarth.project(lon: 1, lat: lat).x)
    }

    func testBackoffShrinksASingletonAwayFromCertainty() throws {
        let occ = try OccurrenceBlob(raw: Self.v4Blob())
        let loc = Self.cellCentre(row: Self.row, col: Self.col)
        XCTAssertEqual(EqualEarth.cell(lat: loc.lat, lon: loc.lon),
                       EqualEarth.Cell(row: Self.row, col: Self.col),
                       "fixture cell must round-trip through the projection")

        let scored = BirdRanker.rank(
            [.init(idx: 7, sim: 0.5),    // in monthly and pooled
             .init(idx: 3, sim: 0.5),    // pooled only
             .init(idx: 19, sim: 0.5),   // pooled only, smaller mass
             .init(idx: 999, sim: 0.5)], // in neither
            calibration: Self.calibration,
            occurrence: occ, location: loc, month: Self.month)
        let byIdx = Dictionary(uniqueKeysWithValues: scored.map { ($0.idx, $0.logP) })

        let pooled = try XCTUnwrap(occ.pooledPriors(row: Self.row, col: Self.col))
        XCTAssertEqual(try XCTUnwrap(byIdx[7] ?? nil),
                       Self.expectedBackoff(monthlyLogP: 0.0, pooledLogP: pooled[7]),
                       accuracy: 1e-12)
        XCTAssertEqual(try XCTUnwrap(byIdx[3] ?? nil),
                       Self.expectedBackoff(monthlyLogP: nil, pooledLogP: pooled[3]),
                       accuracy: 1e-12)
        XCTAssertEqual(try XCTUnwrap(byIdx[19] ?? nil),
                       Self.expectedBackoff(monthlyLogP: nil, pooledLogP: pooled[19]),
                       accuracy: 1e-12)

        // The point of k > 0: v3 asserted logP = 0, i.e. P = 1.0, from a single
        // sighting. Backoff must move it strictly below that.
        XCTAssertLessThan(try XCTUnwrap(byIdx[7] ?? nil), 0.0)
        // Absent from BOTH slices is the floor, not -infinity, which would
        // hard-veto rather than rank.
        XCTAssertEqual(try XCTUnwrap(byIdx[999] ?? nil), BirdRanker.occFloor, accuracy: 1e-12)
        XCTAssertTrue((byIdx[999] ?? nil)!.isFinite)
        // A pooled-only species must still beat one absent from everything.
        XCTAssertGreaterThan(try XCTUnwrap(byIdx[3] ?? nil), try XCTUnwrap(byIdx[999] ?? nil))
    }

    /// A dense cell-month must be essentially unchanged: shrinkage of one
    /// pseudo-count against thousands of observations is noise.
    func testBackoffIsNearlyInertOnADenseCell() throws {
        let dense: UInt32 = 6548
        let blob = Self.makeBlob(version: 4, slices: [
            Slice(key: Self.key(row: Self.row, col: Self.col, monthCode: Self.month - 1),
                  total: dense, entries: [(7, Self.quant(0.3)), (11, Self.quant(0.2))]),
            Slice(key: Self.key(row: Self.row, col: Self.col,
                                monthCode: OccurrenceBlob.pooledMonthCode),
                  total: 50000, entries: [(7, Self.quant(0.3)), (11, Self.quant(0.2))]),
        ])
        let occ = try OccurrenceBlob(raw: blob)
        let loc = Self.cellCentre(row: Self.row, col: Self.col)
        let scored = BirdRanker.rank([.init(idx: 7, sim: 0.5)],
                                     calibration: Self.calibration,
                                     occurrence: occ, location: loc, month: Self.month)
        let stored = try XCTUnwrap(
            occ.cellPriors(row: Self.row, col: Self.col, month: Self.month)?[7])
        XCTAssertEqual(try XCTUnwrap(scored[0].logP), stored, accuracy: 5e-4,
                       "a dense cell must move by well under 1e-3")
    }

    /// Without a month the monthly slice is missing, and the gate must keep the
    /// v3 surface: no prior at all, not the pooled prior applied silently.
    func testNoMonthDegradesToVisionOnlyRatherThanPooled() throws {
        let occ = try OccurrenceBlob(raw: Self.v4Blob())
        let loc = Self.cellCentre(row: Self.row, col: Self.col)
        let scored = BirdRanker.rank([.init(idx: 3, sim: 0.5)],
                                     calibration: Self.calibration,
                                     occurrence: occ, location: loc, month: nil)
        XCTAssertNil(scored[0].logP, "no month must mean no prior, not the pooled one")
        XCTAssertEqual(scored[0].score, 0.5 / 0.05, accuracy: 1e-12)
    }

    /// An unpopulated cell-month keeps the v3 behaviour too.
    func testUnpopulatedCellMonthDegradesToVisionOnly() throws {
        let occ = try OccurrenceBlob(raw: Self.v4Blob())
        let loc = Self.cellCentre(row: Self.row, col: Self.col)
        // Month 3 has no slice in the fixture, though the cell does have data.
        let scored = BirdRanker.rank([.init(idx: 3, sim: 0.5)],
                                     calibration: Self.calibration,
                                     occurrence: occ, location: loc, month: 3)
        XCTAssertNil(scored[0].logP)
    }

    func testMissingLocationDegradesToVisionOnly() throws {
        let occ = try OccurrenceBlob(raw: Self.v4Blob())
        let scored = BirdRanker.rank([.init(idx: 7, sim: 0.5)],
                                     calibration: Self.calibration,
                                     occurrence: occ, location: nil, month: Self.month)
        XCTAssertNil(scored[0].logP)
    }

    func testNonFiniteLocationDegradesToVisionOnly() throws {
        let occ = try OccurrenceBlob(raw: Self.v4Blob())
        let scored = BirdRanker.rank([.init(idx: 7, sim: 0.5)],
                                     calibration: Self.calibration,
                                     occurrence: occ,
                                     location: (lat: .nan, lon: 0), month: Self.month)
        XCTAssertNil(scored[0].logP, "a NaN location must not resolve to a cell")
    }

    /// A v4 blob truncated inside the totals table must throw, not decode the
    /// payload at a shifted offset.
    func testTruncatedTotalsTableThrows() throws {
        let full = Self.v4Blob()
        // 16 header + (n+1)*8 index puts the cut inside the totals table.
        let cut = 16 + 4 + (3 + 1) * 8 + 4
        XCTAssertThrowsError(try OccurrenceBlob(raw: [UInt8](full.prefix(cut)))) {
            guard case OccurrenceBlob.ParseError.truncatedIndex = $0 else {
                return XCTFail("expected truncatedIndex, got \($0)")
            }
        }
    }
}
