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

    func testIncomingShareStorePreservesOrderAndConsumesOnce() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let sources = root.appendingPathComponent("sources", isDirectory: true)
        let container = root.appendingPathComponent("container", isDirectory: true)
        try FileManager.default.createDirectory(at: sources, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let first = sources.appendingPathComponent("first.jpg")
        let second = sources.appendingPathComponent("second.png")
        try Data("first".utf8).write(to: first)
        try Data("second".utf8).write(to: second)

        try await IncomingShareStore.stage(fileURLs: [first, second], in: container)
        XCTAssertTrue(IncomingShareStore.hasPendingShare(in: container))

        let snapshot = try XCTUnwrap(IncomingShareStore.pendingShare(in: container))
        let stagedFileURLs = snapshot.photos.map(\.fileURL)
        XCTAssertEqual(try snapshot.photos.map { try Data(contentsOf: $0.fileURL) }, [Data("first".utf8), Data("second".utf8)])
        XCTAssertTrue(IncomingShareStore.hasPendingShare(in: container))

        try IncomingShareStore.completePendingShare(id: snapshot.id, in: container)
        XCTAssertTrue(stagedFileURLs.allSatisfy { !FileManager.default.fileExists(atPath: $0.path) })
        XCTAssertFalse(IncomingShareStore.hasPendingShare(in: container))
        XCTAssertNil(try IncomingShareStore.pendingShare(in: container))
    }

    func testCompletingOlderIncomingSharePreservesNewerShare() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let container = root.appendingPathComponent("container", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let first = root.appendingPathComponent("first.jpg")
        let second = root.appendingPathComponent("second.jpg")
        try Data("first".utf8).write(to: first)
        try Data("second".utf8).write(to: second)

        try await IncomingShareStore.stage(fileURLs: [first], in: container)
        let older = try XCTUnwrap(IncomingShareStore.pendingShare(in: container))
        try await IncomingShareStore.stage(fileURLs: [second], in: container)
        XCTAssertEqual(try IncomingShareStore.pendingShare(in: container), older)

        try IncomingShareStore.completePendingShare(id: older.id, in: container)

        let newer = try XCTUnwrap(IncomingShareStore.pendingShare(in: container))
        XCTAssertNotEqual(newer.id, older.id)
        XCTAssertEqual(try Data(contentsOf: newer.photos[0].fileURL), Data("second".utf8))
    }

    func testIncomingShareStoreAcceptsMaximumPhotoCountInOrder() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let sources = root.appendingPathComponent("sources", isDirectory: true)
        let container = root.appendingPathComponent("container", isDirectory: true)
        try FileManager.default.createDirectory(at: sources, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let files = try (0..<IncomingShareStore.maximumPhotoCount).map { index in
            let file = sources.appendingPathComponent("photo-\(index).jpg")
            try Data("photo-\(index)".utf8).write(to: file)
            return file
        }

        try await IncomingShareStore.stage(fileURLs: files, in: container)

        let snapshot = try XCTUnwrap(IncomingShareStore.pendingShare(in: container))
        XCTAssertEqual(snapshot.photos.count, IncomingShareStore.maximumPhotoCount)
        XCTAssertEqual(
            try snapshot.photos.map { try String(decoding: Data(contentsOf: $0.fileURL), as: UTF8.self) },
            (0..<IncomingShareStore.maximumPhotoCount).map { "photo-\($0)" }
        )
    }

    func testIncomingShareStoreRejectsMoreThanMaximumPhotoCount() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let container = root.appendingPathComponent("container", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let files = (0...IncomingShareStore.maximumPhotoCount).map {
            root.appendingPathComponent("photo-\($0).jpg")
        }

        do {
            try await IncomingShareStore.stage(fileURLs: files, in: container)
            XCTFail("Expected the share photo count limit")
        } catch IncomingShareError.tooManyPhotos {
        } catch {
            XCTFail("Expected tooManyPhotos, got \(error)")
        }
    }

    func testIncomingShareStoreRejectsEmptyPhotoFile() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let container = root.appendingPathComponent("container", isDirectory: true)
        let emptyPhoto = root.appendingPathComponent("empty.jpg")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data().write(to: emptyPhoto)
        defer { try? FileManager.default.removeItem(at: root) }

        do {
            try await IncomingShareStore.stage(fileURLs: [emptyPhoto], in: container)
            XCTFail("Expected an empty shared photo to be rejected")
        } catch IncomingShareError.stagingFailed {
        } catch {
            XCTFail("Expected stagingFailed, got \(error)")
        }
        XCTAssertFalse(IncomingShareStore.hasPendingShare(in: container))
    }

    func testCorruptIncomingShareManifestRemovesOrphanedPayloadDirectory() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let manifests = root.appendingPathComponent("incoming-share-manifests", isDirectory: true)
        let shareID = UUID().uuidString
        let payloadDirectory = root.appendingPathComponent(shareID, isDirectory: true)
        let manifestURL = manifests.appendingPathComponent("\(shareID).json")
        try FileManager.default.createDirectory(at: manifests, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: payloadDirectory, withIntermediateDirectories: true)
        try Data("staged-photo".utf8).write(to: payloadDirectory.appendingPathComponent("photo.jpg"))
        try Data("not-json".utf8).write(to: manifestURL)
        defer { try? FileManager.default.removeItem(at: root) }

        XCTAssertNil(try IncomingShareStore.pendingShare(in: root))
        XCTAssertFalse(FileManager.default.fileExists(atPath: manifestURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: payloadDirectory.path))
    }

    func testCorruptIncomingShareManifestWithInvalidIDDoesNotRemoveDirectory() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let manifests = root.appendingPathComponent("incoming-share-manifests", isDirectory: true)
        let payloadDirectory = root.appendingPathComponent("not-a-share-id", isDirectory: true)
        let manifestURL = manifests.appendingPathComponent("not-a-share-id.json")
        try FileManager.default.createDirectory(at: manifests, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: payloadDirectory, withIntermediateDirectories: true)
        try Data("keep-me".utf8).write(to: payloadDirectory.appendingPathComponent("file"))
        try Data("not-json".utf8).write(to: manifestURL)
        defer { try? FileManager.default.removeItem(at: root) }

        XCTAssertNil(try IncomingShareStore.pendingShare(in: root))
        XCTAssertFalse(FileManager.default.fileExists(atPath: manifestURL.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: payloadDirectory.path))
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