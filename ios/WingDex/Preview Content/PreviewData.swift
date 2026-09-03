#if DEBUG
import Foundation
import UIKit

// MARK: - Preview Helpers

/// Pre-populated DataStore for SwiftUI previews with realistic demo data.
/// Uses the same locations and species as the bundled demo eBird CSV.
@MainActor
func previewStore(empty: Bool = false) -> DataStore {
    let store = DataStore(service: DataService(auth: AuthService()))
    if !empty {
        store.outings = PreviewData.outings
        store.observations = PreviewData.observations
        store.dex = PreviewData.dex
    }
    return store
}

/// Static demo data derived from the bundled eBird CSV (10 outings, 80+ observations, 50+ species).
/// Covers diverse locations (Seattle, Hawaii, NYC, New Mexico, Florida, San Francisco,
/// London, Tokyo, Vancouver, Sao Paulo) with realistic counts and dates.
enum PreviewData {

    // MARK: - Outings

    static let outings: [Outing] = [
        Outing(
            id: "outing-001", userId: "preview-user",
            startTime: "2026-01-12T08:10:00-08:00", endTime: "2026-01-12T09:32:00-08:00",
            locationName: "Discovery Park", lat: 47.6587, lon: -122.4050,
            stateProvince: "US-WA", countryCode: "US",
            notes: "Winter shoreline and meadow loop.", createdAt: "2026-01-12T16:10:00Z"
        ),
        Outing(
            id: "outing-002", userId: "preview-user",
            startTime: "2026-01-18T07:05:00-10:00", endTime: "2026-01-18T08:19:00-10:00",
            locationName: "Haleakala National Park Summit", lat: 20.7097, lon: -156.2536,
            stateProvince: "US-HI", countryCode: "US",
            notes: "High-elevation scrub and crater overlooks.", createdAt: "2026-01-18T17:05:00Z"
        ),
        Outing(
            id: "outing-003", userId: "preview-user",
            startTime: "2026-01-24T09:15:00-05:00", endTime: "2026-01-24T10:51:00-05:00",
            locationName: "Jamaica Bay Wildlife Refuge", lat: 40.6155, lon: -73.8227,
            stateProvince: "US-NY", countryCode: "US",
            notes: "Saltmarsh pools and East Pond trail.", createdAt: "2026-01-24T14:15:00Z"
        ),
        Outing(
            id: "outing-004", userId: "preview-user",
            startTime: "2026-01-29T06:55:00-07:00", endTime: "2026-01-29T08:45:00-07:00",
            locationName: "Bosque del Apache NWR", lat: 33.8040, lon: -106.8917,
            stateProvince: "US-NM", countryCode: "US",
            notes: "Farm loop and impoundments at dawn.", createdAt: "2026-01-29T13:55:00Z"
        ),
        Outing(
            id: "outing-005", userId: "preview-user",
            startTime: "2026-02-02T08:02:00-05:00", endTime: "2026-02-02T09:10:00-05:00",
            locationName: "Anhinga Trail, Everglades NP", lat: 25.3948, lon: -80.6078,
            stateProvince: "US-FL", countryCode: "US",
            notes: "Boardwalk survey with calm weather.", createdAt: "2026-02-02T13:02:00Z"
        ),
        Outing(
            id: "outing-006", userId: "preview-user",
            startTime: "2026-02-05T07:48:00-08:00", endTime: "2026-02-05T09:01:00-08:00",
            locationName: "Presidio, San Francisco", lat: 37.7989, lon: -122.4662,
            stateProvince: "US-CA", countryCode: "US",
            notes: "Coastal scrub and cypress groves.", createdAt: "2026-02-05T15:48:00Z"
        ),
        Outing(
            id: "outing-007", userId: "preview-user",
            startTime: "2026-02-08T10:30:00+00:00", endTime: "2026-02-08T11:45:00+00:00",
            locationName: "Hyde Park, London", lat: 51.5073, lon: -0.1657,
            stateProvince: "GB-LND", countryCode: "GB",
            notes: "The Serpentine and surrounding paths.", createdAt: "2026-02-08T10:30:00Z"
        ),
        Outing(
            id: "outing-008", userId: "preview-user",
            startTime: "2026-02-10T08:15:00+09:00", endTime: "2026-02-10T09:30:00+09:00",
            locationName: "Ueno Park, Tokyo", lat: 35.7146, lon: 139.7714,
            stateProvince: "JP-13", countryCode: "JP",
            notes: "Shinobazu Pond and surrounding garden.", createdAt: "2026-02-09T23:15:00Z"
        ),
        Outing(
            id: "outing-009", userId: "preview-user",
            startTime: "2026-02-11T08:00:00-08:00", endTime: "2026-02-11T09:20:00-08:00",
            locationName: "Stanley Park, Vancouver", lat: 49.3017, lon: -123.1417,
            stateProvince: "CA-BC", countryCode: "CA",
            notes: "Seawall and Lost Lagoon.", createdAt: "2026-02-11T16:00:00Z"
        ),
        Outing(
            id: "outing-010", userId: "preview-user",
            startTime: "2026-02-12T07:30:00-03:00", endTime: "2026-02-12T08:50:00-03:00",
            locationName: "Parque Ibirapuera, Sao Paulo", lat: -23.5874, lon: -46.6576,
            stateProvince: "BR-SP", countryCode: "BR",
            notes: "Lake circuit and wooded trails.", createdAt: "2026-02-12T10:30:00Z"
        ),
    ]

