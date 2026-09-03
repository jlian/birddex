@testable import WingDex
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import XCTest

final class PhotoServiceTests: XCTestCase {
    private func makeImageData(
        width: Int,
        height: Int,
        properties: [CFString: Any] = [:]
    ) throws -> Data {
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let context = try XCTUnwrap(CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ))
        context.setFillColor(red: 0.2, green: 0.5, blue: 0.8, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = try XCTUnwrap(context.makeImage())

        let output = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(
            output,
            UTType.jpeg.identifier as CFString,
            1,
            nil
        ))
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return output as Data
    }

    private func imageDimensions(_ data: Data) throws -> CGSize {
        let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
        let properties = try XCTUnwrap(
            CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        )
        return CGSize(
            width: try XCTUnwrap(properties[kCGImagePropertyPixelWidth] as? CGFloat),
            height: try XCTUnwrap(properties[kCGImagePropertyPixelHeight] as? CGFloat)
        )
    }

    func testPreparationRecordsOriginalSizeAndDownsamplesThumbnail() throws {
        let original = try makeImageData(width: 1_200, height: 600)
        let prepared = try XCTUnwrap(PhotoService.preparePhoto(from: original))

        XCTAssertEqual(prepared.byteCount, original.count)
        let thumbnailSize = try imageDimensions(prepared.thumbnail)
        XCTAssertEqual(
            max(thumbnailSize.width, thumbnailSize.height),
            PhotoService.displayThumbnailDimension
        )
        XCTAssertEqual(thumbnailSize.width / thumbnailSize.height, 2, accuracy: 0.02)
    }

    func testThumbnailAppliesEXIFOrientation() throws {
        let original = try makeImageData(
            width: 400,
            height: 200,
            properties: [kCGImagePropertyOrientation: 6]
        )
        let prepared = try XCTUnwrap(PhotoService.preparePhoto(from: original, thumbnailDimension: 200))
        let thumbnailSize = try imageDimensions(prepared.thumbnail)

        XCTAssertEqual(thumbnailSize.width, 100)
        XCTAssertEqual(thumbnailSize.height, 200)
    }

    func testPreparationExtractsEXIFDateAndGPS() throws {
        let original = try makeImageData(
            width: 64,
            height: 64,
            properties: [
                kCGImagePropertyExifDictionary: [
                    kCGImagePropertyExifDateTimeOriginal: "2026:08:30 12:34:56",
                ],
                kCGImagePropertyGPSDictionary: [
                    kCGImagePropertyGPSLatitude: 47.61,
                    kCGImagePropertyGPSLatitudeRef: "N",
                    kCGImagePropertyGPSLongitude: 122.33,
                    kCGImagePropertyGPSLongitudeRef: "W",
                ],
            ]
        )
        let prepared = try XCTUnwrap(PhotoService.preparePhoto(from: original))

        XCTAssertNotNil(prepared.exifTime)
        XCTAssertEqual(try XCTUnwrap(prepared.gpsLat), 47.61, accuracy: 0.000_001)
        XCTAssertEqual(try XCTUnwrap(prepared.gpsLon), -122.33, accuracy: 0.000_001)
    }

    func testFilePreparationPreservesMetadataAndIdentity() throws {
        let original = try makeImageData(
            width: 1_200,
            height: 600,
            properties: [
                kCGImagePropertyExifDictionary: [
                    kCGImagePropertyExifDateTimeOriginal: "2026:08:30 12:34:56",
                ],
                kCGImagePropertyGPSDictionary: [
                    kCGImagePropertyGPSLatitude: 47.61,
                    kCGImagePropertyGPSLatitudeRef: "N",
                    kCGImagePropertyGPSLongitude: 122.33,
                    kCGImagePropertyGPSLongitudeRef: "W",
                ],
            ]
        )
        let fileURL = try PhotoFlowStore.writeCameraData(original)
        defer { PhotoFlowStore.remove([fileURL]) }

        let prepared = try XCTUnwrap(PhotoService.preparePhoto(at: fileURL))

        XCTAssertEqual(prepared.byteCount, original.count)
        XCTAssertEqual(prepared.fileHash, PhotoService.fileHash(for: original))
        XCTAssertNotNil(prepared.exifTime)
        XCTAssertEqual(try XCTUnwrap(prepared.gpsLat), 47.61, accuracy: 0.000_001)
        XCTAssertEqual(try XCTUnwrap(prepared.gpsLon), -122.33, accuracy: 0.000_001)
        let thumbnailSize = try imageDimensions(prepared.thumbnail)
        XCTAssertEqual(
            max(thumbnailSize.width, thumbnailSize.height),
            PhotoService.displayThumbnailDimension
        )
    }

    func testFilePreparationRejectsInvalidImage() throws {
        let fileURL = try PhotoFlowStore.writeCameraData(Data("not an image".utf8))
        defer { PhotoFlowStore.remove([fileURL]) }

        XCTAssertNil(PhotoService.preparePhoto(at: fileURL))
    }

    func testFileHashUsesPrefixAndFileSize() {
        let prefix = Data(repeating: 7, count: 65_536)
        let first = prefix + Data([1, 2, 3])
        let sameIdentity = prefix + Data([9, 8, 7])
        let differentSize = prefix + Data([1, 2, 3, 4])

        XCTAssertEqual(PhotoService.fileHash(for: first), PhotoService.fileHash(for: sameIdentity))
        XCTAssertNotEqual(PhotoService.fileHash(for: first), PhotoService.fileHash(for: differentSize))
    }

    func testPreparationRejectsInvalidImageData() {
        XCTAssertNil(PhotoService.preparePhoto(from: Data("not an image".utf8)))
    }
}
