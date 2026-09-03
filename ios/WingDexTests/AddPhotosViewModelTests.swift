@testable import WingDex
import XCTest

@MainActor
final class AddPhotosViewModelTests: XCTestCase {
    func testAccountChangeResetsAndDismissesActiveFlow() async throws {
        let auth = AuthService()
        auth.userId = "account-a"
        let store = DataStore(service: DataService(auth: auth))
        store.activate(accountID: "account-a")
        let viewModel = AddPhotosViewModel()
        viewModel.configure(auth: auth, dataStore: store)

        let fileURL = try PhotoFlowStore.writeCameraData(Data("photo".utf8))
        let photo = ProcessedPhoto(
            id: "photo",
            originalURL: fileURL,
            cleanupOriginal: true,
            thumbnail: Data(),
            exifTime: nil,
            gpsLat: nil,
            gpsLon: nil,
            fileHash: "hash",
            fileName: "photo.jpg",
            byteCount: 5
        )
        viewModel.processedPhotos = [photo]
        viewModel.clusters = [PhotoCluster(
            photos: [photo],
            startTime: .now,
            endTime: .now,
            centerLat: nil,
            centerLon: nil
        )]
        viewModel.currentStep = .outingReview
        viewModel.isProcessing = true
        let dismissalRequestID = viewModel.flowDismissalRequestID

        auth.userId = "account-b"
        store.activate(accountID: "account-b")
        viewModel.configure(auth: auth, dataStore: store)

        XCTAssertEqual(viewModel.currentStep, .selectPhotos)
        XCTAssertTrue(viewModel.processedPhotos.isEmpty)
        XCTAssertTrue(viewModel.clusters.isEmpty)
        XCTAssertFalse(viewModel.isProcessing)
        XCTAssertTrue(viewModel.stoppedShareQueueAfterDismissal)
        XCTAssertNotEqual(viewModel.flowDismissalRequestID, dismissalRequestID)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fileURL.path))
        await viewModel.cancelSession()
    }
}
