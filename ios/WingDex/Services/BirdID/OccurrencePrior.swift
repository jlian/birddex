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
///
/// Species are keyed by ROW INDEX into taxonomy.json. A reordered taxonomy
/// would silently mis-key every prior, so the taxonomy hash is verified and a
/// mismatch throws rather than degrading quietly.
struct OccurrenceBlob: Sendable {
    /// v3 packs month into the low bits of the index key.
    static let monthBits = 4
    static let scale = 2.5

    private let raw: [UInt8]
    private let nCells: Int
    private let idxStart: Int
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
        self.payloadStart = idxStart + (nCells + 1) * 8

        // Bounds-check the header before trusting it. Magic, version and hash
        // all live in the first 16 bytes, so a blob truncated AFTER that passes
        // every other check and the varint reader then walks off the end.
        guard payloadStart <= raw.count else {
            throw ParseError.truncatedIndex(need: payloadStart, have: raw.count)
        }
    }

    /// log P(species|cell, month) keyed by taxonomy row index.
    ///
    /// Nil when the cell carries no data, which the caller must treat as "fall
    /// back to vision only" rather than as zero probability.
    func cellPriors(row: Int, col: Int, month: Int?) -> [Int: Double]? {
        let want: UInt32
        if version >= 3 {
            // The month is REQUIRED by a v3 blob. The web port has a long
            // comment here about NaN coercing to January; Swift's optional Int
            // makes that unrepresentable, but the range check still matters
            // because the old API used a 0-11 convention and 0 would otherwise
            // key December of the previous row.
            guard let month, (1...12).contains(month) else { return nil }
            let cell = row * EqualEarth.gridCols + col
            want = UInt32(truncatingIfNeeded: (cell << Self.monthBits) | (month - 1))
        } else {
            want = UInt32(truncatingIfNeeded: row * EqualEarth.gridCols + col)
        }

        var lo = 0
        var hi = nCells - 1
        var found = -1
        while lo <= hi {
            let mid = (lo + hi) / 2
            let key = Self.readUInt32(raw, at: idxStart + mid * 8)
            if key == want { found = mid; break }
            if key < want { lo = mid + 1 } else { hi = mid - 1 }
        }
        guard found >= 0 else { return nil }

        let start = Int(Self.readUInt32(raw, at: idxStart + found * 8 + 4))
        let end = Int(Self.readUInt32(raw, at: idxStart + (found + 1) * 8 + 4))
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
                guard p < stop else { return out }
                b = raw[p]
                p += 1
                v |= Int(b & 0x7f) << shift
                shift += 7
            } while (b & 0x80) != 0
            cur += v
            guard p < stop else { return out }
            let q = raw[p]
            p += 1
            out[cur] = -Double(q) / Self.scale
        }
        return out
    }

    private static func readUInt32(_ b: [UInt8], at i: Int) -> UInt32 {
        UInt32(b[i]) | (UInt32(b[i + 1]) << 8) | (UInt32(b[i + 2]) << 16) | (UInt32(b[i + 3]) << 24)
    }
}
