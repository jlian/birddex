import Foundation
import os

private let log = Logger(subsystem: Config.bundleID, category: "Rarity")

/// App-wide access to the bundled rarity asset.
///
/// A singleton rather than an environment value because the callers are list
/// rows: `BirdRow` and the species-detail sighting rows resolve their own
/// verdict synchronously while the row body builds, with no async state and no
/// per-row plumbing.
///
/// LOADED SYNCHRONOUSLY, on first use. The asset is 2 MiB and needs no parsing:
/// the reader keeps the bytes and reads a fixed-size header, so there is no
/// JSON decode to keep off the main thread the way taxonomy.json has. Loading
/// it asynchronously bought nothing and cost correctness, because a row that
/// rendered first showed no mark and only corrected itself if observation
/// happened to fire.
///
/// Deliberately NOT owned by `BirdIdEngine`. That actor loads the 37 MiB Core ML
/// tower and the 34 MiB occurrence prior in one step, and a life list scrolling
/// past a hundred rows must not pay for either.
@MainActor
final class RarityStore {
    static let shared = RarityStore()

    private var attempted = false
    private var loaded: RarityBlob?

    /// Nil only when the asset is missing or unusable, in which case nothing is
    /// ever marked.
    private var blob: RarityBlob? {
        if !attempted {
            attempted = true
            loaded = Self.loadFromBundle()
        }
        return loaded
    }

    /// Pay the read during setup rather than on the first scroll.
    func warmUp() { _ = blob }

    private static func loadFromBundle() -> RarityBlob? {
        guard let url = Bundle.main.url(forResource: "rarity", withExtension: "bin") else {
            log.error("rarity.bin missing from the bundle")
            return nil
        }
        do {
            return try RarityBlob(raw: [UInt8](try Data(contentsOf: url)),
                                  taxonomySha16: BirdIdEngine.taxonomySha16)
        } catch {
            // A hash mismatch or a truncated asset means every verdict would be
            // wrong, so drop it and mark nothing rather than mark badly.
            log.error("rarity asset unusable: \(String(describing: error))")
            return nil
        }
    }

    /// The verdict for a sighting. `.none` whenever anything is unknown.
    func state(species: String, taxonCode: String? = nil, lat: Double?, lon: Double?, month: Int?) -> RarityState {
        guard let blob, let lat, let lon, let month else { return .none }
        let idx = taxonCode.map(getTaxonomicOrder(forCode:)) ?? getTaxonomicOrder(species)
        guard idx != Int.max else { return .none }
        return blob.state(speciesIdx: idx, lat: lat, lon: lon, month: month)
    }

    /// The verdict for an observation on an outing, which is the form every
    /// list row has to hand.
    func state(species: String, taxonCode: String? = nil, outing: Outing) -> RarityState {
        state(species: species,
              taxonCode: taxonCode,
              lat: outing.lat,
              lon: outing.lon,
              month: DateFormatting.localMonth(outing.startTime))
    }

    /// The 12 months this species is ordinary at an outing's location. Nil when
    /// the location carries no usable data, which must read as "not enough
    /// records" rather than as a bird that belongs in no month at all.
    func ordinaryMonths(species: String, taxonCode: String? = nil, outing: Outing) -> [Bool]? {
        guard let blob, let lat = outing.lat, let lon = outing.lon else { return nil }
        let idx = taxonCode.map(getTaxonomicOrder(forCode:)) ?? getTaxonomicOrder(species)
        guard idx != Int.max else { return nil }
        return blob.ordinaryMonths(speciesIdx: idx, lat: lat, lon: lon)
    }
}
