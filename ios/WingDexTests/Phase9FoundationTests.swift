@testable import WingDex
import XCTest

final class Phase9FoundationTests: XCTestCase {
    func testSortDateParsesStoredAPITimestamps() {
        XCTAssertEqual(
            DateFormatting.sortDate("2026-07-20T12:00:00Z"),
            Date(timeIntervalSince1970: 1_784_548_800)
        )
        XCTAssertEqual(
            DateFormatting.sortDate("2026-07-20T12:00:00.123Z").timeIntervalSince1970,
            1_784_548_800.123,
            accuracy: 0.001
        )
        XCTAssertEqual(
            DateFormatting.sortDate("2026-07-20T12:00:00-07:00"),
            Date(timeIntervalSince1970: 1_784_574_000)
        )
        XCTAssertEqual(DateFormatting.sortDate("not-a-date"), .distantPast)
    }

    @MainActor
    func testNavigationQueuesRouteUntilMainInterfaceIsReady() {
        let navigation = AppNavigationModel()

        navigation.route(to: .wingdex(filter: "cardinal"))

        XCTAssertEqual(navigation.selectedTab, .home)
        XCTAssertEqual(navigation.pendingRoute, .wingdex(filter: "cardinal"))

        navigation.setMainInterfaceReady(true)

        XCTAssertEqual(navigation.selectedTab, .wingdex)
        XCTAssertEqual(navigation.wingDexFilter, "cardinal")
        XCTAssertNil(navigation.pendingRoute)
    }

    func testSpeciesSharePayloadContainsSummary() {
        let entry = DexEntry(
            speciesName: "Northern Cardinal (Cardinalis cardinalis)",
            firstSeenDate: "2026-01-02T12:00:00Z",
            lastSeenDate: "2026-02-03T12:00:00Z",
            totalOutings: 2,
            totalCount: 4,
            notes: ""
        )

        let payload = SharePayload.species(entry)

        XCTAssertTrue(payload.contains("Northern Cardinal"))
        XCTAssertTrue(payload.contains("Cardinalis cardinalis"))
        XCTAssertTrue(payload.contains("4 observed across 2 outings"))
        XCTAssertTrue(payload.contains("Shared from WingDex"))
    }

    func testSpeciesSharePayloadPrefersCanonicalNames() {
        let entry = DexEntry(
            speciesName: "Southern Brown Kiwi (South I.)",
            commonName: "Southern Brown Kiwi (South I.)",
            scientificName: "Apteryx australis australis",
            firstSeenDate: "2026-01-02T12:00:00Z",
            lastSeenDate: "2026-02-03T12:00:00Z",
            totalOutings: 1,
            totalCount: 1,
            notes: ""
        )

        let payload = SharePayload.species(entry)

        XCTAssertTrue(payload.contains("Southern Brown Kiwi (South I.)"))
        XCTAssertTrue(payload.contains("Apteryx australis australis"))
    }

    func testOutingSharePayloadIncludesConfirmedSpeciesOnly() {
        let outing = makeOuting()
        let observations = [
            makeObservation(id: "one", species: "American Robin (Turdus migratorius)", count: 2, certainty: .confirmed),
            makeObservation(id: "two", species: "American Robin (Turdus migratorius)", count: 1, certainty: .confirmed),
            makeObservation(id: "three", species: "Blue Jay (Cyanocitta cristata)", count: 1, certainty: .rejected),
        ]

        let payload = SharePayload.outing(outing, observations: observations)

        XCTAssertTrue(payload.contains("Discovery Park"))
        XCTAssertTrue(payload.contains("1 species, 3 birds"))
        XCTAssertTrue(payload.contains("3x American Robin"))
        XCTAssertFalse(payload.contains("Blue Jay"))
    }

