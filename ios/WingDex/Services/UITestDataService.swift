#if DEBUG
import Foundation

/// Deterministic data for render-only UI tests. Functional UI tests continue to
/// use DataService so this fixture cannot replace backend integration coverage.
final class UITestDataService: DataStoreService, Sendable {
    enum Mode: Sendable {
        case empty
        case populated

        init?(arguments: [String]) {
            if arguments.contains("--ui-test-fixture-populated") {
                self = .populated
            } else if arguments.contains("--ui-test-fixture-empty") {
                self = .empty
            } else {
                return nil
            }
        }
    }

    private let mode: Mode

    init(mode: Mode) {
        self.mode = mode
    }

    func fetchAllData() async throws -> AllDataResponse {
        switch mode {
        case .empty:
            return AllDataResponse(outings: [], photos: [], observations: [], dex: [])
        case .populated:
            return Self.populatedResponse
        }
    }

    func deleteOuting(id _: String) async throws -> DexUpdateResponse {
        throw URLError(.unsupportedURL)
    }

    func updateOuting(id _: String, fields _: OutingUpdate) async throws -> Outing {
        throw URLError(.unsupportedURL)
    }

    func rejectObservations(ids _: [String]) async throws -> DataService.ObservationsResponse {
        throw URLError(.unsupportedURL)
    }

    func searchSpecies(query _: String, limit _: Int) async throws -> [DataService.SpeciesSearchResult] {
        []
    }

    func createObservations(_ observations: [BirdObservation]) async throws -> DataService.ObservationsResponse {
        throw URLError(.unsupportedURL)
    }

    func exportOutingCSV(outingId _: String) async throws -> Data {
        Data()
    }

    func importEBirdCSV(_ csvData: Data, profileTimezone _: String?) async throws -> DataService.ImportResponse {
        throw URLError(.unsupportedURL)
    }

    func clearAllData() async throws {
        throw URLError(.unsupportedURL)
    }

    private static let populatedResponse: AllDataResponse = {
        let primaryOuting = Outing(
            id: "ui-test-seeded-outing",
            userId: "ui-test-account",
            startTime: "2026-02-12T06:58:00-03:00",
            endTime: "2026-02-12T07:58:00-03:00",
            locationName: "Parque Ibirapuera, Sao Paulo",
            lat: -23.5875,
            lon: -46.6575,
            notes: "UI test seed",
            createdAt: "2026-02-12T06:58:00-03:00"
        )
        let rarityOuting = Outing(
            id: "ui-test-seeded-rarity-outing",
            userId: "ui-test-account",
            startTime: "2026-01-18T08:30:00-08:00",
            endTime: "2026-01-18T10:30:00-08:00",
            locationName: "Carkeek Park, Seattle",
            lat: 47.61,
            lon: -122.33,
            notes: "UI test seed, rarity states",
            createdAt: "2026-01-18T08:30:00-08:00"
        )
        let species: [(id: String, outingID: String, name: String)] = [
            ("chalk-browed", primaryOuting.id, "Chalk-browed Mockingbird (Mimus saturninus)"),
            ("eared-dove", primaryOuting.id, "Eared Dove (Zenaida auriculata)"),
            ("robin", rarityOuting.id, "American Robin (Turdus migratorius)"),
            ("rufous", rarityOuting.id, "Rufous Hummingbird (Selasphorus rufus)"),
            ("tundra-swan", rarityOuting.id, "Tundra Swan (Cygnus columbianus)"),
            ("cardinal", rarityOuting.id, "Northern Cardinal (Cardinalis cardinalis)"),
        ]
        let observations = species.map { fixture in
            BirdObservation(
                id: "ui-test-\(fixture.id)",
                outingId: fixture.outingID,
                speciesName: fixture.name,
                count: 1,
                certainty: .confirmed,
                notes: ""
            )
        }
        let dex = species.map { fixture in
            DexEntry(
                speciesName: fixture.name,
                firstSeenDate: fixture.outingID == primaryOuting.id
                    ? primaryOuting.startTime
                    : rarityOuting.startTime,
                lastSeenDate: fixture.outingID == primaryOuting.id
                    ? primaryOuting.endTime
                    : rarityOuting.endTime,
                totalOutings: 1,
                totalCount: 1,
                notes: ""
            )
        }
        return AllDataResponse(
            outings: [primaryOuting, rarityOuting],
            photos: [],
            observations: observations,
            dex: dex
        )
    }()
}
#endif
