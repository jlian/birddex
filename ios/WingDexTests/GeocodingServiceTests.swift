@testable import WingDex
import XCTest

final class GeocodingServiceTests: XCTestCase {
    func testDecodesNormalizedGeocodingResult() throws {
        let data = Data(#"""
        {
          "label": "Discovery Park, Seattle, Washington",
          "lat": 47.6573,
          "lon": -122.4055,
          "stateProvince": "US-WA",
          "countryCode": "US",
          "attribution": {
            "label": "Location data © OpenStreetMap contributors",
            "url": "https://www.openstreetmap.org/copyright"
          }
        }
        """#.utf8)

        let result = try JSONDecoder().decode(GeocodingResult.self, from: data)

        XCTAssertEqual(result.label, "Discovery Park, Seattle, Washington")
        XCTAssertEqual(result.latitude, 47.6573)
        XCTAssertEqual(result.longitude, -122.4055)
        XCTAssertEqual(result.stateProvince, "US-WA")
        XCTAssertEqual(result.countryCode, "US")
        XCTAssertEqual(result.attribution.url.absoluteString, "https://www.openstreetmap.org/copyright")
    }

    func testResultIdentityIncludesCoordinatesAndLabel() throws {
        let result = GeocodingResult(
            label: "Green Lake",
            latitude: 47.68,
            longitude: -122.33,
            stateProvince: "US-WA",
            countryCode: "US",
            attribution: .init(
                label: "Location data © OpenStreetMap contributors",
                url: URL(string: "https://www.openstreetmap.org/copyright")!
            )
        )

        XCTAssertEqual(result.id, "47.68,-122.33,Green Lake")
    }
}