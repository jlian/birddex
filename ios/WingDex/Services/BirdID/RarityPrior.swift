import Foundation

/// Rarity verdicts read from the bundled rarity asset.
///
/// Port of src/lib/rarity.ts. Answers one question: is this species notable
/// HERE, THIS MONTH.
///
/// This is a SEPARATE asset from the occurrence prior on purpose. The v4 prior
/// is 22.62 MiB gzipped and on web it is only fetched behind ModelDownloadGate
/// on the first identify, but a rarity mark has to render on the WingDex and
/// Outings pages where that blob is not present. Carrying the verdict rather
/// than the probability, on a grid coarsened 4x, gets the same answer in
/// 1.38 MiB, so both platforms can read the same file everywhere.
///
/// Format, little-endian, deliberately shaped like WDOP so the two decoders
/// read alike: "WDRR" magic, version, coarsening factor, 2 reserved bytes, an
/// 8-byte taxonomy hash, n_cells, a sorted (key, offset) index of 8-byte pairs
/// with a sentinel, a uint16-per-cell month mask table PARALLEL to the index,
/// then a payload of varint species-index deltas each followed by a uint16
/// ordinary-month mask.
///
/// Species are keyed by ROW INDEX into taxonomy.json exactly as in WDOP, so the
/// taxonomy hash is verified and a mismatch throws rather than silently
/// mis-keying every verdict.
///
/// NO THRESHOLDS LIVE HERE. Every cut was applied by
/// ml/distill/build_rarity_blob.py where the full record counts still existed.
/// A constant on this side would be a second place for iOS and web to disagree.
struct RarityBlob: Sendable {
    private let raw: [UInt8]
    private let nCells: Int
    private let idxStart: Int
    /// Byte offset of the uint16-per-cell month mask table, between the index
    /// and the payload.
    private let monthsStart: Int
    private let payloadStart: Int
    let version: Int
    let coarse: Int
    let coarseCols: Int
    let taxonomyHash: String

    private static let headerBytes = 20

    enum ParseError: Error, CustomStringConvertible {
        case badMagic(String)
        case tooShort(need: Int, have: Int)
        case truncatedIndex(need: Int, have: Int)
        case badCoarseFactor(Int)
        case taxonomyMismatch(asset: String, expected: String)

        var description: String {
            switch self {
            case .badMagic(let m): "rarity asset: bad magic \(m)"
            case .tooShort(let need, let have):
                "rarity asset too short: need \(need) bytes, have \(have)"
            case .truncatedIndex(let need, let have):
                "rarity asset truncated: index needs \(need) bytes but the asset is \(have)"
            case .badCoarseFactor(let c): "rarity asset: bad coarsening factor \(c)"
            case .taxonomyMismatch(let asset, let expected):
                "rarity asset taxonomy hash \(asset) != taxonomy.json \(expected) -- rebuild the asset"
            }
        }
    }

    init(raw: [UInt8], taxonomySha16: String? = nil) throws {
        guard raw.count >= Self.headerBytes else {
            throw ParseError.tooShort(need: Self.headerBytes, have: raw.count)
        }
        let magic = String(decoding: raw[0..<4], as: UTF8.self)
        guard magic == "WDRR" else { throw ParseError.badMagic(magic) }

        self.raw = raw
        self.version = Int(raw[4])
        self.coarse = Int(raw[5])
        guard coarse >= 1 else { throw ParseError.badCoarseFactor(coarse) }
        self.coarseCols = (EqualEarth.gridCols + coarse - 1) / coarse

        let hash = raw[8..<16].map { String(format: "%02x", $0) }.joined()
        self.taxonomyHash = hash
        if let expected = taxonomySha16, expected != hash {
            throw ParseError.taxonomyMismatch(asset: hash, expected: expected)
        }

        self.nCells = Int(Self.readUInt32(raw, at: 16))
        self.idxStart = Self.headerBytes
        self.monthsStart = idxStart + (nCells + 1) * 8
        self.payloadStart = monthsStart + nCells * 2

        // Magic, version and hash all live in the first 16 bytes, so an asset
        // truncated AFTER that passes every check above and the varint reader
        // then walks off the end and returns a confident wrong verdict.
        guard payloadStart <= raw.count else {
            throw ParseError.truncatedIndex(need: payloadStart, have: raw.count)
        }
    }

    /// Binary-search the index for an exact key. Returns the ARRAY POSITION,
    /// because the month table is parallel to the index and needs that position.
    private func findSlot(_ want: UInt32) -> Int {
        var lo = 0
        var hi = nCells - 1
        while lo <= hi {
            let mid = (lo + hi) / 2
            let key = Self.readUInt32(raw, at: idxStart + mid * 8)
            if key == want { return mid }
            if key < want { lo = mid + 1 } else { hi = mid - 1 }
        }
        return -1
    }

    /// The outcome of looking one species up inside a cell.
    ///
    /// `absent` and `invalid` MUST stay distinct. Absent is the strongest
    /// verdict this asset can give, a bird never recorded in a well-recorded
    /// cell, so collapsing a corrupt payload into it would turn a truncated
    /// asset into a screen full of confident megas. Corruption fails closed.
    private enum MaskLookup {
        case found(UInt16)
        case absent
        case invalid
    }

