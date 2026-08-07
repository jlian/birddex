@testable import WingDex
import XCTest

final class PrivacyManifestTests: XCTestCase {
    func testAppBundleDeclaresUserDefaultsReason() throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "PrivacyInfo", withExtension: "xcprivacy"))
        let data = try Data(contentsOf: url)
        let plist = try XCTUnwrap(
            PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        )
        let apiTypes = try XCTUnwrap(plist["NSPrivacyAccessedAPITypes"] as? [[String: Any]])
        let userDefaults = try XCTUnwrap(apiTypes.first {
            $0["NSPrivacyAccessedAPIType"] as? String == "NSPrivacyAccessedAPICategoryUserDefaults"
        })
        let reasons = try XCTUnwrap(userDefaults["NSPrivacyAccessedAPITypeReasons"] as? [String])

        XCTAssertEqual(reasons, ["CA92.1"])
    }
}
