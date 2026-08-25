@testable import WingDex
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import XCTest

/// End-to-end checks for the bundled engine.
///
/// These load the real 37 MiB Core ML model and the real 23 MiB prior out of
/// the app bundle, so they also verify the asset pipeline in
/// ios/scripts/sync-birdid-assets.sh actually put them there.
final class BirdIdEngineTests: XCTestCase {
    private func makeJPEG(width: Int, height: Int) throws -> Data {
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        for y in 0..<height {
            for x in 0..<width {
                let i = (y * width + x) * 4
                pixels[i] = UInt8((x * 255) / max(width - 1, 1))
                pixels[i + 1] = UInt8((y * 255) / max(height - 1, 1))
                pixels[i + 2] = UInt8((x + y) % 256)
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
        CGImageDestinationAddImage(dest, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(dest))
        return out as Data
    }

    func testAllThreeAssetsAreInTheBundle() throws {
        XCTAssertNotNil(Bundle.main.url(forResource: "WingCLIP", withExtension: "mlmodelc"),
                        "Core ML model missing; is WingDex/ML/WingCLIP.mlpackage in Sources?")
        XCTAssertNotNil(Bundle.main.url(forResource: "text_classifier_int8", withExtension: "bin"),
                        "classifier missing; run ios/scripts/sync-birdid-assets.sh")
        XCTAssertNotNil(Bundle.main.url(forResource: "occurrence", withExtension: "bin"),
                        "prior missing; run ios/scripts/sync-birdid-assets.sh")
    }

    func testClassifierDecodesTo11167RowsOf768() throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "text_classifier_int8",
                                                withExtension: "bin"))
        let (rows, n) = try BirdIdEngine.decodeInt8Rows(try Data(contentsOf: url), dim: 768)
        XCTAssertEqual(n, 11167)
        XCTAssertEqual(rows.count, 11167 * 768)

        // Rows are L2-normalised before quantisation, so the dequantised norm
        // should land near 1. A byte-order or scale-offset mistake would not.
        for s in [0, 5000, 11166] {
            let row = rows[(s * 768)..<((s + 1) * 768)]
            let norm = row.reduce(0) { $0 + Double($1 * $1) }.squareRoot()
            XCTAssertEqual(norm, 1.0, accuracy: 0.02, "row \(s) norm")
        }
    }

    func testTaxonomyNamesLineUpWithTheClassifier() throws {
        let names = try BirdIdEngine.loadTaxonomyNames()
        XCTAssertEqual(names.count, 11167)
        XCTAssertEqual(names[0].common, "Common Ostrich")
        XCTAssertEqual(names[0].scientific, "Struthio camelus")
        XCTAssertFalse(names.contains { $0.common.isEmpty || $0.scientific.isEmpty })
    }

    func testIdentifyReturnsRankedCandidatesThatSumToOne() async throws {
        let data = try makeJPEG(width: 1200, height: 900)
        let results = try await BirdIdEngine.shared.identify(
            imageData: data, location: (lat: 40.7813, lon: -73.9665), month: 6)

        XCTAssertEqual(results.count, 5)
        XCTAssertTrue(results.allSatisfy { !$0.commonName.isEmpty })
        // Confidence is a softmax over the full 25 candidates, so the top 5 sum
        // to at most 1 rather than exactly 1.
        let total = results.reduce(0) { $0 + $1.confidence }
        XCTAssertGreaterThan(total, 0)
        XCTAssertLessThanOrEqual(total, 1.0 + 1e-9)
        for i in 1..<results.count {
            XCTAssertLessThanOrEqual(results[i].confidence, results[i - 1].confidence,
                                     "confidence must be descending")
        }
        XCTAssertTrue(results.allSatisfy { $0.logP != nil },
                      "a populated cell with a month should apply the prior")
    }

    func testWithoutLocationTheRankerDegradesToVisionOnly() async throws {
        let data = try makeJPEG(width: 800, height: 600)
        let results = try await BirdIdEngine.shared.identify(
            imageData: data, location: nil, month: 6)
        XCTAssertEqual(results.count, 5)
        XCTAssertTrue(results.allSatisfy { $0.logP == nil })
    }

    /// The old server API took month 0-11. Passing 0 must degrade to
    /// vision-only rather than quietly applying December's distribution.
    func testZeroMonthDegradesRatherThanMiskeying() async throws {
        let data = try makeJPEG(width: 800, height: 600)
        let loc = (lat: 40.7813, lon: -73.9665)
        let bad = try await BirdIdEngine.shared.identify(imageData: data, location: loc, month: 0)
        XCTAssertTrue(bad.allSatisfy { $0.logP == nil })
        let good = try await BirdIdEngine.shared.identify(imageData: data, location: loc, month: 1)
        XCTAssertTrue(good.allSatisfy { $0.logP != nil })
    }

    func testCalibrationMatchesTheWebGoldenFixture() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/birdid-golden.json")
        try XCTSkipUnless(FileManager.default.fileExists(atPath: url.path))
        struct Golden: Decodable {
            struct Probe: Decodable {
                let bias: Double
                let plattA: Double
                let plattB: Double
                let threshold: Double
            }
            struct Calibration: Decodable {
                let temperature: Double
                let beta: Double
                let probe: Probe
            }
            let taxonomySha16: String
            let calibration: Calibration
        }
        let g = try JSONDecoder().decode(Golden.self, from: try Data(contentsOf: url))
        XCTAssertEqual(BirdIdEngine.calibration.temperature, g.calibration.temperature)
        XCTAssertEqual(BirdIdEngine.calibration.beta, g.calibration.beta)
        // The probe scalars drift the same silent way temperature and beta do:
        // a mismatched threshold still gates, just at the wrong rate.
        XCTAssertEqual(BirdIdEngine.calibration.probe.bias, g.calibration.probe.bias)
        XCTAssertEqual(BirdIdEngine.calibration.probe.plattA, g.calibration.probe.plattA)
        XCTAssertEqual(BirdIdEngine.calibration.probe.plattB, g.calibration.probe.plattB)
        XCTAssertEqual(BirdIdEngine.calibration.probe.threshold, g.calibration.probe.threshold)
        XCTAssertEqual(BirdIdEngine.taxonomySha16, g.taxonomySha16)
    }
}
