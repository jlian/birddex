import XCTest
@testable import WingDex

/// `SFSafariViewController` raises NSInvalidArgumentException for any scheme
/// other than http(s), which crashed the app when a mis-parsed markdown link
/// produced a schemeless URL.
final class SafariLinkTests: XCTestCase {
    func testAcceptsHTTPAndHTTPS() {
        XCTAssertNotNil(SafariLink(url: URL(string: "https://commons.wikimedia.org/wiki/File:Bird.jpg")!))
        XCTAssertNotNil(SafariLink(url: URL(string: "http://example.org")!))
    }

    func testAcceptsCommonsFilePagesWithParenthesesAndPercentEncoding() {
        let page = "https://commons.wikimedia.org/wiki/File:Great-tailed_Grackle_(Quiscalus_mexicanus)_male.jpg"
        XCTAssertNotNil(SafariLink(url: URL(string: page)!))
        let encoded = "https://commons.wikimedia.org/wiki/File:Struthio_camelus_%283%29.jpg"
        XCTAssertNotNil(SafariLink(url: URL(string: encoded)!))
    }

    func testRejectsSchemelessAndNonWebURLs() {
        // A relative URL is what a truncated markdown destination produces.
        XCTAssertNil(SafariLink(url: URL(string: "commons.wikimedia.org/wiki/File:Bird.jpg")!))
        XCTAssertNil(SafariLink(url: URL(string: "file:///etc/passwd")!))
        XCTAssertNil(SafariLink(url: URL(string: "javascript:alert(1)")!))
        XCTAssertNil(SafariLink(url: URL(string: "wingdex://species/robin")!))
    }

    func testSchemeMatchIsCaseInsensitive() {
        XCTAssertNotNil(SafariLink(url: URL(string: "HTTPS://example.org")!))
    }
}
