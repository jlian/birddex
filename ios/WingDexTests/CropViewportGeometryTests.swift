@testable import WingDex
import CoreGraphics
import XCTest

final class CropViewportGeometryTests: XCTestCase {
    func testMinimumZoomScaleFillsSquareForLandscapeAndPortrait() {
        XCTAssertEqual(
            CropViewportGeometry.minimumZoomScale(
                imageSize: CGSize(width: 1_200, height: 800),
                viewportSide: 400
            ),
            0.5
        )
        XCTAssertEqual(
            CropViewportGeometry.minimumZoomScale(
                imageSize: CGSize(width: 800, height: 1_200),
                viewportSide: 400
            ),
            0.5
        )
    }

    func testCropToViewportRoundTrip() {
        let imageSize = CGSize(width: 1_200, height: 800)
        let crop = CropBoxResult(x: 25, y: 12.5, width: 50, height: 75)
        let minimum = CropViewportGeometry.minimumZoomScale(
            imageSize: imageSize,
            viewportSide: 300
        )
        let viewport = CropViewportGeometry.viewport(
            for: crop,
            imageSize: imageSize,
            viewportSide: 300,
            minimumZoomScale: minimum,
            maximumZoomScale: minimum * 6
        )
        let result = CropViewportGeometry.cropResult(
            imageSize: imageSize,
            viewportSide: 300,
            zoomScale: viewport.zoomScale,
            contentOffset: viewport.contentOffset
        )

        XCTAssertEqual(result.x, crop.x, accuracy: 0.000_001)
        XCTAssertEqual(result.y, crop.y, accuracy: 0.000_001)
        XCTAssertEqual(result.width, crop.width, accuracy: 0.000_001)
        XCTAssertEqual(result.height, crop.height, accuracy: 0.000_001)
    }

    func testInitialCropClampsToImageEdges() {
        let imageSize = CGSize(width: 1_000, height: 1_000)
        let minimum = CropViewportGeometry.minimumZoomScale(
            imageSize: imageSize,
            viewportSide: 500
        )
        let viewport = CropViewportGeometry.viewport(
            for: CropBoxResult(x: 90, y: -20, width: 50, height: 50),
            imageSize: imageSize,
            viewportSide: 500,
            minimumZoomScale: minimum,
            maximumZoomScale: minimum * 6
        )
        let result = CropViewportGeometry.cropResult(
            imageSize: imageSize,
            viewportSide: 500,
            zoomScale: viewport.zoomScale,
            contentOffset: viewport.contentOffset
        )

        XCTAssertEqual(result.x, 50, accuracy: 0.000_001)
        XCTAssertEqual(result.y, 0, accuracy: 0.000_001)
    }

    func testViewportHonorsOneToSixTimesZoomLimits() {
        let imageSize = CGSize(width: 1_000, height: 500)
        let minimum = CropViewportGeometry.minimumZoomScale(
            imageSize: imageSize,
            viewportSide: 500
        )
        let zoomedOut = CropViewportGeometry.viewport(
            for: CropBoxResult(x: 0, y: 0, width: 100, height: 100),
            imageSize: imageSize,
            viewportSide: 500,
            minimumZoomScale: minimum,
            maximumZoomScale: minimum * 6
        )
        let zoomedIn = CropViewportGeometry.viewport(
            for: CropBoxResult(x: 49.5, y: 49, width: 1, height: 2),
            imageSize: imageSize,
            viewportSide: 500,
            minimumZoomScale: minimum,
            maximumZoomScale: minimum * 6
        )

        XCTAssertEqual(zoomedOut.zoomScale, minimum)
        XCTAssertEqual(zoomedIn.zoomScale, minimum * 6)
    }

    func testCropResultClampsScrollViewBounceOffsets() {
        let result = CropViewportGeometry.cropResult(
            imageSize: CGSize(width: 1_000, height: 500),
            viewportSide: 250,
            zoomScale: 1,
            contentOffset: CGPoint(x: -80, y: 900)
        )

        XCTAssertEqual(result.x, 0)
        XCTAssertEqual(result.y, 50)
        XCTAssertEqual(result.width, 25)
        XCTAssertEqual(result.height, 50)
    }
}