    func testOutingSharePayloadPreservesQualifiedTaxonLabel() {
        let outing = makeOuting()
        var observation = makeObservation(
            id: "issf",
            species: "Southern Brown Kiwi (South I.)",
            count: 1,
            certainty: .confirmed
        )
        observation.speciesCode = "sobkiw1"
        observation.taxonCode = "sobkiw2"
        let canonical = DexEntry(
            speciesName: "legacy kiwi label",
            speciesCode: "sobkiw1",
            taxonCode: "sobkiw2",
            commonName: "Southern Brown Kiwi (South I.)",
            scientificName: "Apteryx australis australis",
            firstSeenDate: "2026-01-02T12:00:00Z",
            lastSeenDate: "2026-02-03T12:00:00Z",
            totalOutings: 1,
            totalCount: 1,
            notes: ""
        )

        let group = try? XCTUnwrap(groupByDexKey([observation]).first)
        XCTAssertEqual(group?.taxonCode, "sobkiw2")
        XCTAssertTrue(SharePayload.outing(outing, observations: [observation], dex: [canonical])
            .contains("1x Southern Brown Kiwi (South I.)"))
    }

    func testExportFactoryWritesDeterministicSightingsFile() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let date = Date(timeIntervalSince1970: 1_767_225_600)
        let data = Data("header\nvalue".utf8)

        let item = try ExportFileFactory.sightings(data: data, date: date, directory: directory)

