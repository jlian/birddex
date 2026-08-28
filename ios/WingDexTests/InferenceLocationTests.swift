import XCTest
@testable import WingDex

@MainActor
final class InferenceLocationTests: XCTestCase {
    private let photo = (lat: 48.9801, lon: -122.7887)
    private let searched = (lat: 47.6615, lon: -122.4256)

    func testNoPhotoGPSFallsBackToOutingLocation() {
        let result = AddPhotosViewModel.resolveInferenceLocation(
            useGeoContext: true,
            photoLat: nil,
            photoLon: nil,
            outingLocation: searched,
            outingOverridesPhotoGPS: true
        )
        XCTAssertEqual(result?.lat, searched.lat)
        XCTAssertEqual(result?.lon, searched.lon)
    }

    func testSearchedLocationOverridesPhotoGPS() {
        let result = AddPhotosViewModel.resolveInferenceLocation(
            useGeoContext: true,
            photoLat: photo.lat,
            photoLon: photo.lon,
            outingLocation: searched,
            outingOverridesPhotoGPS: true
        )
        XCTAssertEqual(result?.lat, searched.lat)
        XCTAssertEqual(result?.lon, searched.lon)
    }

    func testPhotoGPSWinsWithoutExplicitOverride() {
        let result = AddPhotosViewModel.resolveInferenceLocation(
            useGeoContext: true,
            photoLat: photo.lat,
            photoLon: photo.lon,
            outingLocation: searched,
            outingOverridesPhotoGPS: false
        )
        XCTAssertEqual(result?.lat, photo.lat)
        XCTAssertEqual(result?.lon, photo.lon)
    }

    func testDisabledGeoContextUsesNoLocation() {
        let result = AddPhotosViewModel.resolveInferenceLocation(
            useGeoContext: false,
            photoLat: photo.lat,
            photoLon: photo.lon,
            outingLocation: searched,
            outingOverridesPhotoGPS: true
        )
        XCTAssertNil(result)
    }
}