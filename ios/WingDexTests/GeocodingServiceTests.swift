@testable import WingDex
import XCTest

final class GeocodingServiceTests: XCTestCase {
    func testDecodesNormalizedGeocodingResult() throws {
        let data = Data(#"""
        {
          "label": "Discovery Park",
          "context": "Seattle, Washington",
          "lat": 47.6573,
          "lon": -122.4055,
          "stateProvince": "US-WA",
          "countryCode": "US"
        }
        """#.utf8)

        let result = try JSONDecoder().decode(GeocodingResult.self, from: data)

        XCTAssertEqual(result.label, "Discovery Park")
        XCTAssertEqual(result.context, "Seattle, Washington")
        XCTAssertEqual(result.latitude, 47.6573)
        XCTAssertEqual(result.longitude, -122.4055)
        XCTAssertEqual(result.stateProvince, "US-WA")
        XCTAssertEqual(result.countryCode, "US")
    }

    func testResultIdentityIncludesCoordinatesAndLabel() throws {
        let result = GeocodingResult(
            label: "Green Lake",
            context: "Seattle, Washington",
            latitude: 47.68,
            longitude: -122.33,
            stateProvince: "US-WA",
            countryCode: "US"
        )

        XCTAssertEqual(result.id, "47.68,-122.33,Green Lake")
    }

    func testServerErrorRetainsTraceID() {
        let error = GeocodingServiceError.server(
            statusCode: 503,
            traceID: "0123456789abcdef0123456789abcdef"
        )

        guard case .server(let statusCode, let traceID) = error else {
            return XCTFail("Expected server error")
        }
        XCTAssertEqual(statusCode, 503)
        XCTAssertEqual(traceID, "0123456789abcdef0123456789abcdef")
    }
}