    /// Walk one cell's payload for a single species.
    private func findMask(slot: Int, speciesIdx: Int) -> MaskLookup {
        let start = Int(Self.readUInt32(raw, at: idxStart + slot * 8 + 4))
        let end = Int(Self.readUInt32(raw, at: idxStart + (slot + 1) * 8 + 4))
        var p = payloadStart + start
        let stop = payloadStart + end
        guard start <= end, stop <= raw.count else { return .invalid }

        var cur = 0
        while p < stop {
            var shift = 0
            var v = 0
            var b: UInt8 = 0
            repeat {
                guard p < stop, shift < 35 else { return .invalid }
                b = raw[p]
                p += 1
                v |= Int(b & 0x7f) << shift
                shift += 7
            } while (b & 0x80) != 0
            // A malformed payload must not trap, so overflow wraps and a
            // negative running index ends the walk instead.
            cur = cur &+ v
            guard cur >= 0, p + 1 < stop else { return .invalid }
            let mask = UInt16(raw[p]) | (UInt16(raw[p + 1]) << 8)
            p += 2
            if cur == speciesIdx { return .found(mask) }
            // Species are stored ascending, so passing the target means absent.
            if cur > speciesIdx { return .absent }
        }
        return .absent
    }

    /// The coarse cell key for a point, or nil when it falls outside the grid,
    /// which is a real case: the Equal Earth box includes ocean no cell covers.
    private func coarseKey(lat: Double, lon: Double) -> UInt32? {
        guard let cell = EqualEarth.cell(lat: lat, lon: lon) else { return nil }
        return UInt32(truncatingIfNeeded:
            (cell.row / coarse) * coarseCols + (cell.col / coarse))
    }

    /// The verdict for one species at one place in one month, keyed by taxonomy
    /// row index. `month` is 1-12.
    ///
    /// Returns `.none` for anything unknown, and that conflation is deliberate:
    /// an undersampled cell, a month with too few records, a point off the grid
    /// and a genuinely ordinary bird must all render as no mark. A false rare on
    /// every bird in an under-recorded region is worse than showing nothing.
    func state(speciesIdx: Int, lat: Double, lon: Double, month: Int) -> RarityState {
        guard speciesIdx >= 0, (1...12).contains(month) else { return .none }
        guard let key = coarseKey(lat: lat, lon: lon) else { return .none }

        let slot = findSlot(key)
        // Cell absent means undersampled. NOT rare.
        guard slot >= 0 else { return .none }

        let monthMask = Self.readUInt16(raw, at: monthsStart + slot * 2)
        // Too few records in this month here to judge anything.
        guard (monthMask >> UInt16(month - 1)) & 1 == 1 else { return .none }

        // A corrupt payload marks nothing. Only a clean miss is the mega.
        switch findMask(slot: slot, speciesIdx: speciesIdx) {
        case .invalid:
            return .none
        case .absent:
            return .both
        case .found(let mask):
            if (mask >> UInt16(month - 1)) & 1 == 1 { return .none }
            return mask == 0 ? .offRange : .outOfSeason
        }
    }

    /// The 12 months in which this species is ordinary here, for the seasonal
    /// readout on species detail. Index 0 is January. Nil when the cell carries
    /// no usable data, which must render as "not enough records" rather than as
    /// a bird that belongs in no month at all.
    func ordinaryMonths(speciesIdx: Int, lat: Double, lon: Double) -> [Bool]? {
        guard speciesIdx >= 0, let key = coarseKey(lat: lat, lon: lon) else { return nil }
        let slot = findSlot(key)
        guard slot >= 0 else { return nil }
        let monthMask = Self.readUInt16(raw, at: monthsStart + slot * 2)
        guard monthMask != 0 else { return nil }
        let mask: UInt16
        switch findMask(slot: slot, speciesIdx: speciesIdx) {
        case .invalid: return nil
        case .absent: mask = 0
        case .found(let m): mask = m
        }
        // A month the cell cannot judge reads as not-ordinary rather than as a
        // gap, because the caller draws 12 bars and a third state has no meaning.
        return (0..<12).map { m in
            (monthMask >> UInt16(m)) & 1 == 1 && (mask >> UInt16(m)) & 1 == 1
        }
    }

    private static func readUInt32(_ b: [UInt8], at i: Int) -> UInt32 {
        UInt32(b[i]) | (UInt32(b[i + 1]) << 8) | (UInt32(b[i + 2]) << 16) | (UInt32(b[i + 3]) << 24)
    }

    private static func readUInt16(_ b: [UInt8], at i: Int) -> UInt16 {
        UInt16(b[i]) | (UInt16(b[i + 1]) << 8)
    }
}

/// Why a bird is notable, or that it is not.
///
/// `offRange` and `outOfSeason` are independent readings and `both` is the
/// genuine vagrant: never meaningfully recorded in a cell that has plenty of
/// records. Measured frequencies on the shipped asset are 1 row in 22, 1 in 66
/// and 1 in 208.
enum RarityState: String, Sendable, Equatable, CaseIterable {
    case none
    case outOfSeason
    case offRange
    case both

    var isMarked: Bool { self != .none }
}
