import Foundation
import CoreFoundation

struct IncomingSharedPhoto: Equatable {
    let fileName: String
    let fileURL: URL
}

struct IncomingShareSnapshot: Equatable {
    let id: String
    let photos: [IncomingSharedPhoto]
}

enum IncomingShareStore {
    static let appGroupIdentifier = "group.app.wingdex"
    static let maximumPhotoCount = 50
    static let maximumTotalBytes = 250 * 1_024 * 1_024
    static let maximumPhotoBytes = 50 * 1_024 * 1_024

    private static let manifestsDirectoryName = "incoming-share-manifests"
    static let changeNotificationName = "app.wingdex.incoming-share.staged"
    static let didStageNotification = Notification.Name(changeNotificationName)

    private nonisolated static var containerURL: URL? {
        #if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
        if arguments.contains("--ui-test-share-photo")
            || arguments.contains("--ui-test-delayed-share-photo")
            || arguments.contains("--ui-test-reset-pending-share")
            || arguments.contains("--ui-test-clear-pending-share") {
            return FileManager.default.temporaryDirectory
                .appendingPathComponent("wingdex-ui-test-shares", isDirectory: true)
        }
        #endif
        return FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroupIdentifier
        )
    }

    static var hasPendingShare: Bool {
        guard let container = containerURL else { return false }
        return hasPendingShare(in: container)
    }

    nonisolated static func stage(fileURLs: [URL]) async throws {
        guard let container = containerURL else { throw IncomingShareError.containerUnavailable }
        try await stage(fileURLs: fileURLs, in: container)
        // Observers deliver on the posting thread and drive SwiftUI state, so
        // this has to be posted from the main actor.
        await MainActor.run {
            NotificationCenter.default.post(name: didStageNotification, object: nil)
        }
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(changeNotificationName as CFString),
            nil,
            nil,
            true
        )
    }

    static func pendingShare() throws -> IncomingShareSnapshot? {
        guard let container = containerURL else { throw IncomingShareError.containerUnavailable }
        return try pendingShare(in: container)
    }

    static func completePendingShare(id: String) throws {
        guard let container = containerURL else { throw IncomingShareError.containerUnavailable }
        try completePendingShare(id: id, in: container)
    }

    static func hasPendingShare(in directory: URL) -> Bool {
        // Cheap existence check: only scan for a `.json` manifest file rather than
        // reading and decoding every manifest. Called on the main actor from
        // scene-phase paths, so avoid the synchronous I/O + decode cost here.
        let manifestsDirectory = directory.appendingPathComponent(
            manifestsDirectoryName,
            isDirectory: true
        )
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: manifestsDirectory,
            includingPropertiesForKeys: nil
        ) else { return false }
        return entries.contains { $0.pathExtension == "json" }
    }

    nonisolated static func stage(fileURLs: [URL], in directory: URL) async throws {
        guard !fileURLs.isEmpty else { throw IncomingShareError.noPhotos }
        guard fileURLs.count <= maximumPhotoCount else { throw IncomingShareError.tooManyPhotos }

        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let shareID = UUID().uuidString
        let shareDirectory = directory.appendingPathComponent(shareID, isDirectory: true)
        try FileManager.default.createDirectory(at: shareDirectory, withIntermediateDirectories: true)

        var totalBytes = 0
        var files: [String] = []
        do {
            for (index, sourceURL) in fileURLs.enumerated() {
                try Task.checkCancellation()
                let fileExtension = sourceURL.pathExtension.isEmpty ? "jpg" : sourceURL.pathExtension
                let fileName = "photo-\(index + 1)-\(UUID().uuidString).\(fileExtension)"
                let destination = shareDirectory.appendingPathComponent(fileName)
                try FileManager.default.copyItem(
                    at: sourceURL,
                    to: destination
                )
                guard let fileBytes = try destination.resourceValues(forKeys: [.fileSizeKey]).fileSize,
                        fileBytes > 0
                else { throw IncomingShareError.stagingFailed }
                guard fileBytes <= maximumPhotoBytes else { throw IncomingShareError.photoTooLarge }
                totalBytes += fileBytes
                guard totalBytes <= maximumTotalBytes else { throw IncomingShareError.shareTooLarge }
                files.append(fileName)
            }

            try Task.checkCancellation()
            let manifest = Manifest(id: shareID, createdAt: Date(), files: files)
            let data = try JSONEncoder().encode(manifest)
            let manifestsDirectory = directory.appendingPathComponent(
                manifestsDirectoryName,
                isDirectory: true
            )
            try FileManager.default.createDirectory(
                at: manifestsDirectory,
                withIntermediateDirectories: true
            )
            try data.write(
                to: manifestsDirectory.appendingPathComponent("\(shareID).json"),
                options: .atomic
            )
        } catch {
            try? FileManager.default.removeItem(at: shareDirectory)
            throw error
        }
    }

    static func pendingShare(in directory: URL) throws -> IncomingShareSnapshot? {
        guard let manifest = try manifests(in: directory).min(by: { $0.createdAt < $1.createdAt }) else {
            return nil
        }
        let shareDirectory = directory.appendingPathComponent(manifest.id, isDirectory: true)
        let photos = manifest.files.map { fileName in
            IncomingSharedPhoto(
                fileName: fileName,
                fileURL: shareDirectory.appendingPathComponent(fileName)
            )
        }
        return IncomingShareSnapshot(id: manifest.id, photos: photos)
    }

    static func completePendingShare(id: String, in directory: URL) throws {
        let shareDirectory = directory.appendingPathComponent(id, isDirectory: true)
        if FileManager.default.fileExists(atPath: shareDirectory.path) {
            try FileManager.default.removeItem(at: shareDirectory)
        }
        let manifestURL = directory
            .appendingPathComponent(manifestsDirectoryName, isDirectory: true)
            .appendingPathComponent("\(id).json")
        if FileManager.default.fileExists(atPath: manifestURL.path) {
            try FileManager.default.removeItem(at: manifestURL)
        }
    }

    private static func manifests(in directory: URL) throws -> [Manifest] {
        let manifestsDirectory = directory.appendingPathComponent(
            manifestsDirectoryName,
            isDirectory: true
        )
        guard FileManager.default.fileExists(atPath: manifestsDirectory.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(
            at: manifestsDirectory,
            includingPropertiesForKeys: nil
        )
        .filter { $0.pathExtension == "json" }
        .compactMap { url in
            if let manifest = try? JSONDecoder().decode(Manifest.self, from: Data(contentsOf: url)) {
                return manifest
            }
            // A manifest that can't be decoded (corrupt/truncated) would otherwise
            // keep `hasPendingShare` true forever while `pendingShare` returns nil,
            // wedging the app into a "share pending but unimportable" state. Drop the
            // dead manifest and its payload directory so the decode path self-heals
            // without leaking staged images.
            if let shareID = UUID(uuidString: url.deletingPathExtension().lastPathComponent) {
                let shareDirectory = directory.appendingPathComponent(
                    shareID.uuidString,
                    isDirectory: true
                )
                try? FileManager.default.removeItem(at: shareDirectory)
            }
            try? FileManager.default.removeItem(at: url)
            return nil
        }
    }

    private struct Manifest: Codable {
        let id: String
        let createdAt: Date
        let files: [String]
    }
}

enum IncomingShareError: LocalizedError {
    case containerUnavailable
    case noPhotos
    case tooManyPhotos
    case photoTooLarge
    case shareTooLarge
    case stagingFailed

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
            "These photos are too large to share to WingDex at once."
        case .stagingFailed:
            "WingDex could not prepare the shared photos. Please try again."
        }
    }
}