        XCTAssertEqual(item.url.lastPathComponent, "wingdex-sightings-2026-01-01.csv")
        XCTAssertEqual(try Data(contentsOf: item.url), data)
    }

    func testQuickActionsMapToExpectedRoutes() {
        XCTAssertEqual(AppQuickAction.takePhoto.route, .addPhotos(launchAction: .camera))
        XCTAssertEqual(AppQuickAction.uploadPhotos.route, .addPhotos(launchAction: .library))
        XCTAssertEqual(AppQuickAction.viewWingDex.route, .wingdex())
    }

    @MainActor
    func testAddPhotosLaunchRequestQueuesAndConsumesOnce() throws {
        let navigation = AppNavigationModel()

        navigation.route(to: .addPhotos(launchAction: .camera))
        XCTAssertNil(navigation.addPhotosLaunchRequest)

        navigation.setMainInterfaceReady(true)
        let request = try XCTUnwrap(navigation.addPhotosLaunchRequest)
        XCTAssertEqual(navigation.selectedTab, .add)
        XCTAssertEqual(request.action, .camera)

        navigation.consumeAddPhotosLaunchRequest(id: request.id)
        XCTAssertNil(navigation.addPhotosLaunchRequest)
    }

    @MainActor
    func testRepeatedAddPhotosRoutesCreateDistinctRequests() throws {
        let navigation = AppNavigationModel()
        navigation.setMainInterfaceReady(true)

        navigation.route(to: .addPhotos(launchAction: .library))
        let first = try XCTUnwrap(navigation.addPhotosLaunchRequest)
        navigation.consumeAddPhotosLaunchRequest(id: first.id)
        navigation.route(to: .addPhotos(launchAction: .library))
        let second = try XCTUnwrap(navigation.addPhotosLaunchRequest)

        XCTAssertNotEqual(first.id, second.id)
        XCTAssertEqual(second.action, .library)
    }

    func testRecentSpeciesUsesLatestConfirmedOutingsAndDeduplicatesNames() {
        let older = makeOuting(id: "older", startTime: "2026-01-01T12:00:00Z")
        let newer = makeOuting(id: "newer", startTime: "2026-03-01T12:00:00Z")
        let response = AllDataResponse(
            outings: [older, newer],
            photos: [],
            observations: [
                makeObservation(id: "one", outingId: older.id, species: "American Robin (Turdus migratorius)", count: 1, certainty: .confirmed),
                makeObservation(id: "two", outingId: newer.id, species: "Northern Cardinal (Cardinalis cardinalis)", count: 1, certainty: .confirmed),
                makeObservation(id: "three", outingId: newer.id, species: "American Robin (Turdus migratorius)", count: 1, certainty: .confirmed),
                makeObservation(id: "four", outingId: newer.id, species: "Blue Jay (Cyanocitta cristata)", count: 1, certainty: .rejected),
            ],
            dex: []
        )

        XCTAssertEqual(
            RecentSpeciesResolver.names(from: response),
            ["Northern Cardinal", "American Robin"]
        )
    }

    func testRecentSpeciesHonorsLimit() {
        let outing = makeOuting(id: "recent", startTime: "2026-03-01T12:00:00Z")
        let response = AllDataResponse(
            outings: [outing],
            photos: [],
            observations: [
                makeObservation(id: "one", outingId: outing.id, species: "One", count: 1, certainty: .confirmed),
                makeObservation(id: "two", outingId: outing.id, species: "Two", count: 1, certainty: .confirmed),
            ],
            dex: []
        )

        XCTAssertEqual(RecentSpeciesResolver.names(from: response, limit: 1).count, 1)
    }

    func testIntentErrorsMapNetworkAndSessionFailures() {
        XCTAssertEqual(
            IntentDataError.map(URLError(.notConnectedToInternet)),
            .offline
        )
        XCTAssertEqual(
            IntentDataError.map(URLError(.timedOut)),
            .timedOut
        )
        XCTAssertEqual(
            IntentDataError.map(AuthError.notAuthenticated),
            .notSignedIn
        )
        XCTAssertEqual(
            IntentDataError.map(DataServiceError.http(status: 500, message: nil, retryAfter: nil, traceID: nil)),
            .server
        )
        XCTAssertEqual(
            IntentDataError.map(DataServiceError.http(status: 429, message: nil, retryAfter: nil, traceID: nil)),
            .rateLimited
        )
    }

    func testRequiredAppIntentsAreExtractedAndRegisteredAsShortcuts() throws {
        let metadataURL = Bundle.main.bundleURL
            .appendingPathComponent("Metadata.appintents/extract.actionsdata")
        let data = try Data(contentsOf: metadataURL)
        let metadata = try JSONDecoder().decode(AppIntentsMetadata.self, from: data)
        let requiredIdentifiers: Set<String> = [
            "UploadPhotosIntent",
            "TakePhotoIntent",
            "ViewWingDexIntent",
            "ViewOutingsIntent",
            "GetSpeciesCountIntent",
            "GetRecentSpeciesIntent",
            "GetLastSpeciesIntent",
            "ExportSightingsIntent",
        ]

        XCTAssertEqual(Set(metadata.actions.keys), requiredIdentifiers)
        XCTAssertFalse(metadata.autoShortcutProviderMangledName.isEmpty)
        XCTAssertEqual(Set(metadata.autoShortcuts.map(\.actionIdentifier)), requiredIdentifiers)
        XCTAssertEqual(WingDexShortcuts.appShortcuts.count, requiredIdentifiers.count)
    }

    private struct AppIntentsMetadata: Decodable {
        let actions: [String: ActionMetadata]
        let autoShortcutProviderMangledName: String
        let autoShortcuts: [AutoShortcutMetadata]
    }

    private struct ActionMetadata: Decodable {}

    private struct AutoShortcutMetadata: Decodable {
        let actionIdentifier: String
    }

    private func makeOuting() -> Outing {
        makeOuting(id: "outing-1", startTime: "2026-02-03T12:00:00Z")
    }

    private func makeOuting(id: String, startTime: String) -> Outing {
        Outing(
            id: id,
            userId: "user-1",
            startTime: startTime,
            endTime: "2026-02-03T13:00:00Z",
            locationName: "Discovery Park",
            notes: "",
            createdAt: "2026-02-03T14:00:00Z"
        )
    }

    private func makeObservation(
        id: String,
        outingId: String = "outing-1",
        species: String,
        count: Int,
        certainty: ObservationStatus
    ) -> BirdObservation {
        BirdObservation(
            id: id,
            outingId: outingId,
            speciesName: species,
            count: count,
            certainty: certainty,
            notes: ""
        )
    }
}