@testable import WingDex
import XCTest

@MainActor
final class AddPhotosViewModelTests: XCTestCase {
    func testHistoricalNameIsNotPrefilledAndConfirmedDeviceCoordinatesFeedInference() async throws {
        let previousGeoContext = UserDefaults.standard.object(forKey: "useGeoContext")
        defer { UserDefaults.standard.set(previousGeoContext, forKey: "useGeoContext") }
        let auth = AuthService()
        auth.installUITestAnonymousIdentity()
        let store = DataStore(service: UITestDataService(mode: .populated))
        store.activate(accountID: try XCTUnwrap(auth.userId))
        await store.loadAll()
        XCTAssertFalse(store.outings.isEmpty)
        let viewModel = AddPhotosViewModel()
        viewModel.configure(auth: auth, dataStore: store)
        XCTAssertEqual(viewModel.lastLocationName, "")
        let photo = ProcessedPhoto(
            id: "no-gps", originalURL: URL(fileURLWithPath: #filePath), cleanupOriginal: false,
            thumbnail: Data(), exifTime: nil, gpsLat: nil, gpsLon: nil,
            fileHash: "no-gps", fileName: "no-gps.jpg", byteCount: 0
        )
        viewModel.clusters = [PhotoCluster(
            photos: [photo], startTime: .now, endTime: .now, centerLat: nil, centerLon: nil
        )]
        viewModel.useGeoContext = true
        viewModel.outingConfirmed(
            outing: nil, outingId: "confirmed", locationName: " Current Park ",
            lat: 47.7115123, lon: -122.3717456, outingOverridesPhotoGPS: true
        )
        XCTAssertEqual(viewModel.lastLocationName, "Current Park")
        XCTAssertEqual(viewModel.currentInferenceLocation?.lat, 47.7115123)
        XCTAssertEqual(viewModel.currentInferenceLocation?.lon, -122.3717456)
        XCTAssertNil(viewModel.currentPhoto?.gpsLat)
        XCTAssertNil(viewModel.currentPhoto?.gpsLon)
        viewModel.useGeoContext = false
        XCTAssertNil(viewModel.currentInferenceLocation)
        await viewModel.cancelSession()
    }

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
