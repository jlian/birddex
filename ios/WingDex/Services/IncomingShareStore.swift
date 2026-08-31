import Foundation
import os

struct IncomingSharedPhoto: Equatable, Sendable {
    let fileName: String
    let fileURL: URL
}

struct IncomingShareSnapshot: Equatable, Sendable {
    let id: String
    let photos: [IncomingSharedPhoto]
}

enum IncomingShareStore {
    static let appGroupIdentifier = "group.app.wingdex"
    /// The review flow confirms every photo individually. Keep this bounded until
    /// selected originals become file-backed instead of remaining in memory.
    static let maximumPhotoCount = 50
    static let maximumTotalBytes = 512 * 1_024 * 1_024
    static let maximumPhotoBytes = 50 * 1_024 * 1_024

    private static let queueDirectoryName = "incoming-shares-v2"
    private static let stagingDirectoryName = "staging"
    private static let pendingDirectoryName = "pending"
    private static let acceptedDirectoryName = "accepted"
    private static let manifestFileName = "manifest.json"
    private static let nextSequenceFileName = "next-sequence.json"
    private static let legacyManifestsDirectoryName = "incoming-share-manifests"
    private static let staleStagingAge: TimeInterval = 24 * 60 * 60
    private static let log = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "app.wingdex",
        category: "IncomingShare"
    )

    private nonisolated static var containerURL: URL? {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-test-share-store") {
            return FileManager.default.temporaryDirectory
                .appendingPathComponent("wingdex-ui-test-shares", isDirectory: true)
        }
        #endif
        return FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroupIdentifier
        )
    }

    @discardableResult
    nonisolated static func stage(fileURLs: [URL]) async throws -> String {
        guard let container = containerURL else { throw IncomingShareError.containerUnavailable }
        return try await stage(fileURLs: fileURLs, in: container)
    }

    /// Transfers ownership of extension-created temporary files into the queue.
    /// Avoids retaining a second full copy of a large Photos share while publishing.
    @discardableResult
    nonisolated static func stageConsuming(fileURLs: [URL]) async throws -> String {
        guard let container = containerURL else { throw IncomingShareError.containerUnavailable }
        return try await stageConsuming(fileURLs: fileURLs, in: container)
    }

    nonisolated static func oldestPendingShare() async throws -> IncomingShareSnapshot? {
        guard let container = containerURL else { throw IncomingShareError.containerUnavailable }
        return try await oldestPendingShare(in: container)
    }

    @discardableResult
    nonisolated static func accept(id: String) async throws -> Bool {
        guard let container = containerURL else { throw IncomingShareError.containerUnavailable }
        return try await accept(id: id, in: container)
    }

    #if DEBUG
    nonisolated static func resetForUITests() async throws {
        guard let container = containerURL else { throw IncomingShareError.containerUnavailable }
        try await Task.detached(priority: .utility) {
            let queue = queueDirectory(in: container)
            if FileManager.default.fileExists(atPath: queue.path) {
                try FileManager.default.removeItem(at: queue)
            }
            try removeLegacyQueue(in: container)
        }.value
    }
    #endif

    @discardableResult
    nonisolated static func stage(
        fileURLs: [URL],
        in directory: URL
    ) async throws -> String {
        try await stage(fileURLs: fileURLs, in: directory, consumeSources: false)
    }

    @discardableResult
    nonisolated static func stageConsuming(
        fileURLs: [URL],
        in directory: URL
    ) async throws -> String {
        try await stage(fileURLs: fileURLs, in: directory, consumeSources: true)
    }

    private nonisolated static func stage(
        fileURLs: [URL],
        in directory: URL,
        consumeSources: Bool
    ) async throws -> String {
        let task = Task.detached(priority: .userInitiated) {
            try stageSynchronously(
                fileURLs: fileURLs,
                in: directory,
                consumeSources: consumeSources
            )
        }
        return try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
        }
    }

    nonisolated static func oldestPendingShare(
        in directory: URL
    ) async throws -> IncomingShareSnapshot? {
        let task = Task.detached(priority: .userInitiated) {
            try oldestPendingShareSynchronously(in: directory)
        }
        return try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
        }
    }

    @discardableResult
    nonisolated static func accept(
        id: String,
        in directory: URL,
        cleanupAccepted: Bool = true
    ) async throws -> Bool {
        let task = Task.detached(priority: .userInitiated) {
            try acceptSynchronously(
                id: id,
                in: directory,
                cleanupAccepted: cleanupAccepted
            )
        }
        return try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
        }
    }

    private nonisolated static func stageSynchronously(
        fileURLs: [URL],
        in directory: URL,
        consumeSources: Bool
    ) throws -> String {
        guard !fileURLs.isEmpty else { throw IncomingShareError.noPhotos }
        guard fileURLs.count <= maximumPhotoCount else { throw IncomingShareError.tooManyPhotos }
        try Task.checkCancellation()

        var totalBytes = 0
        let sourceBytes = try fileURLs.map { sourceURL in
            try Task.checkCancellation()
            guard let bytes = try sourceURL.resourceValues(forKeys: [.fileSizeKey]).fileSize,
                  bytes > 0
            else { throw IncomingShareError.stagingFailed }
            guard bytes <= maximumPhotoBytes else { throw IncomingShareError.photoTooLarge }
            totalBytes += bytes
            guard totalBytes <= maximumTotalBytes else { throw IncomingShareError.shareTooLarge }
            return bytes
        }

        let layout: Layout
        do {
            layout = try prepareLayout(in: directory)
        } catch {
            throw normalizeStorageError(error)
        }
        let id = UUID().uuidString
        let stagingBatch = layout.staging.appendingPathComponent(id, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: stagingBatch, withIntermediateDirectories: false)
        } catch {
            throw normalizeStorageError(error)
        }

        var files: [String] = []
        var transfers: [(source: URL, destination: URL)] = []
        do {
            for (index, sourceURL) in fileURLs.enumerated() {
                try Task.checkCancellation()
                let fileExtension = sourceURL.pathExtension.isEmpty ? "jpg" : sourceURL.pathExtension
                let fileName = "photo-\(index + 1).\(fileExtension)"
                let destination = stagingBatch.appendingPathComponent(fileName)
                if consumeSources {
                    try FileManager.default.moveItem(at: sourceURL, to: destination)
                    transfers.append((sourceURL, destination))
                } else {
                    try FileManager.default.copyItem(at: sourceURL, to: destination)
                }
                guard let fileBytes = try destination.resourceValues(forKeys: [.fileSizeKey]).fileSize,
                      fileBytes == sourceBytes[index]
                else { throw IncomingShareError.stagingFailed }
                files.append(fileName)
            }

            try coordinateWriting(layout.root) { coordinatedRoot in
                try Task.checkCancellation()
                let manifest = Manifest(
                    id: id,
                    sequence: try reservePublicationSequence(in: coordinatedRoot),
                    files: files
                )
                try JSONEncoder().encode(manifest).write(
                    to: stagingBatch.appendingPathComponent(manifestFileName),
                    options: .atomic
                )
                let pending = coordinatedRoot.appendingPathComponent(
                    pendingDirectoryName,
                    isDirectory: true
                )
                try FileManager.default.moveItem(
                    at: stagingBatch,
                    to: pending.appendingPathComponent(id, isDirectory: true)
                )
            }
            log.info("Published share \(id, privacy: .public) with \(files.count) photos and \(totalBytes) bytes")
            return id
        } catch {
            var restoredAllSources = true
            if consumeSources {
                for transfer in transfers.reversed()
                where FileManager.default.fileExists(atPath: transfer.destination.path)
                    && !FileManager.default.fileExists(atPath: transfer.source.path) {
                    do {
                        try FileManager.default.moveItem(
                            at: transfer.destination,
                            to: transfer.source
                        )
                    } catch {
                        restoredAllSources = false
                    }
                }
            }
            if restoredAllSources {
                try? FileManager.default.removeItem(at: stagingBatch)
            }
            throw normalizeStorageError(error)
        }
    }

    nonisolated static func normalizeStorageError(_ error: Error) -> Error {
        let nsError = error as NSError
        if (nsError.domain == NSCocoaErrorDomain
                && nsError.code == CocoaError.fileWriteOutOfSpace.rawValue)
            || (nsError.domain == NSPOSIXErrorDomain
                && nsError.code == Int(POSIXErrorCode.ENOSPC.rawValue)) {
            return IncomingShareError.insufficientStorage
        }
        if let underlying = nsError.userInfo[NSUnderlyingErrorKey] as? Error {
            let normalized = normalizeStorageError(underlying)
            if normalized is IncomingShareError { return normalized }
        }
        return error
    }

    private nonisolated static func oldestPendingShareSynchronously(
        in directory: URL
    ) throws -> IncomingShareSnapshot? {
        let layout = try prepareLayout(in: directory)
        return try coordinateWriting(layout.root) { coordinatedRoot in
            let pending = coordinatedRoot.appendingPathComponent(
                pendingDirectoryName,
                isDirectory: true
            )
            let accepted = coordinatedRoot.appendingPathComponent(
                acceptedDirectoryName,
                isDirectory: true
            )
            var batches: [(manifest: Manifest, directory: URL)] = []

            for batchDirectory in try directoryEntries(at: pending) {
                let manifestURL = batchDirectory.appendingPathComponent(manifestFileName)
                guard let manifest = try? JSONDecoder().decode(
                    Manifest.self,
                    from: Data(contentsOf: manifestURL)
                ), manifest.id == batchDirectory.lastPathComponent,
                   !manifest.files.isEmpty
                else {
                    quarantine(batchDirectory, in: accepted)
                    continue
                }
                batches.append((manifest, batchDirectory))
            }

            guard let batch = batches.min(by: {
                if $0.manifest.sequence == $1.manifest.sequence {
                    return $0.manifest.id < $1.manifest.id
                }
                return $0.manifest.sequence < $1.manifest.sequence
            }) else { return nil }

            let photos = batch.manifest.files.map { fileName in
                IncomingSharedPhoto(
                    fileName: fileName,
                    fileURL: batch.directory.appendingPathComponent(fileName)
                )
            }
            return IncomingShareSnapshot(id: batch.manifest.id, photos: photos)
        }
    }

    private nonisolated static func acceptSynchronously(
        id: String,
        in directory: URL,
        cleanupAccepted: Bool
    ) throws -> Bool {
        try Task.checkCancellation()
        let layout = try prepareLayout(in: directory)
        let acceptedBatch: URL? = try coordinateWriting(layout.root) { coordinatedRoot in
            try Task.checkCancellation()
            let pendingBatch = coordinatedRoot
                .appendingPathComponent(pendingDirectoryName, isDirectory: true)
                .appendingPathComponent(id, isDirectory: true)
            guard FileManager.default.fileExists(atPath: pendingBatch.path) else { return nil }
            let acceptedBatch = coordinatedRoot
                .appendingPathComponent(acceptedDirectoryName, isDirectory: true)
                .appendingPathComponent(id, isDirectory: true)
            if FileManager.default.fileExists(atPath: acceptedBatch.path) {
                try? FileManager.default.removeItem(at: acceptedBatch)
            }
            try FileManager.default.moveItem(at: pendingBatch, to: acceptedBatch)
            return acceptedBatch
        }
        guard let acceptedBatch else { return false }

        log.info("Accepted share \(id, privacy: .public)")
        if cleanupAccepted {
            do {
                try FileManager.default.removeItem(at: acceptedBatch)
            } catch {
                log.error("Could not clean accepted share \(id, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }
        }
        return true
    }

    private nonisolated static func prepareLayout(in directory: URL) throws -> Layout {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let root = queueDirectory(in: directory)
        let staging = root.appendingPathComponent(stagingDirectoryName, isDirectory: true)
        let pending = root.appendingPathComponent(pendingDirectoryName, isDirectory: true)
        let accepted = root.appendingPathComponent(acceptedDirectoryName, isDirectory: true)
        for url in [root, staging, pending, accepted] {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        }
        try coordinateWriting(root) { coordinatedRoot in
            try removeLegacyQueue(in: directory)
            let coordinatedStaging = coordinatedRoot.appendingPathComponent(
                stagingDirectoryName,
                isDirectory: true
            )
            try cleanStaleStaging(in: coordinatedStaging)
            let coordinatedAccepted = coordinatedRoot.appendingPathComponent(
                acceptedDirectoryName,
                isDirectory: true
            )
            for entry in try directoryEntries(at: coordinatedAccepted) {
                try? FileManager.default.removeItem(at: entry)
            }
        }
        return Layout(root: root, staging: staging)
    }

    private nonisolated static func removeLegacyQueue(in directory: URL) throws {
        let manifests = directory.appendingPathComponent(
            legacyManifestsDirectoryName,
            isDirectory: true
        )
        guard FileManager.default.fileExists(atPath: manifests.path) else { return }
        let ids: [String] = (try? directoryEntries(at: manifests))?.compactMap { url in
            let id = url.deletingPathExtension().lastPathComponent
            return UUID(uuidString: id) == nil ? nil : id
        } ?? []
        try FileManager.default.removeItem(at: manifests)
        for id in ids {
            try? FileManager.default.removeItem(
                at: directory.appendingPathComponent(id, isDirectory: true)
            )
        }
    }

    private nonisolated static func cleanStaleStaging(in directory: URL) throws {
        let cutoff = Date().addingTimeInterval(-staleStagingAge)
        for entry in try directoryEntries(at: directory) {
            guard UUID(uuidString: entry.lastPathComponent) != nil,
                  let createdAt = try? entry.resourceValues(
                    forKeys: [.creationDateKey]
                  ).creationDate,
                  createdAt < cutoff
            else { continue }
            try? FileManager.default.removeItem(at: entry)
        }
    }

    private nonisolated static func quarantine(_ batch: URL, in accepted: URL) {
        let destination = accepted.appendingPathComponent(
            "invalid-\(UUID().uuidString)",
            isDirectory: true
        )
        do {
            try FileManager.default.moveItem(at: batch, to: destination)
            try? FileManager.default.removeItem(at: destination)
        } catch {
            log.error("Could not quarantine an invalid incoming share: \(error.localizedDescription, privacy: .public)")
        }
    }

    private nonisolated static func reservePublicationSequence(in root: URL) throws -> UInt64 {
        let sequenceURL = root.appendingPathComponent(nextSequenceFileName)
        let pending = root.appendingPathComponent(pendingDirectoryName, isDirectory: true)
        let storedSequence = try? JSONDecoder().decode(
            UInt64.self,
            from: Data(contentsOf: sequenceURL)
        )
        let highestPending = try highestPendingSequence(in: pending)
        guard highestPending < UInt64.max else { throw IncomingShareError.stagingFailed }
        let sequence = max(storedSequence ?? 0, highestPending + 1)
        guard sequence < UInt64.max else { throw IncomingShareError.stagingFailed }
        try JSONEncoder().encode(sequence + 1).write(to: sequenceURL, options: .atomic)
        return sequence
    }

    private nonisolated static func highestPendingSequence(in directory: URL) throws -> UInt64 {
        try directoryEntries(at: directory).compactMap { batch in
            try? JSONDecoder().decode(
                Manifest.self,
                from: Data(contentsOf: batch.appendingPathComponent(manifestFileName))
            ).sequence
        }.max() ?? 0
    }

    private nonisolated static func coordinateWriting<T>(
        _ url: URL,
        accessor: (URL) throws -> T
    ) throws -> T {
        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordinationError: NSError?
        var result: Result<T, Error>?
        coordinator.coordinate(writingItemAt: url, options: .forMerging, error: &coordinationError) {
            coordinatedURL in
            result = Result { try accessor(coordinatedURL) }
        }
        if let result { return try result.get() }
        throw coordinationError ?? IncomingShareError.stagingFailed
    }

    private nonisolated static func directoryEntries(at directory: URL) throws -> [URL] {
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.creationDateKey],
            options: [.skipsHiddenFiles]
        )
    }

    private nonisolated static func queueDirectory(in directory: URL) -> URL {
        directory.appendingPathComponent(queueDirectoryName, isDirectory: true)
    }

    private struct Layout {
        let root: URL
        let staging: URL
    }

    private struct Manifest: Codable {
        let id: String
        let sequence: UInt64
        let files: [String]
    }
}

enum IncomingShareError: LocalizedError, Equatable {
    case containerUnavailable
    case noPhotos
    case tooManyPhotos
    case photoTooLarge
    case shareTooLarge
    case insufficientStorage
    case stagingFailed
    case noLongerPending

    var errorDescription: String? {
        switch self {
        case .containerUnavailable:
            "WingDex could not access shared storage."
        case .noPhotos:
            "No photos were included in this share."
        case .tooManyPhotos:
            "Share up to \(IncomingShareStore.maximumPhotoCount) photos at a time."
        case .photoTooLarge:
            "Each shared photo must be smaller than 50 MB."
        case .shareTooLarge:
            "The selected photos total more than 512 MB. Share a smaller batch."
        case .insufficientStorage:
            "There is not enough free storage to prepare these photos."
        case .stagingFailed:
            "WingDex could not prepare the shared photos. Please try again."
        case .noLongerPending:
            "These shared photos were already imported."
        }
    }
}
