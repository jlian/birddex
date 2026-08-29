import Foundation

/// Empirical P(species|cell, month) read from the shipped occurrence blob.
///
/// Port of src/lib/occurrence.ts. Format: "WDOP" magic, version, qbits, then
/// for v2+ an 8-byte taxonomy hash, then n_cells, then a sorted (key, offset)
/// index of 8-byte pairs, then a payload of varint species-index deltas each
/// followed by one quantised byte.
///
/// v2 keys by cell and stores P(species|cell). v3 keys by
/// (cell << 4) | (month - 1) and stores P(species|cell, month).
/// v4 adds the two things v3 discarded, so the client can apply backoff:
///   - a POOLED slice per cell holding P(species|cell), under the reserved
///     month code 12 (months use 0..11, so 12..15 are free);
///   - n_cm per index entry, in a uint32 table parallel to the index, inserted
///     BETWEEN the index and the payload.
/// Because v3 stores only the NORMALISED ratio n_scm / n_cm, n_cm is divided
/// out and unrecoverable, so no Dirichlet-multinomial backoff can be applied
/// against a v3 blob at all. v4 stores the denominator instead of baking a
/// chosen k into the probabilities, which keeps k a client constant that can be
/// retuned without rebuilding and re-downloading the asset.
///
/// Species are keyed by ROW INDEX into taxonomy.json. A reordered taxonomy
/// would silently mis-key every prior, so the taxonomy hash is verified and a
/// mismatch throws rather than degrading quietly.
struct OccurrenceBlob: Sendable {
    /// v3 packs month into the low bits of the index key.
    static let monthBits = 4
    static let scale = 2.5
    /// v4 pooled per-cell slice. Months are stored as (month - 1), so the 4-bit
    /// field only ever holds 0..11 and 12 is unused. Reusing the month field
    /// rather than adding a second index means the pooled slice is found by the
    /// SAME binary search, with no extra table and no branch in the hot path.
    static let pooledMonthCode = 12

    private let raw: [UInt8]
    private let nCells: Int
    private let idxStart: Int
    /// v4 only: byte offset of the uint32-per-index-entry n_cm table. For v3 and
    /// earlier this equals payloadStart and is never read.
    private let totalsStart: Int
    private let payloadStart: Int
    let version: Int
    let taxonomyHash: String?

    enum ParseError: Error, CustomStringConvertible {
        case badMagic(String)
        case tooShort(need: Int, have: Int)
        case truncatedIndex(need: Int, have: Int)
        case taxonomyMismatch(blob: String, expected: String)

        var description: String {
            switch self {
            case .badMagic(let m): "occurrence blob: bad magic \(m)"
            case .tooShort(let need, let have):
                "occurrence blob too short: need \(need) bytes, have \(have)"
            case .truncatedIndex(let need, let have):
                "occurrence blob truncated: index needs \(need) bytes but the blob is \(have)"
            case .taxonomyMismatch(let blob, let expected):
                "occurrence blob taxonomy hash \(blob) != taxonomy.json \(expected) -- rebuild the blob"
            }
        }
    }

    init(raw: [UInt8], taxonomySha16: String? = nil) throws {
        guard raw.count >= 16 else { throw ParseError.tooShort(need: 16, have: raw.count) }
        let magic = String(decoding: raw[0..<4], as: UTF8.self)
        guard magic == "WDOP" else { throw ParseError.badMagic(magic) }

        self.raw = raw
        self.version = Int(raw[4])
        let hashLen = version >= 2 ? 8 : 0

        if version >= 2 {
            let hash = raw[8..<16].map { String(format: "%02x", $0) }.joined()
            self.taxonomyHash = hash
            if let expected = taxonomySha16, expected != hash {
                throw ParseError.taxonomyMismatch(blob: hash, expected: expected)
            }
        } else {
            self.taxonomyHash = nil
        }

        let nCellsOffset = 8 + hashLen
        guard raw.count >= nCellsOffset + 4 else {
            throw ParseError.tooShort(need: nCellsOffset + 4, have: raw.count)
        }
        self.nCells = Int(Self.readUInt32(raw, at: nCellsOffset))
        self.idxStart = 12 + hashLen
        // v4 inserts the totals table between the index and the payload.
        // Deriving both offsets from the same expression keeps the two versions
        // from drifting by a table width, which would decode the payload at a
        // shifted offset and return plausible garbage rather than throwing.
        self.totalsStart = idxStart + (nCells + 1) * 8
        self.payloadStart = totalsStart + (version >= 4 ? nCells * 4 : 0)

        // Bounds-check the header before trusting it. Magic, version and hash
        // all live in the first 16 bytes, so a blob truncated AFTER that passes
        // every other check and the varint reader then walks off the end.
        guard payloadStart <= raw.count else {
            throw ParseError.truncatedIndex(need: payloadStart, have: raw.count)
        }
    }