    // MARK: - Observations

    /// 80+ observations across the 10 outings, matching the demo CSV species and counts.
    static let observations: [BirdObservation] = {
        var obs: [BirdObservation] = []
        var n = 1

        func add(_ outing: String, _ species: String, count: Int = 1, certainty: ObservationStatus = .confirmed) {
            obs.append(BirdObservation(
                id: "obs-\(String(format: "%03d", n))", outingId: outing,
                speciesName: species, count: count, certainty: certainty,
                notes: ""
            ))
            n += 1
        }

        // Outing 1 - Discovery Park, Seattle
        add("outing-001", "Bald Eagle (Haliaeetus leucocephalus)")
        add("outing-001", "Great Blue Heron (Ardea herodias)")
        add("outing-001", "Mallard (Anas platyrhynchos)", count: 14)
        add("outing-001", "Song Sparrow (Melospiza melodia)")
        add("outing-001", "Black-capped Chickadee (Poecile atricapillus)")
        add("outing-001", "Blue Jay (Cyanocitta cristata)")
        add("outing-001", "Northern Cardinal (Cardinalis cardinalis)", count: 4)
        add("outing-001", "Steller's Jay (Cyanocitta stelleri)", count: 3)
        add("outing-001", "Dark-eyed Junco (Junco hyemalis)")

        // Outing 2 - Haleakala, Hawaii
        add("outing-002", "Chukar (Alectoris chukar)", count: 2)
        add("outing-002", "Hawaiian Goose (Branta sandvicensis)", count: 6)
        add("outing-002", "Hawaii Amakihi (Chlorodrepanis virens)")
        add("outing-002", "Apapane (Himatione sanguinea)")
        add("outing-002", "Pacific Golden-Plover (Pluvialis fulva)")
        add("outing-002", "Warbling White-eye (Zosterops japonicus)")
        add("outing-002", "Northern Cardinal (Cardinalis cardinalis)", certainty: .possible)
        add("outing-002", "Eurasian Skylark (Alauda arvensis)")

        // Outing 3 - Jamaica Bay, NYC
        add("outing-003", "Northern Cardinal (Cardinalis cardinalis)")
        add("outing-003", "Blue Jay (Cyanocitta cristata)")
        add("outing-003", "Mallard (Anas platyrhynchos)", count: 22)
        add("outing-003", "Great Blue Heron (Ardea herodias)")
        add("outing-003", "Song Sparrow (Melospiza melodia)")
        add("outing-003", "Osprey (Pandion haliaetus)")
        add("outing-003", "American Black Duck (Anas rubripes)", count: 7)
        add("outing-003", "Mute Swan (Cygnus olor)")
        add("outing-003", "Double-crested Cormorant (Nannopterum auritum)")
        add("outing-003", "American Robin (Turdus migratorius)")
        add("outing-003", "European Starling (Sturnus vulgaris)")
        add("outing-003", "Mourning Dove (Zenaida macroura)")

        // Outing 4 - Bosque del Apache, NM
        add("outing-004", "Sandhill Crane (Antigone canadensis)", count: 120)
        add("outing-004", "Snow Goose (Anser caerulescens)", count: 240)
        add("outing-004", "Northern Pintail (Anas acuta)")
        add("outing-004", "American Wigeon (Mareca americana)")
        add("outing-004", "Bald Eagle (Haliaeetus leucocephalus)")
        add("outing-004", "Mallard (Anas platyrhynchos)")
        add("outing-004", "Northern Harrier (Circus hudsonius)")
        add("outing-004", "Great Blue Heron (Ardea herodias)")

        // Outing 5 - Everglades, FL
        add("outing-005", "Anhinga (Anhinga anhinga)", count: 12)
        add("outing-005", "Great Egret (Ardea alba)")
        add("outing-005", "Snowy Egret (Egretta thula)")
        add("outing-005", "Little Blue Heron (Egretta caerulea)")
        add("outing-005", "White Ibis (Eudocimus albus)", count: 17)
        add("outing-005", "Purple Gallinule (Porphyrio martinica)")
        add("outing-005", "Common Gallinule (Gallinula galeata)")
        add("outing-005", "Osprey (Pandion haliaetus)")
        add("outing-005", "Black Vulture (Coragyps atratus)")

        // Outing 6 - Presidio, SF
        add("outing-006", "Anna's Hummingbird (Calypte anna)")
        add("outing-006", "Chestnut-backed Chickadee (Poecile rufescens)")
        add("outing-006", "Song Sparrow (Melospiza melodia)")
        add("outing-006", "California Towhee (Melozone crissalis)")
        add("outing-006", "Mallard (Anas platyrhynchos)", count: 11)
        add("outing-006", "Great Blue Heron (Ardea herodias)")
        add("outing-006", "Red-tailed Hawk (Buteo jamaicensis)")
        add("outing-006", "Black Phoebe (Sayornis nigricans)")
        add("outing-006", "Steller's Jay (Cyanocitta stelleri)")

        // Outing 7 - Hyde Park, London
        add("outing-007", "Mallard (Anas platyrhynchos)", count: 16)
        add("outing-007", "Great Tit (Parus major)")
        add("outing-007", "Eurasian Blue Tit (Cyanistes caeruleus)")
        add("outing-007", "European Robin (Erithacus rubecula)")
        add("outing-007", "Eurasian Coot (Fulica atra)", count: 10)
        add("outing-007", "Mute Swan (Cygnus olor)")
        add("outing-007", "Common Wood-Pigeon (Columba palumbus)")
        add("outing-007", "Carrion Crow (Corvus corone)")
        add("outing-007", "Great Cormorant (Phalacrocorax carbo)")

        // Outing 8 - Ueno Park, Tokyo
        add("outing-008", "Eastern Spot-billed Duck (Anas zonorhyncha)", count: 18)
        add("outing-008", "Large-billed Crow (Corvus macrorhynchos)")
        add("outing-008", "Brown-eared Bulbul (Hypsipetes amaurotis)")
        add("outing-008", "Asian Tit (Parus minor)")
        add("outing-008", "White-cheeked Starling (Spodiopsar cineraceus)")
        add("outing-008", "Eurasian Tree Sparrow (Passer montanus)", count: 22)
        add("outing-008", "Oriental Turtle-Dove (Streptopelia orientalis)")
        add("outing-008", "Black-crowned Night Heron (Nycticorax nycticorax)")
        add("outing-008", "Great Cormorant (Phalacrocorax carbo)")

        // Outing 9 - Stanley Park, Vancouver
        add("outing-009", "Bald Eagle (Haliaeetus leucocephalus)")
        add("outing-009", "Great Blue Heron (Ardea herodias)")
        add("outing-009", "Black-capped Chickadee (Poecile atricapillus)")
        add("outing-009", "Song Sparrow (Melospiza melodia)")
        add("outing-009", "Mallard (Anas platyrhynchos)", count: 19)
        add("outing-009", "American Crow (Corvus brachyrhynchos)")
        add("outing-009", "Northern Flicker (Colaptes auratus)")
        add("outing-009", "Glaucous-winged Gull (Larus glaucescens)", count: 9)

        // Outing 10 - Ibirapuera, Sao Paulo
        add("outing-010", "Rufous-bellied Thrush (Turdus rufiventris)")
        add("outing-010", "Southern Lapwing (Vanellus chilensis)")
        add("outing-010", "Great Kiskadee (Pitangus sulphuratus)")
        add("outing-010", "Saffron Finch (Sicalis flaveola)", count: 5)
        add("outing-010", "Chalk-browed Mockingbird (Mimus saturninus)")
        add("outing-010", "Eared Dove (Zenaida auriculata)")
        add("outing-010", "Neotropic Cormorant (Nannopterum brasilianum)", count: 7)
        add("outing-010", "House Sparrow (Passer domesticus)")
        add("outing-010", "Rufous Hornero (Furnarius rufus)")
        add("outing-010", "Plush-crested Jay (Cyanocorax chrysops)")

        // Add a few "possible" observations for variety
        add("outing-003", "Peregrine Falcon (Falco peregrinus)", certainty: .possible)
        add("outing-005", "Roseate Spoonbill (Platalea ajaja)", certainty: .possible)
        add("outing-009", "Barred Owl (Strix varia)", certainty: .possible)

        return obs
    }()

