import Foundation

// MARK: - Core Models
// These mirror the TypeScript types in src/lib/types.ts and the OpenAPI schema.
// They provide Identifiable + Codable conformance for use in SwiftUI views
// and manual API calls. When the generated OpenAPI client is wired up,
// these may be replaced by or mapped from the generated types.

struct Outing: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let userId: String
    let startTime: String
    let endTime: String
    let locationName: String
    var defaultLocationName: String?
    var lat: Double?
    var lon: Double?
    var stateProvince: String?
    var countryCode: String?
    var `protocol`: String?
    var numberObservers: Int?
    var allObsReported: Bool?
    var effortDistanceMiles: Double?
    var effortAreaAcres: Double?
    var notes: String
    let createdAt: String
}

struct Photo: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let outingId: String
    let dataUrl: String
    let thumbnail: String
    var exifTime: String?
    var gps: GPS?
    let fileHash: String
    let fileName: String

    struct GPS: Codable, Hashable, Sendable {
        let lat: Double
        let lon: Double
    }
}

enum ObservationStatus: String, Codable, CaseIterable, Sendable {
    case confirmed
    case possible
    case pending
    case rejected
}

struct BirdObservation: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let outingId: String
    let speciesName: String
    /// eBird species code, nil when the name resolves to no known taxon.
    /// The dex grouping key when present; speciesName is the fallback.
    var speciesCode: String?
    var count: Int
    var certainty: ObservationStatus
    var representativePhotoId: String?
    var aiConfidence: Double?
    var speciesComments: String?
    var notes: String
}

/// The key the dex groups on, matching DEX_QUERY on the server and
/// rebuildDexFromState on web: the eBird code when present, the display name
/// otherwise, in separate namespaces so a name cannot collide with a code.
func dexGroupKey(speciesCode: String?, speciesName: String) -> String {
    if let code = speciesCode, !code.isEmpty { return "code:\(code)" }
    return "name:\(speciesName)"
}

struct DexEntry: Codable, Identifiable, Hashable, Sendable {
    let speciesName: String
    /// eBird species code for this entry, nil for an unresolvable taxon.
    var speciesCode: String?
    let firstSeenDate: String
    let lastSeenDate: String
    var addedDate: String?
    let totalOutings: Int
    let totalCount: Int
    var bestPhotoId: String?
    var notes: String
    var wikiTitle: String?
    var thumbnailUrl: String?

    /// Identity is the grouping key, not the display name. Two spellings of one
    /// bird are a single entry server-side, so keying on speciesName here would
    /// disagree with the dex the server returns.
    var id: String { dexGroupKey(speciesCode: speciesCode, speciesName: speciesName) }
}

// MARK: - API Response Types

struct AllDataResponse: Codable, Sendable {
    let outings: [Outing]
    let photos: [Photo]
    let observations: [BirdObservation]
    let dex: [DexEntry]
}

struct DexUpdateResponse: Codable, Sendable {
    let dexUpdates: [DexEntry]
}

struct ObservationsCreatedResponse: Codable {
    let observations: [BirdObservation]
    let dexUpdates: [DexEntry]
}
