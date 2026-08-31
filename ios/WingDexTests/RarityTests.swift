import XCTest
@testable import WingDex

/// Parity-shaped counterpart to src/__tests__/rarity.test.ts.
///
/// The two decoders are hand-written ports of each other, so the cases here are
/// deliberately the same cases in the same order. A verdict that differs
/// between platforms is the failure this file exists to catch.
final class RarityTests: XCTestCase {
    private let taxHash = "a217aceafc34f8ba"
    private let allMonths: UInt16 = 0xfff

    // Seattle. Any land point works; the key is derived rather than hardcoded so
    // a grid change cannot silently move the fixture into a different cell.
    private let lat = 47.61
    private let lon = -122.33

    private func key(lat: Double, lon: Double, coarse: Int = 4) -> UInt32 {
        let cell = EqualEarth.cell(lat: lat, lon: lon)!
        let coarseCols = (EqualEarth.gridCols + coarse - 1) / coarse
        return UInt32((cell.row / coarse) * coarseCols + (cell.col / coarse))
    }

    /// Encode one WDRR asset in memory. Mirrors ml/distill/build_rarity_blob.py.
    private func buildAsset(
        cells: [(key: UInt32, monthMask: UInt16, species: [(Int, UInt16)])],
        coarse: UInt8 = 4,
        taxHashOverride: String? = nil
    ) -> [UInt8] {
        let sorted = cells.sorted { $0.key < $1.key }

        var payload: [UInt8] = []
        var index: [(UInt32, UInt32)] = []
        for cell in sorted {
            index.append((cell.key, UInt32(payload.count)))
            var prev = 0
            for (idx, mask) in cell.species.sorted(by: { $0.0 < $1.0 }) {
                var d = idx - prev
                prev = idx
                while d >= 0x80 {
                    payload.append(UInt8((d & 0x7f) | 0x80))
                    d >>= 7
                }
                payload.append(UInt8(d))
                payload.append(UInt8(mask & 0xff))
                payload.append(UInt8((mask >> 8) & 0xff))
            }
        }

        var out: [UInt8] = Array("WDRR".utf8)
        out += [1, coarse, 0, 0]
        let hash = taxHashOverride ?? taxHash
        for i in stride(from: 0, to: 16, by: 2) {
            let start = hash.index(hash.startIndex, offsetBy: i)
            let end = hash.index(start, offsetBy: 2)
            out.append(UInt8(hash[start..<end], radix: 16)!)
        }
        out += le32(UInt32(sorted.count))
        for (k, off) in index { out += le32(k) + le32(off) }
        out += le32(0xffff_ffff) + le32(UInt32(payload.count))
        for cell in sorted { out += [UInt8(cell.monthMask & 0xff), UInt8(cell.monthMask >> 8)] }
        out += payload
        return out
    }

    private func le32(_ v: UInt32) -> [UInt8] {
        [UInt8(v & 0xff), UInt8((v >> 8) & 0xff), UInt8((v >> 16) & 0xff), UInt8((v >> 24) & 0xff)]
    }

    private func blob(_ species: [(Int, UInt16)], monthMask: UInt16? = nil) throws -> RarityBlob {
        try RarityBlob(raw: buildAsset(cells: [(
            key: key(lat: lat, lon: lon),
            monthMask: monthMask ?? allMonths,
            species: species
        )]))
    }

    // MARK: - Parsing

    func testRejectsBadMagic() {
        var raw = buildAsset(cells: [])
        raw[0] = 0x58
        XCTAssertThrowsError(try RarityBlob(raw: raw))
    }

    func testRejectsTaxonomyMismatchRatherThanMisKeyingEveryVerdict() {
        let raw = buildAsset(cells: [], taxHashOverride: "ffffffffffffffff")
        XCTAssertThrowsError(try RarityBlob(raw: raw, taxonomySha16: taxHash))
    }

    func testRejectsTruncatedAssetInsteadOfDecodingGarbage() {
        let raw = buildAsset(cells: [(key: 10, monthMask: allMonths, species: [(5, 0xfff)])])
        XCTAssertThrowsError(try RarityBlob(raw: Array(raw[0..<24])))
    }

