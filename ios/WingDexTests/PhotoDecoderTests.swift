@testable import WingDex
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import XCTest

/// The reduced-scale decode path.
///
/// Mirrors the web's DECODE_CAP behaviour: cap the LONGER side, preserve aspect
/// ratio, leave already-small photos alone.
final class PhotoDecoderTests: XCTestCase {
    /// A gradient rather than a flat fill, so a decoder that silently returned
    /// an embedded thumbnail or a blank buffer would not pass.
    private func makeJPEG(width: Int, height: Int) throws -> Data {
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        for y in 0..<height {
            for x in 0..<width {
                let i = (y * width + x) * 4
                pixels[i] = UInt8(x * 255 / max(width - 1, 1))
                pixels[i + 1] = UInt8(y * 255 / max(height - 1, 1))
                pixels[i + 2] = 128
                pixels[i + 3] = 255
            }
        }
        let cg: CGImage? = pixels.withUnsafeMutableBytes { raw in
            guard let ctx = CGContext(
                data: raw.baseAddress, width: width, height: height,
                bitsPerComponent: 8, bytesPerRow: width * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
            ) else { return nil }
            return ctx.makeImage()
        }
        let image = try XCTUnwrap(cg)
        let out = NSMutableData()
        let dest = try XCTUnwrap(
            CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.95] as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(dest))
        return out as Data
    }

    func testCapsTheLongerSideAndKeepsAspectRatio() throws {
        let data = try makeJPEG(width: 4128, height: 6192)
        let got = try XCTUnwrap(PhotoDecoder.decode(data))
        XCTAssertEqual(max(got.width, got.height), PhotoDecoder.decodeCap)
        // 4128/6192 scaled to a 500 long side is 333.3, so 333 or 334.
        XCTAssertEqual(Double(got.width) / Double(got.height), 4128.0 / 6192.0, accuracy: 0.01)
        XCTAssertEqual(got.data.count, got.width * got.height * 4)
        XCTAssertEqual(got.channels, 4)
    }

    func testLeavesPhotosSmallerThanTheCapAlone() throws {
        let data = try makeJPEG(width: 320, height: 240)
        let got = try XCTUnwrap(PhotoDecoder.decode(data))
        XCTAssertEqual(got.width, 320)
        XCTAssertEqual(got.height, 240)
    }

    func testHandlesLandscapeAndPortraitTheSameWay() throws {
        let landscape = try XCTUnwrap(PhotoDecoder.decode(try makeJPEG(width: 2000, height: 1000)))
        let portrait = try XCTUnwrap(PhotoDecoder.decode(try makeJPEG(width: 1000, height: 2000)))
        XCTAssertEqual(max(landscape.width, landscape.height), PhotoDecoder.decodeCap)
        XCTAssertEqual(max(portrait.width, portrait.height), PhotoDecoder.decodeCap)
        XCTAssertEqual(landscape.width, portrait.height)
        XCTAssertEqual(landscape.height, portrait.width)
    }

    func testDecodedPixelsAreNotBlank() throws {
        let got = try XCTUnwrap(PhotoDecoder.decode(try makeJPEG(width: 1200, height: 900)))
        let reds = Set(stride(from: 0, to: got.data.count, by: 4).map { got.data[$0] })
        XCTAssertGreaterThan(reds.count, 16, "gradient should survive the downsample")
    }

    func testReturnsNilForNonImageData() {
        XCTAssertNil(PhotoDecoder.decode(Data("not an image".utf8)))
    }

    /// The whole point of decoding at reduced scale: a 4128x6192 photo is 102 MB
    /// of RGBA at full size and about 2 MB at the cap.
    func testCappedDecodeAllocatesFarLessThanFullSize() throws {
        let got = try XCTUnwrap(PhotoDecoder.decode(try makeJPEG(width: 4128, height: 6192)))
        let fullSize = 4128 * 6192 * 4
        XCTAssertLessThan(got.data.count, fullSize / 40)
    }

    func testFeedsCLIPPreprocessDirectly() throws {
        let got = try XCTUnwrap(PhotoDecoder.decode(try makeJPEG(width: 1600, height: 1200)))
        let tensor = CLIPPreprocess.preprocess(got)
        XCTAssertEqual(tensor.count, 3 * 224 * 224)
        XCTAssertTrue(tensor.allSatisfy { $0.isFinite })
    }
}
