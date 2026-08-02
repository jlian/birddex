import XCTest
@testable import WingDex

final class WikimediaURLTests: XCTestCase {
    private let prefix = "https://upload.wikimedia.org/wikipedia/commons/"

    func testRewritesStandardThumbnailWidth() {
        let thumb = prefix + "thumb/e/e1/Somali_ostrich.jpg/330px-Somali_ostrich.jpg"
        XCTAssertEqual(
            heroImageUrl(fromThumbnail: thumb),
            prefix + "thumb/e/e1/Somali_ostrich.jpg/960px-Somali_ostrich.jpg"
        )
    }

    func testPreservesPercentEncodedFilenames() {
        let thumb = prefix + "thumb/9/9d/Struthio_camelus_-_Etosha_2014_%283%29.jpg/330px-Struthio_camelus_-_Etosha_2014_%283%29.jpg"
        XCTAssertEqual(
            heroImageUrl(fromThumbnail: thumb),
            prefix + "thumb/9/9d/Struthio_camelus_-_Etosha_2014_%283%29.jpg/960px-Struthio_camelus_-_Etosha_2014_%283%29.jpg"
        )
    }

    /// Multi-page sources (TIFF) carry a `lossy-pageN-` prefix ahead of the width.
    func testRewritesWidthInMultiPageRendering() {
        let thumb = prefix + "thumb/6/65/Tinamotis_pentlandii.tif/lossy-page1-330px-Tinamotis_pentlandii.tif.jpg"
        XCTAssertEqual(
            heroImageUrl(fromThumbnail: thumb),
            prefix + "thumb/6/65/Tinamotis_pentlandii.tif/lossy-page1-960px-Tinamotis_pentlandii.tif.jpg"
        )
    }

    func testReturnsNilForOriginalsWithoutThumbSegment() {
        XCTAssertNil(heroImageUrl(fromThumbnail: prefix + "d/d8/Taoniscus.jpg"))
    }

    func testReturnsNilForMissingThumbnail() {
        XCTAssertNil(heroImageUrl(fromThumbnail: nil))
    }
}