    /// Binary-search the index for an exact key. Returns the ARRAY POSITION, not
    /// the payload offset, because v4's totals table is parallel to the index
    /// and needs that position to find n_cm without a second search.
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

    /// Decode the payload run at an index position into species -> log p.
    private func decodeSlot(_ slot: Int) -> [Int: Double]? {
        let start = Int(Self.readUInt32(raw, at: idxStart + slot * 8 + 4))
        let end = Int(Self.readUInt32(raw, at: idxStart + (slot + 1) * 8 + 4))
        var p = payloadStart + start
        let stop = payloadStart + end
        guard start <= end, stop <= raw.count else { return nil }

        var out: [Int: Double] = [:]
        var cur = 0
        while p < stop {
            var shift = 0
            var v = 0
            var b: UInt8 = 0
            repeat {
                guard p < stop, shift < 35 else { return out }
                b = raw[p]
                p += 1
                v |= Int(b & 0x7f) << shift
                shift += 7
            } while (b & 0x80) != 0
            // A malformed payload must not trap the process, so overflow wraps
            // and a negative running index ends the walk instead.
            cur = cur &+ v
            guard cur >= 0 else { return out }
            guard p < stop else { return out }
            let q = raw[p]
            p += 1
            out[cur] = -Double(q) / Self.scale
        }
        return out
    }

    /// Pack a (cell, month-code) index key exactly the way the builder does.
    private func indexKey(row: Int, col: Int, monthCode: Int) -> UInt32 {
        let cell = row * EqualEarth.gridCols + col
        return UInt32(truncatingIfNeeded: (cell << Self.monthBits) | monthCode)
    }

    /// log P(species|cell, month) keyed by taxonomy row index.
    ///
    /// Nil when the cell carries no data, which the caller must treat as "fall
    /// back to vision only" rather than as zero probability.
    func cellPriors(row: Int, col: Int, month: Int?) -> [Int: Double]? {
        // v3+ slices by (cell, month); v2 slices by cell alone. Reading a v3
        // blob without a month, or a v2 blob with one, would silently look up
        // the wrong key and return a plausible but wrong prior, so the version
        // decides.
        let want: UInt32
        if version >= 3 {
            // The month is REQUIRED by a v3 blob. The web port has a long
            // comment here about NaN coercing to January; Swift's optional Int
            // makes that unrepresentable, but the range check still matters
            // because the old API used a 0-11 convention and 0 would otherwise
            // key December of the previous row.
            guard let month, (1...12).contains(month) else { return nil }
            want = indexKey(row: row, col: col, monthCode: month - 1)
        } else {
            want = UInt32(truncatingIfNeeded: row * EqualEarth.gridCols + col)
        }
        let slot = findSlot(want)
        guard slot >= 0 else { return nil }
        return decodeSlot(slot)
    }

    /// v4 only: the month-agnostic P(species|cell) slice, for backoff. Nil for
    /// v3 and earlier, which do not carry one, and for a cell with no data.
    func pooledPriors(row: Int, col: Int) -> [Int: Double]? {
        guard version >= 4 else { return nil }
        let slot = findSlot(indexKey(row: row, col: col, monthCode: Self.pooledMonthCode))
        guard slot >= 0 else { return nil }
        return decodeSlot(slot)
    }

    /// v4 only: n_cm, the total observation count backing a cell-month slice, or
    /// n_c when `month` is nil. This is the denominator v3 divided out and
    /// discarded.
    ///
    /// Nil when unavailable, which the caller must treat as "cannot apply
    /// backoff" rather than as a count of zero: zero would make the backoff term
    /// (0 + k*P) / (0 + k) = P, silently replacing the monthly prior with the
    /// pooled one instead of falling back to the v3 behaviour.
    func total(row: Int, col: Int, month: Int?) -> Int? {
        guard version >= 4 else { return nil }
        let want: UInt32
        if let month {
            guard (1...12).contains(month) else { return nil }
            want = indexKey(row: row, col: col, monthCode: month - 1)
        } else {
            want = indexKey(row: row, col: col, monthCode: Self.pooledMonthCode)
        }
        let slot = findSlot(want)
        guard slot >= 0 else { return nil }
        return Int(Self.readUInt32(raw, at: totalsStart + slot * 4))
    }

    private static func readUInt32(_ b: [UInt8], at i: Int) -> UInt32 {
        UInt32(b[i]) | (UInt32(b[i + 1]) << 8) | (UInt32(b[i + 2]) << 16) | (UInt32(b[i + 3]) << 24)
    }
}
