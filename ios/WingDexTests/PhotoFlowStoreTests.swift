@testable import WingDex
import XCTest

final class PhotoFlowStoreTests: XCTestCase {
    func testImportCopiesFileIntoOwnedStorage() throws {
        let source = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(UUID().uuidString).jpg")
        try Data("photo".utf8).write(to: source)
        defer { try? FileManager.default.removeItem(at: source) }

        let imported = try PhotoFlowStore.importFile(source)
        defer { PhotoFlowStore.remove([imported]) }

        XCTAssertNotEqual(imported, source)
        XCTAssertEqual(try Data(contentsOf: imported), Data("photo".utf8))
        XCTAssertTrue(FileManager.default.fileExists(atPath: source.path))
    }

    func testRemoveDeletesOnlyOwnedFiles() throws {
        let external = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(UUID().uuidString).jpg")
        try Data("photo".utf8).write(to: external)
        defer { try? FileManager.default.removeItem(at: external) }
        let imported = try PhotoFlowStore.importFile(external)

        PhotoFlowStore.remove([external, imported])

        XCTAssertTrue(FileManager.default.fileExists(atPath: external.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: imported.path))
    }

    func testCameraDataRejectsEmptyInput() {
        XCTAssertThrowsError(try PhotoFlowStore.writeCameraData(Data())) { error in
            XCTAssertEqual(error as? IncomingShareError, .stagingFailed)
        }
    }

    func testPurgeAllFilesRemovesRecentFlowFiles() throws {
        let file = try PhotoFlowStore.writeCameraData(Data("photo".utf8))
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))

        try PhotoFlowStore.purgeAllFiles()
        let nextFile = try PhotoFlowStore.writeCameraData(Data("next".utf8))
        defer { PhotoFlowStore.remove([nextFile]) }

        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: nextFile.path))
    }
}
