import Foundation
import SwiftData
import CryptoKit

struct AccountDataSnapshot: Sendable {
    let response: AllDataResponse
    let refreshedAt: Date
}

@MainActor
protocol AccountDataCaching: AnyObject {
    func load(accountID: String) throws -> AccountDataSnapshot?
    func replace(accountID: String, response: AllDataResponse, refreshedAt: Date) throws
    func clear(accountID: String) throws
}

@MainActor
final class AccountDataCache: AccountDataCaching {
    static let purgeDenylistKey = "account-data-cache-purge-denylist"
    private static let sqliteHeader = Data("SQLite format 3\0".utf8)

    private let container: ModelContainer
    private let storeDirectory: URL?
    private let purgeDefaults: UserDefaults
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(
        isStoredInMemoryOnly: Bool = false,
        storeURL: URL? = nil,
        purgeDefaults: UserDefaults = .standard
    ) throws {
        self.purgeDefaults = purgeDefaults
        let schema = Schema(versionedSchema: CacheSchemaV1.self)
        if isStoredInMemoryOnly {
            storeDirectory = nil
            container = try Self.makeContainer(
                schema: schema,
                configuration: ModelConfiguration(isStoredInMemoryOnly: true)
            )
            return
        }

        let url = try storeURL ?? Self.defaultStoreURL()
        storeDirectory = url.deletingLastPathComponent()
        try Self.removeStoreDirectoryIfClearlyInvalid(at: url)
        let configuration = ModelConfiguration(
            "WingDexCache",
            schema: schema,
            url: url,
            cloudKitDatabase: .none
        )
        do {
            container = try Self.makeContainer(schema: schema, configuration: configuration)
        } catch {
            try Self.removeStoreDirectory(at: url.deletingLastPathComponent())
            try Self.prepareStoreDirectory(url.deletingLastPathComponent())
            container = try Self.makeContainer(schema: schema, configuration: configuration)
        }
    }

    func load(accountID: String) throws -> AccountDataSnapshot? {
        if isPurgeDenied(accountID: accountID) {
            try clearPersistedSnapshot(accountID: accountID)
            removePurgeDenial(accountID: accountID)
            return nil
        }
        if let purgeMarker = purgeMarkerURL(accountID: accountID),
           FileManager.default.fileExists(atPath: purgeMarker.path) {
            try clearPersistedSnapshot(accountID: accountID)
            try FileManager.default.removeItem(at: purgeMarker)
            return nil
        }
        let context = ModelContext(container)
        let descriptor = FetchDescriptor<CacheSchemaV1.CachedAccountSnapshot>(
            predicate: #Predicate { $0.accountID == accountID }
        )
        guard let record = try context.fetch(descriptor).first else { return nil }
        return AccountDataSnapshot(
            response: try decoder.decode(AllDataResponse.self, from: record.payload),
            refreshedAt: record.refreshedAt
        )
    }

    func replace(accountID: String, response: AllDataResponse, refreshedAt: Date = .now) throws {
        let context = ModelContext(container)
        let descriptor = FetchDescriptor<CacheSchemaV1.CachedAccountSnapshot>(
            predicate: #Predicate { $0.accountID == accountID }
        )
        let payload = try encoder.encode(response.cacheSnapshot)

        if let record = try context.fetch(descriptor).first {
            record.refreshedAt = refreshedAt
            record.payload = payload
        } else {
            context.insert(CacheSchemaV1.CachedAccountSnapshot(
                accountID: accountID,
                refreshedAt: refreshedAt,
                payload: payload
            ))
        }
        try context.save()
    }

    func clear(accountID: String) throws {
        addPurgeDenial(accountID: accountID)
        let purgeMarker = purgeMarkerURL(accountID: accountID)
        var markerError: Error?
        if let purgeMarker {
            do {
                try Data().write(to: purgeMarker, options: .atomic)
            } catch {
                markerError = error
            }
        }
        do {
            try clearPersistedSnapshot(accountID: accountID)
        } catch {
            throw markerError ?? error
        }
        removePurgeDenial(accountID: accountID)
        if let purgeMarker, FileManager.default.fileExists(atPath: purgeMarker.path) {
            try FileManager.default.removeItem(at: purgeMarker)
        }
    }

