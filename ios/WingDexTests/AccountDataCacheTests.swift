@testable import WingDex
import XCTest

@MainActor
final class AccountDataCacheTests: XCTestCase {
    func testV1SchemaIsRegisteredWithMigrationPlan() {
        XCTAssertEqual(CacheSchemaV1.versionIdentifier, .init(1, 0, 0))
        XCTAssertEqual(CacheMigrationPlan.schemas.count, 1)
        XCTAssertTrue(CacheMigrationPlan.schemas.first == CacheSchemaV1.self)
        XCTAssertTrue(CacheMigrationPlan.stages.isEmpty)
    }

    func testRoundTripStripsFullResolutionPhotoData() throws {
        let cache = try AccountDataCache(isStoredInMemoryOnly: true)
        let refreshedAt = Date(timeIntervalSince1970: 1_750_000_000)

        try cache.replace(
            accountID: "account-a",
            response: fixtureResponse(accountID: "account-a", dataURL: "data:image/jpeg;base64,full-image"),
            refreshedAt: refreshedAt
        )

        let snapshot = try XCTUnwrap(cache.load(accountID: "account-a"))
        XCTAssertEqual(snapshot.refreshedAt, refreshedAt)
        XCTAssertEqual(snapshot.response.outings.first?.userId, "account-a")
        XCTAssertEqual(snapshot.response.photos.first?.dataUrl, "")
        XCTAssertEqual(snapshot.response.photos.first?.thumbnail, "data:image/jpeg;base64,thumb")
    }

    func testAccountsRemainIsolatedAndReplacementIsScoped() throws {
        let cache = try AccountDataCache(isStoredInMemoryOnly: true)
        try cache.replace(accountID: "account-a", response: fixtureResponse(accountID: "account-a"))
        try cache.replace(accountID: "account-b", response: fixtureResponse(accountID: "account-b"))

        try cache.replace(accountID: "account-a", response: AllDataResponse(
            outings: [], photos: [], observations: [], dex: []
        ))

        XCTAssertTrue(try XCTUnwrap(cache.load(accountID: "account-a")).response.outings.isEmpty)
        XCTAssertEqual(
            try XCTUnwrap(cache.load(accountID: "account-b")).response.outings.first?.userId,
            "account-b"
        )
    }

    func testClearRemovesOnlyRequestedAccount() throws {
        let cache = try AccountDataCache(isStoredInMemoryOnly: true)
        try cache.replace(accountID: "account-a", response: fixtureResponse(accountID: "account-a"))
        try cache.replace(accountID: "account-b", response: fixtureResponse(accountID: "account-b"))

        try cache.clear(accountID: "account-a")

        XCTAssertNil(try cache.load(accountID: "account-a"))
        XCTAssertNotNil(try cache.load(accountID: "account-b"))
    }

    func testCorruptDiskStoreIsRecreated() throws {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let storeURL = directory.appending(path: "WingDexCache.store")
        let staleArtifactURL = directory.appending(path: "stale-external-payload")
        try Data("not-a-sqlite-store".utf8).write(to: storeURL)
        try Data("private-cache-data".utf8).write(to: staleArtifactURL)

        let cache = try AccountDataCache(storeURL: storeURL)
        try cache.replace(accountID: "account-a", response: fixtureResponse(accountID: "account-a"))

        XCTAssertEqual(
            try XCTUnwrap(cache.load(accountID: "account-a")).response.outings.first?.userId,
            "account-a"
        )
        XCTAssertFalse(FileManager.default.fileExists(atPath: staleArtifactURL.path))
    }

    func testValidDiskStoreSurvivesReopen() throws {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let storeURL = directory.appending(path: "WingDexCache.store")

        do {
            let cache = try AccountDataCache(storeURL: storeURL)
            try cache.replace(accountID: "account-a", response: fixtureResponse(accountID: "account-a"))
        }

        let reopened = try AccountDataCache(storeURL: storeURL)
        XCTAssertEqual(
            try XCTUnwrap(reopened.load(accountID: "account-a")).response.outings.first?.userId,
            "account-a"
        )
    }

    func testDirectoryAtStorePathIsRecreated() throws {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: UUID().uuidString, directoryHint: .isDirectory)
        let storeURL = directory.appending(path: "WingDexCache.store", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: storeURL, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let cache = try AccountDataCache(storeURL: storeURL)
        try cache.replace(accountID: "account-a", response: fixtureResponse(accountID: "account-a"))

        XCTAssertEqual(
            try XCTUnwrap(cache.load(accountID: "account-a")).response.outings.first?.userId,
            "account-a"
        )
    }

    func testDurablePurgeDenialPreventsHydrationAndRetriesDeletion() throws {
        let directory = FileManager.default.temporaryDirectory
            .appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let suiteName = "AccountDataCacheTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let storeURL = directory.appending(path: "WingDexCache.store")
        let cache = try AccountDataCache(storeURL: storeURL, purgeDefaults: defaults)
        try cache.replace(accountID: "account-a", response: fixtureResponse(accountID: "account-a"))
        defaults.set(
            [AccountDataCache.accountHash("account-a")],
            forKey: AccountDataCache.purgeDenylistKey
        )

        XCTAssertNil(try cache.load(accountID: "account-a"))
        XCTAssertNil(try cache.load(accountID: "account-a"))
        XCTAssertTrue(defaults.stringArray(forKey: AccountDataCache.purgeDenylistKey)?.isEmpty == true)
    }

    private func fixtureResponse(accountID: String, dataURL: String = "") -> AllDataResponse {
        AllDataResponse(
            outings: [Outing(
                id: "outing-\(accountID)",
                userId: accountID,
                startTime: "2026-07-20T12:00:00Z",
                endTime: "2026-07-20T13:00:00Z",
                locationName: "Test Marsh",
                notes: "",
                createdAt: "2026-07-20T12:00:00Z"
            )],
            photos: [Photo(
                id: "photo-\(accountID)",
                outingId: "outing-\(accountID)",
                dataUrl: dataURL,
                thumbnail: "data:image/jpeg;base64,thumb",
                fileHash: "hash-\(accountID)",
                fileName: "bird.jpg"
            )],
            observations: [],
            dex: []
        )
    }
}
