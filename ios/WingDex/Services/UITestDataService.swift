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

    func updateDexEntry(fields _: DexUpdate) async throws -> [DexEntry] {
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
        // A hybrid and one of its parents: the parent list on a compound entry links
        // through to a species page, and the parent may or may not be in the dex.
        let mallard = CompoundTaxonParent(
            commonName: "Mallard",
            scientificName: "Anas platyrhynchos",
            speciesCode: "mallar3",
            wikiTitle: "Mallard",
            thumbnailUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/b/bf/Anas_platyrhynchos_male_female_quadrat.jpg/330px-Anas_platyrhynchos_male_female_quadrat.jpg",
            birdlifeId: "22680186"
        )
        let blackDuck = CompoundTaxonParent(
            commonName: "American Black Duck",
            scientificName: "Anas rubripes",
            speciesCode: "ambduc",
            wikiTitle: "American black duck",
            thumbnailUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/f/f9/American_Black_Duck_pair_at_Green_Wood_Cemetery%2C_Brooklyn_%2862110%29.jpg/330px-American_Black_Duck_pair_at_Green_Wood_Cemetery%2C_Brooklyn_%2862110%29.jpg",
            birdlifeId: "22680217"
        )
        let observations = species.map { fixture in
            BirdObservation(
                id: "ui-test-\(fixture.id)",
                outingId: fixture.outingID,
                speciesName: fixture.name,
                count: 1,
                certainty: .confirmed,
                notes: ""
            )
        } + [
            BirdObservation(
                id: "ui-test-hybrid",
                outingId: rarityOuting.id,
                speciesName: "Mallard x American Black Duck (hybrid)",
                count: 1,
                certainty: .confirmed,
                notes: ""
            ),
            BirdObservation(
                id: "ui-test-mallard",
                outingId: rarityOuting.id,
                speciesName: "Mallard (Anas platyrhynchos)",
                count: 2,
                certainty: .confirmed,
                notes: ""
            ),
        ]
        let compoundDex = [
            DexEntry(
                speciesName: "Mallard x American Black Duck (hybrid)",
                speciesCode: "x00001",
                commonName: "Mallard x American Black Duck (hybrid)",
                firstSeenDate: rarityOuting.startTime,
                lastSeenDate: rarityOuting.endTime,
                totalOutings: 1,
                totalCount: 1,
                notes: "",
                wikiTitle: "Mallard",
                borrowedFrom: "Mallard",
                compound: CompoundTaxon(kind: "hybrid", parents: [mallard, blackDuck])
            ),
            DexEntry(
                speciesName: "Mallard (Anas platyrhynchos)",
                speciesCode: "mallar3",
                commonName: "Mallard",
                scientificName: "Anas platyrhynchos",
                firstSeenDate: rarityOuting.startTime,
                lastSeenDate: rarityOuting.endTime,
                totalOutings: 1,
                totalCount: 2,
                notes: "",
                wikiTitle: "Mallard"
            ),
        ]
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
        } + compoundDex
        return AllDataResponse(
            outings: [primaryOuting, rarityOuting],
            photos: [],
            observations: observations,
            dex: dex
        )
    }()
}
#endif