    private func clearPersistedSnapshot(accountID: String) throws {
        let context = ModelContext(container)
        let descriptor = FetchDescriptor<CacheSchemaV1.CachedAccountSnapshot>(
            predicate: #Predicate { $0.accountID == accountID }
        )
        for record in try context.fetch(descriptor) {
            context.delete(record)
        }
        try context.save()
    }

    private func purgeMarkerURL(accountID: String) -> URL? {
        guard let storeDirectory else { return nil }
        return storeDirectory.appending(path: ".purge-\(Self.accountHash(accountID))")
    }

    static func accountHash(_ accountID: String) -> String {
        SHA256.hash(data: Data(accountID.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    private func isPurgeDenied(accountID: String) -> Bool {
        purgeDenylist.contains(Self.accountHash(accountID))
    }

    private func addPurgeDenial(accountID: String) {
        var denylist = purgeDenylist
        denylist.insert(Self.accountHash(accountID))
        purgeDefaults.set(Array(denylist), forKey: Self.purgeDenylistKey)
    }

    private func removePurgeDenial(accountID: String) {
        var denylist = purgeDenylist
        denylist.remove(Self.accountHash(accountID))
        purgeDefaults.set(Array(denylist), forKey: Self.purgeDenylistKey)
    }

    private var purgeDenylist: Set<String> {
        Set(purgeDefaults.stringArray(forKey: Self.purgeDenylistKey) ?? [])
    }

    private static func makeContainer(
        schema: Schema,
        configuration: ModelConfiguration
    ) throws -> ModelContainer {
        try ModelContainer(
            for: schema,
            migrationPlan: CacheMigrationPlan.self,
            configurations: configuration
        )
    }

    private static func defaultStoreURL() throws -> URL {
        let directory = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        ).appending(path: "WingDexCache", directoryHint: .isDirectory)
        try prepareStoreDirectory(directory)
        return directory.appending(path: "WingDexCache.store")
    }

    private static func prepareStoreDirectory(_ directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var resourceValues = URLResourceValues()
        resourceValues.isExcludedFromBackup = true
        var mutableDirectory = directory
        try mutableDirectory.setResourceValues(resourceValues)
    }

    private static func removeStoreDirectory(at directory: URL) throws {
        let fileManager = FileManager.default
        if fileManager.fileExists(atPath: directory.path) {
            try fileManager.removeItem(at: directory)
        }
    }

    private static func removeStoreDirectoryIfClearlyInvalid(at storeURL: URL) throws {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: storeURL.path, isDirectory: &isDirectory) else { return }
        if isDirectory.boolValue {
            try removeStoreDirectory(at: storeURL.deletingLastPathComponent())
            try prepareStoreDirectory(storeURL.deletingLastPathComponent())
            return
        }
        guard
              let handle = try? FileHandle(forReadingFrom: storeURL)
        else { return }
        defer { try? handle.close() }
        let header: Data
        do {
            header = try handle.read(upToCount: sqliteHeader.count) ?? Data()
        } catch {
            return
        }
        guard header != sqliteHeader else { return }
        try removeStoreDirectory(at: storeURL.deletingLastPathComponent())
        try prepareStoreDirectory(storeURL.deletingLastPathComponent())
    }
}

private extension AllDataResponse {
    var cacheSnapshot: AllDataResponse {
        AllDataResponse(
            outings: outings,
            photos: photos.map { photo in
                Photo(
                    id: photo.id,
                    outingId: photo.outingId,
                    dataUrl: "",
                    thumbnail: photo.thumbnail,
                    exifTime: photo.exifTime,
                    gps: photo.gps,
                    fileHash: photo.fileHash,
                    fileName: photo.fileName
                )
            },
            observations: observations,
            dex: dex
        )
    }
}