    // MARK: - Taxonomy Lookup

    /// Loads wikiTitle and thumbnailUrl from the bundled taxonomy.json for any species.
    /// taxonomy.json entries are: [commonName, scientificName, ebirdCode, wikiTitle, thumbPath]
    /// Thumbnail paths are relative to the Wikimedia Commons prefix.
    private static let wikiLookup: [String: (title: String, thumb: String)] = {
        let commonsPrefix = "https://upload.wikimedia.org/wikipedia/commons/"
        guard let url = Bundle.main.url(forResource: "taxonomy", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let entries = try? JSONSerialization.jsonObject(with: data) as? [[Any]]
        else { return [:] }

        var lookup: [String: (String, String)] = [:]
        for entry in entries {
            guard entry.count > 4,
                  let common = entry[0] as? String,
                  let wikiTitle = entry[3] as? String, !wikiTitle.isEmpty,
                  let thumbPath = entry[4] as? String, !thumbPath.isEmpty
            else { continue }
            lookup[common.lowercased()] = (wikiTitle, commonsPrefix + thumbPath)
        }
        return lookup
    }()

    /// Look up wiki metadata for a species name in "Common Name (Scientific Name)" format.
    private static func wikiMetadata(for speciesName: String) -> (title: String, thumb: String)? {
        let common = speciesName.replacingOccurrences(
            of: #"\s*\(.*\)$"#, with: "", options: .regularExpression
        ).lowercased()
        return wikiLookup[common]
    }

    // MARK: - Dex Entries

    /// Life list entries computed from the observations above.
    /// Wikipedia thumbnail URLs are resolved from the bundled taxonomy.json so every
    /// species gets an image in previews without hardcoding URLs.
    static let dex: [DexEntry] = {
        // Build from observations: unique confirmed species with stats
        let confirmed = observations.filter { $0.certainty == .confirmed }
        var speciesMap: [String: (firstDate: String, lastDate: String, outingIds: Set<String>, totalCount: Int)] = [:]
        let outingDates = Dictionary(uniqueKeysWithValues: outings.map { ($0.id, $0.startTime) })

        for obs in confirmed {
            let date = outingDates[obs.outingId] ?? "2026-01-01T00:00:00Z"
            if var existing = speciesMap[obs.speciesName] {
                if date < existing.firstDate { existing.firstDate = date }
                if date > existing.lastDate { existing.lastDate = date }
                existing.outingIds.insert(obs.outingId)
                existing.totalCount += obs.count
                speciesMap[obs.speciesName] = existing
            } else {
                speciesMap[obs.speciesName] = (date, date, [obs.outingId], obs.count)
            }
        }

        return speciesMap.map { species, stats in
            let wiki = wikiMetadata(for: species)
            return DexEntry(
                speciesName: species,
                firstSeenDate: stats.firstDate,
                lastSeenDate: stats.lastDate,
                totalOutings: stats.outingIds.count,
                totalCount: stats.totalCount,
                notes: species == sampleSpecies ? "Often seen near dense shrubs and woodland edges." : "",
                wikiTitle: wiki?.title,
                thumbnailUrl: wiki?.thumb
            )
        }
        .sorted { $0.firstSeenDate > $1.firstSeenDate }
    }()

    // MARK: - Individual Samples

    /// A single well-known species for detail view previews.
    static let sampleSpecies = "Northern Cardinal (Cardinalis cardinalis)"

    /// A single outing ID for detail view previews (Discovery Park).
    static let sampleOutingId = "outing-001"

    /// The Everglades outing - good for previewing rich species lists.
    static let richOutingId = "outing-005"

    // MARK: - Preview Photo Helpers

    /// Generate a visible placeholder thumbnail (SF Symbol rendered to JPEG data).
    /// Produces actual image data so previews show visible photos instead of empty squares.
    static func placeholderImageData(systemName: String = "bird.fill", size: CGFloat = 200) -> Data {
        let config = UIImage.SymbolConfiguration(pointSize: size * 0.4, weight: .light)
        let symbol = UIImage(systemName: systemName, withConfiguration: config)?
            .withTintColor(.systemGreen, renderingMode: .alwaysOriginal)

        let renderer = UIGraphicsImageRenderer(size: CGSize(width: size, height: size))
        let image = renderer.image { ctx in
            UIColor(red: 0.92, green: 0.90, blue: 0.85, alpha: 1).setFill() // warm beige bg
            ctx.fill(CGRect(x: 0, y: 0, width: size, height: size))
            if let symbol {
                let symbolSize = symbol.size
                let origin = CGPoint(x: (size - symbolSize.width) / 2, y: (size - symbolSize.height) / 2)
                symbol.draw(at: origin)
            }
        }
        return image.jpegData(compressionQuality: 0.8) ?? Data()
    }

    /// Create a sample ProcessedPhoto with visible placeholder image data.
    static func samplePhoto(
        id: String = UUID().uuidString,
        exifTime: Date? = Date(),
        lat: Double? = 47.6587,
        lon: Double? = -122.4050,
        symbol: String = "bird.fill"
    ) -> ProcessedPhoto {
        let imageData = placeholderImageData(systemName: symbol)
        let imageURL = (try? PhotoFlowStore.writeCameraData(imageData))
            ?? FileManager.default.temporaryDirectory.appendingPathComponent("missing-preview.jpg")
        return ProcessedPhoto(
            id: id, originalURL: imageURL, cleanupOriginal: true, thumbnail: imageData,
            exifTime: exifTime, gpsLat: lat, gpsLon: lon,
            fileHash: "preview_\(id)", fileName: "preview_\(id).jpg",
            byteCount: imageData.count
        )
    }

    /// Create a sample cluster with multiple visible photos.
    static func sampleCluster(
        photoCount: Int = 3,
        lat: Double? = 47.6587,
        lon: Double? = -122.4050
    ) -> PhotoCluster {
        let symbols = ["bird.fill", "leaf.fill", "camera.fill", "binoculars.fill", "sun.max.fill"]
        let photos = (0..<photoCount).map { i in
            samplePhoto(
                id: "preview-\(i)",
                exifTime: Date().addingTimeInterval(Double(-i) * 300),
                lat: lat, lon: lon,
                symbol: symbols[i % symbols.count]
            )
        }
        return PhotoCluster(
            photos: photos,
            startTime: Date().addingTimeInterval(Double(-photoCount) * 300),
            endTime: Date(),
            centerLat: lat,
            centerLon: lon
        )
    }
}

// MARK: - Preview Tab Wrapper

import SwiftUI

/// Wraps a view in the app's real tab bar layout for realistic previews.
/// Usage:
/// ```
/// #Preview {
///     PreviewTabs(.home) { HomeView() }
///         .environment(previewStore())
/// }
/// ```
struct PreviewTabs<Content: View>: View {
    enum Tab: Int { case home, wingdex, outings, add }
    @State private var selectedTab: Tab
    let tab: Tab
    let content: Content

    init(_ tab: Tab = .home, @ViewBuilder content: () -> Content) {
        self.tab = tab
        self._selectedTab = State(initialValue: tab)
        self.content = content()
    }

    var body: some View {
        TabView(selection: $selectedTab) {
            TabSection {
                SwiftUI.Tab("Home", systemImage: "house", value: Tab.home) {
                    if tab == .home { content } else { Color.pageBg }
                }
                SwiftUI.Tab("WingDex", image: "BirdTab", value: Tab.wingdex) {
                    if tab == .wingdex { content } else { Color.pageBg }
                }
                SwiftUI.Tab("Outings", systemImage: "binoculars", value: Tab.outings) {
                    if tab == .outings { content } else { Color.pageBg }
                }
            }
            SwiftUI.Tab(value: Tab.add, role: .search) {
                if tab == .add { content } else { Color.pageBg }
            } label: {
                Label("Add", systemImage: "camera.fill")
            }
        }
        .environment(ToastCenter())
    }
}

#endif
