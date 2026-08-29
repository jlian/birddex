@testable import WingDex
import XCTest

final class IncomingShareStoreTests: XCTestCase {
    func testStagesPhotosInOrderAndAcceptsBatchOnce() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let first = try fixture.source(name: "first.jpg", contents: "first")
        let second = try fixture.source(name: "second.png", contents: "second")

        try await IncomingShareStore.stage(
            fileURLs: [first, second],
            in: fixture.container
        )

        let pendingSnapshot = try await IncomingShareStore.oldestPendingShare(in: fixture.container)
        let snapshot = try XCTUnwrap(pendingSnapshot)
        XCTAssertEqual(
            try snapshot.photos.map { try String(decoding: Data(contentsOf: $0.fileURL), as: UTF8.self) },
            ["first", "second"]
        )
        let firstAcceptance = try await IncomingShareStore.accept(id: snapshot.id, in: fixture.container)
        let secondAcceptance = try await IncomingShareStore.accept(id: snapshot.id, in: fixture.container)
        let remaining = try await IncomingShareStore.oldestPendingShare(in: fixture.container)
        XCTAssertTrue(firstAcceptance)
        XCTAssertFalse(secondAcceptance)
        XCTAssertNil(remaining)
    }

    func testReturnsBatchesInFIFOOrder() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let first = try fixture.source(name: "first.jpg", contents: "first")
        let second = try fixture.source(name: "second.jpg", contents: "second")

        let olderID = try await IncomingShareStore.stage(
            fileURLs: [first],
            in: fixture.container
        )
        let newerID = try await IncomingShareStore.stage(
            fileURLs: [second],
            in: fixture.container
        )

        let pendingOlder = try await IncomingShareStore.oldestPendingShare(in: fixture.container)
        let older = try XCTUnwrap(pendingOlder)
        XCTAssertEqual(older.id, olderID)
        let accepted = try await IncomingShareStore.accept(id: older.id, in: fixture.container)
        let next = try await IncomingShareStore.oldestPendingShare(in: fixture.container)
        XCTAssertTrue(accepted)
        XCTAssertEqual(next?.id, newerID)
    }

    func testPublicationOrderDoesNotDependOnBatchID() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let photo = try fixture.source(name: "photo.jpg", contents: "photo")

        var firstID = ""
        var secondID = ""
        repeat {
            try? FileManager.default.removeItem(at: fixture.container)
            firstID = try await IncomingShareStore.stage(fileURLs: [photo], in: fixture.container)
            secondID = try await IncomingShareStore.stage(fileURLs: [photo], in: fixture.container)
        } while firstID < secondID

        let oldest = try await IncomingShareStore.oldestPendingShare(in: fixture.container)
        XCTAssertEqual(oldest?.id, firstID)
    }

    func testAcceptedBatchCannotReappearWhenCleanupIsDeferred() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let photo = try fixture.source(name: "photo.jpg", contents: "photo")
        let id = try await IncomingShareStore.stage(fileURLs: [photo], in: fixture.container)

        let accepted = try await IncomingShareStore.accept(
            id: id,
            in: fixture.container,
            cleanupAccepted: false
        )
        let pending = try await IncomingShareStore.oldestPendingShare(in: fixture.container)
        XCTAssertTrue(accepted)
        XCTAssertNil(pending)
    }

    func testRejectsInvalidInputWithoutPublishingBatch() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let empty = try fixture.source(name: "empty.jpg", data: Data())

        do {
            try await IncomingShareStore.stage(fileURLs: [empty], in: fixture.container)
            XCTFail("Expected empty input to fail")
        } catch IncomingShareError.stagingFailed {
        }
        let pending = try await IncomingShareStore.oldestPendingShare(in: fixture.container)
        XCTAssertNil(pending)

        let tooMany = (0...IncomingShareStore.maximumPhotoCount).map {
            fixture.sources.appendingPathComponent("missing-\($0).jpg")
        }
        do {
            try await IncomingShareStore.stage(fileURLs: tooMany, in: fixture.container)
            XCTFail("Expected the photo count limit")
        } catch IncomingShareError.tooManyPhotos {
        }
    }

    func testCancelledStageDoesNotPublishBatch() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let missing = fixture.sources.appendingPathComponent("missing.jpg")
        let task = Task {
            try await IncomingShareStore.stage(fileURLs: Array(repeating: missing, count: 50), in: fixture.container)
        }

        task.cancel()
        do {
            _ = try await task.value
            XCTFail("Expected cancellation")
        } catch is CancellationError {
        }

        let pending = try await IncomingShareStore.oldestPendingShare(in: fixture.container)
        XCTAssertNil(pending)
    }

    func testInvalidPendingBatchIsQuarantined() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let id = UUID().uuidString
        let batch = fixture.container
            .appendingPathComponent("incoming-shares-v2", isDirectory: true)
            .appendingPathComponent("pending", isDirectory: true)
            .appendingPathComponent(id, isDirectory: true)
        try FileManager.default.createDirectory(at: batch, withIntermediateDirectories: true)
        try Data("not-json".utf8).write(to: batch.appendingPathComponent("manifest.json"))

        let pending = try await IncomingShareStore.oldestPendingShare(in: fixture.container)
        XCTAssertNil(pending)
        XCTAssertFalse(FileManager.default.fileExists(atPath: batch.path))
    }

    func testLegacyPendingQueueIsDiscardedWithoutTouchingUnrelatedFiles() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let id = UUID().uuidString
        let manifests = fixture.container.appendingPathComponent(
            "incoming-share-manifests",
            isDirectory: true
        )
        let payload = fixture.container.appendingPathComponent(id, isDirectory: true)
        let unrelated = fixture.container.appendingPathComponent("keep-me")
        try FileManager.default.createDirectory(at: manifests, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: payload, withIntermediateDirectories: true)
        try Data("legacy".utf8).write(to: manifests.appendingPathComponent("\(id).json"))
        try Data("keep".utf8).write(to: unrelated)

        let pending = try await IncomingShareStore.oldestPendingShare(in: fixture.container)
        XCTAssertNil(pending)
        XCTAssertFalse(FileManager.default.fileExists(atPath: manifests.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: payload.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: unrelated.path))
    }

    func testConcurrentStagesAreEachAcceptedOnce() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let photo = try fixture.source(name: "photo.jpg", contents: "photo")
        let count = 8

        let stagedIDs = try await withThrowingTaskGroup(of: String.self) { group in
            for _ in 0..<count {
                group.addTask {
                    try await IncomingShareStore.stage(
                        fileURLs: [photo],
                        in: fixture.container
                    )
                }
            }
            var ids: [String] = []
            for try await id in group { ids.append(id) }
            return Set(ids)
        }

        var acceptedIDs: Set<String> = []
        while let snapshot = try await IncomingShareStore.oldestPendingShare(in: fixture.container) {
            let accepted = try await IncomingShareStore.accept(id: snapshot.id, in: fixture.container)
            XCTAssertTrue(accepted)
            XCTAssertTrue(acceptedIDs.insert(snapshot.id).inserted)
        }

        XCTAssertEqual(stagedIDs.count, count)
        XCTAssertEqual(acceptedIDs, stagedIDs)
    }
}

private struct Fixture {
    let root: URL
    let sources: URL
    let container: URL

    init() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        sources = root.appendingPathComponent("sources", isDirectory: true)
        container = root.appendingPathComponent("container", isDirectory: true)
        try FileManager.default.createDirectory(at: sources, withIntermediateDirectories: true)
    }

    func source(name: String, contents: String) throws -> URL {
        try source(name: name, data: Data(contents.utf8))
    }

    func source(name: String, data: Data) throws -> URL {
        let url = sources.appendingPathComponent(name)
        try data.write(to: url)
        return url
    }

    func remove() {
        try? FileManager.default.removeItem(at: root)
    }
}