    // MARK: - Verdicts

    func testMarksNothingForASpeciesOrdinaryThisMonth() throws {
        let b = try blob([(7, allMonths)])
        XCTAssertEqual(b.state(speciesIdx: 7, lat: lat, lon: lon, month: 6), .none)
    }

    func testMarksOutOfSeasonWhenOrdinaryInAnotherMonth() throws {
        // Ordinary November through February only. A June record is the Snowy Owl case.
        let winter: UInt16 = (1 << 10) | (1 << 11) | (1 << 0) | (1 << 1)
        let b = try blob([(7, winter)])
        XCTAssertEqual(b.state(speciesIdx: 7, lat: lat, lon: lon, month: 6), .outOfSeason)
        XCTAssertEqual(b.state(speciesIdx: 7, lat: lat, lon: lon, month: 12), .none)
    }

    func testMarksOffRangeWhenRecordedButOrdinaryInNoMonth() throws {
        let b = try blob([(7, 0)])
        XCTAssertEqual(b.state(speciesIdx: 7, lat: lat, lon: lon, month: 6), .offRange)
    }

    func testMarksBothWhenAbsentFromACellThatHasRecords() throws {
        let b = try blob([(7, allMonths)])
        XCTAssertEqual(b.state(speciesIdx: 99, lat: lat, lon: lon, month: 6), .both)
    }

    func testMarksNothingWhenTheCellIsAbsentBecauseNoDataIsNotRare() throws {
        let b = try blob([(7, allMonths)])
        // Tokyo: a real land point in a cell this fixture does not carry.
        XCTAssertEqual(b.state(speciesIdx: 99, lat: 35.68, lon: 139.69, month: 6), .none)
    }

    func testMarksNothingForAMonthTheCellCannotJudge() throws {
        let b = try blob([(7, 1 << 5)], monthMask: 1 << 5)
        XCTAssertEqual(b.state(speciesIdx: 99, lat: lat, lon: lon, month: 12), .none)
        XCTAssertEqual(b.state(speciesIdx: 99, lat: lat, lon: lon, month: 6), .both)
    }

    func testMarksNothingForAnInvalidMonthRatherThanReadingJanuary() throws {
        let b = try blob([(7, allMonths)])
        for m in [0, 13, -1, 99] {
            XCTAssertEqual(b.state(speciesIdx: 99, lat: lat, lon: lon, month: m), .none)
        }
    }

    func testMarksNothingForAPointOffTheGridOrABadSpeciesIndex() throws {
        let b = try blob([(7, allMonths)])
        XCTAssertEqual(b.state(speciesIdx: 99, lat: .nan, lon: .nan, month: 6), .none)
        XCTAssertEqual(b.state(speciesIdx: -1, lat: lat, lon: lon, month: 6), .none)
    }

    func testFindsASpeciesThatSortsAfterOthersInTheSameCell() throws {
        let b = try blob([(3, allMonths), (400, 0), (9000, allMonths)])
        XCTAssertEqual(b.state(speciesIdx: 400, lat: lat, lon: lon, month: 6), .offRange)
        XCTAssertEqual(b.state(speciesIdx: 9000, lat: lat, lon: lon, month: 6), .none)
        XCTAssertEqual(b.state(speciesIdx: 8999, lat: lat, lon: lon, month: 6), .both)
    }

    func testMarksNothingWhenThePayloadIsCorruptNeverAMega() throws {
        // "Absent from a well-recorded cell" is the STRONGEST verdict this asset
        // gives, so a truncated payload that merely looks absent would turn a
        // bad asset into a screen full of confident megas. Corruption fails
        // closed.
        let raw = buildAsset(cells: [(
            key: key(lat: lat, lon: lon),
            monthMask: allMonths,
            species: [(7, allMonths), (9000, 0)]
        )])
        let intact = try RarityBlob(raw: raw)
        let truncated = try RarityBlob(raw: Array(raw[0..<(raw.count - 3)]))
        XCTAssertEqual(intact.state(speciesIdx: 500, lat: lat, lon: lon, month: 6), .both)
        XCTAssertEqual(truncated.state(speciesIdx: 500, lat: lat, lon: lon, month: 6), .none)
    }

