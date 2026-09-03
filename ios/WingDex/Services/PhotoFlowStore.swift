import CoreTransferable
import Foundation
import os
import UniformTypeIdentifiers

struct ImportedPhotoFile: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .image) { received in
            Self(url: try PhotoFlowStore.importFile(received.file))
        }
    }
}

enum PhotoFlowStore {
    private static let directoryName = "wingdex-photo-flows"
    private static let cleanupDirectoryPrefix = "\(directoryName)-cleanup-"
    private static let log = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "app.wingdex",
        category: "PhotoFlow"
    )

    private static var root: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(directoryName, isDirectory: true)
    }

    nonisolated static func importFile(_ source: URL) throws -> URL {
        let bytes = try fileSize(source)
        guard bytes <= IncomingShareStore.maximumPhotoBytes else {
            throw IncomingShareError.photoTooLarge
        }
        try prepareRoot()
        let fileExtension = source.pathExtension.isEmpty ? "img" : source.pathExtension
        let destination = root.appendingPathComponent("\(UUID().uuidString).\(fileExtension)")
        do {
            try FileManager.default.copyItem(at: source, to: destination)
            guard try fileSize(destination) == bytes else {
                try? FileManager.default.removeItem(at: destination)
                throw IncomingShareError.stagingFailed
            }
            return destination
        } catch {
            try? FileManager.default.removeItem(at: destination)
            throw IncomingShareStore.normalizeStorageError(error)
        }
    }

    nonisolated static func writeCameraData(_ data: Data) throws -> URL {
        guard !data.isEmpty else { throw IncomingShareError.stagingFailed }
        guard data.count <= IncomingShareStore.maximumPhotoBytes else {
            throw IncomingShareError.photoTooLarge
        }
        try prepareRoot()
        let destination = root.appendingPathComponent("\(UUID().uuidString).jpg")
        do {
            try data.write(to: destination, options: .atomic)
            return destination
        } catch {
            throw IncomingShareStore.normalizeStorageError(error)
        }
    }

    nonisolated static func remove(_ urls: some Sequence<URL>) {
        for url in Set(urls) where url.deletingLastPathComponent() == root {
            try? FileManager.default.removeItem(at: url)
        }
    }

    nonisolated static func purgeAllFiles() throws {
        let temporaryDirectory = FileManager.default.temporaryDirectory
        if FileManager.default.fileExists(atPath: root.path) {
            let quarantine = temporaryDirectory.appendingPathComponent(
                "\(cleanupDirectoryPrefix)\(UUID().uuidString)",
                isDirectory: true
            )
            try FileManager.default.moveItem(at: root, to: quarantine)
        }
        _ = Task.detached(priority: .utility) {
            do {
                for entry in try FileManager.default.contentsOfDirectory(
                    at: temporaryDirectory,
                    includingPropertiesForKeys: nil,
                    options: [.skipsHiddenFiles]
                ) where entry.lastPathComponent.hasPrefix(cleanupDirectoryPrefix) {
                    do {
                        try FileManager.default.removeItem(at: entry)
                    } catch {
                        log.error(
                            "Abandoned photo flow cleanup deferred: \(error.localizedDescription, privacy: .public)"
                        )
                    }
                }
            } catch {
                log.error(
                    "Could not inspect abandoned photo flows: \(error.localizedDescription, privacy: .public)"
                )
            }
        }
    }

    nonisolated static func fileSize(_ url: URL) throws -> Int {
        guard let bytes = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
              bytes > 0
        else { throw IncomingShareError.stagingFailed }
        return bytes
    }

    private nonisolated static func prepareRoot() throws {
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        } catch {
            throw IncomingShareStore.normalizeStorageError(error)
        }
    }
}