    // MARK: - Seasonal readout

    func testReportsTheMonthsASpeciesIsOrdinaryHere() throws {
        let winter: UInt16 = (1 << 10) | (1 << 11) | (1 << 0)
        let b = try blob([(7, winter)])
        XCTAssertEqual(b.ordinaryMonths(speciesIdx: 7, lat: lat, lon: lon),
                       [true, false, false, false, false, false,
                        false, false, false, false, true, true])
    }

    func testReturnsNilForACellWithNoDataNotTwelveFalseBars() throws {
        let b = try blob([(7, allMonths)])
        XCTAssertNil(b.ordinaryMonths(speciesIdx: 7, lat: 35.68, lon: 139.69))
    }

    func testNeverReportsAMonthTheCellCannotJudgeAsOrdinary() throws {
        let b = try blob([(7, allMonths)], monthMask: 1 << 5)
        XCTAssertEqual(b.ordinaryMonths(speciesIdx: 7, lat: lat, lon: lon),
                       (0..<12).map { $0 == 5 })
    }

    // MARK: - The shipped asset

    func testShippedAssetParsesAgainstTheBundledTaxonomy() throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "rarity", withExtension: "bin"),
                                "rarity.bin missing from the bundle")
        let b = try RarityBlob(raw: [UInt8](try Data(contentsOf: url)),
                               taxonomySha16: BirdIdEngine.taxonomySha16)
        XCTAssertEqual(b.version, 1)
        XCTAssertEqual(b.coarse, 4)
        XCTAssertGreaterThan(b.coarseCols, 0)
        // Middle of the Pacific: no cell, so nothing is ever marked.
        XCTAssertEqual(b.state(speciesIdx: 7, lat: -30, lon: -140, month: 6), .none)
    }

    /// The whole path a row actually takes: RarityStore, the taxonomy name
    /// lookup, and the bundled asset. The unit cases above all run on synthetic
    /// data, so a broken species-name lookup would leave every one of them green
    /// while the app silently marked nothing.
    ///
    /// Cases are the same birding facts asserted by
    /// ml/distill/verify_rarity_blob.py, so the Swift path and the Python
    /// reference cannot disagree.
    @MainActor
    func testStoreResolvesKnownBirdsThroughTheRealTaxonomy() async throws {
        RarityStore.shared.warmUp()
        await prewarmTaxonomyLookups()

        let seattle = (lat: 47.61, lon: -122.33)
        let cases: [(String, Int, RarityState)] = [
            ("American Robin (Turdus migratorius)", 1, .none),
            ("Anna's Hummingbird (Calypte anna)", 1, .none),
            ("Rufous Hummingbird (Selasphorus rufus)", 5, .none),
            ("Rufous Hummingbird (Selasphorus rufus)", 1, .outOfSeason),
            ("Barn Swallow (Hirundo rustica)", 1, .outOfSeason),
            ("Tundra Swan (Cygnus columbianus)", 1, .offRange),
            ("Northern Cardinal (Cardinalis cardinalis)", 6, .both),
        ]
        // A missing or unusable asset makes EVERY verdict .none, which would
        // leave the three "none" cases below passing for the wrong reason.
        XCTAssertNotEqual(
            RarityStore.shared.state(species: "Northern Cardinal (Cardinalis cardinalis)",
                                     lat: seattle.lat, lon: seattle.lon, month: 6),
            .none,
            "bundled rarity asset or taxonomy failed to load"
        )
        for (species, month, expected) in cases {
            let got = RarityStore.shared.state(
                species: species, lat: seattle.lat, lon: seattle.lon, month: month)
            XCTAssertEqual(got, expected, "\(species) in month \(month)")
        }
    }
}
