@testable import WingDex
import XCTest

/// Parity for the CLIP preprocessing port.
///
/// Uses the ml/parity fixture ladder, which is generated on tomahawk:
///   src_NNN.u8.bin   full-size decoded RGB, w*h*3
///   rs_NNN.u8.bin    after both resample passes, nw*nh*3
///   ref_NNN.f32.bin  the PIL reference tensor, 3*224*224
///   js_NNN.f32.bin   the shipped TypeScript tensor, 3*224*224
///
/// Swift and TypeScript run the same double-precision math and both quantise to
/// integers before normalising, so they should agree to the bit. PIL is the
/// ground truth and is allowed a small tolerance, matching what the web port
/// was held to.
///
/// These fixtures are gitignored. Without them the tests skip rather than pass
/// vacuously.
final class CLIPPreprocessParityTests: XCTestCase {
    private struct Meta: Decodable {
        struct Photo: Decodable {
            let i: Int
            let w: Int
            let h: Int
        }
        let photos: [Photo]
    }

    private static let parityDir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()   // WingDexTests
        .deletingLastPathComponent()   // ios
        .deletingLastPathComponent()   // repo root
        .appendingPathComponent("ml/parity")

    private static func loadMeta() throws -> Meta {
        let url = parityDir.appendingPathComponent("meta.json")
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw XCTSkip("Missing \(url.path). Copy ml/parity from tomahawk to run these.")
        }
        return try JSONDecoder().decode(Meta.self, from: Data(contentsOf: url))
    }

    private static func bytes(_ name: String) throws -> [UInt8] {
        [UInt8](try Data(contentsOf: parityDir.appendingPathComponent(name)))
    }

    private static func floats(_ name: String) throws -> [Float] {
        let d = try Data(contentsOf: parityDir.appendingPathComponent(name))
        return d.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
    }

    private static func tag(_ i: Int) -> String { String(format: "%03d", i) }

    func testResizeDimensionsUseFloorNotRound() throws {
        let meta = try Self.loadMeta()
        for p in meta.photos {
            let short = min(p.w, p.h)
            let long = max(p.w, p.h)
            let want = Int((224.0 * Double(long) / Double(short)).rounded(.down))
            let got = CLIPPreprocess.outputSize(width: p.w, height: p.h, size: 224)
            XCTAssertEqual(max(got.width, got.height), want, "photo \(p.i) is \(p.w)x\(p.h)")
            XCTAssertEqual(min(got.width, got.height), 224)
        }
        // The case the comment in the port calls out: floor gives 335, round 336.
        XCTAssertEqual(CLIPPreprocess.outputSize(width: 1024, height: 683, size: 224).width, 335)
    }

    /// One pass over the fixtures, because preprocessing 24 full-size photos in
    /// a Debug build is not cheap and both comparisons need the same tensors.
    func testMatchesTypeScriptExactlyAndPILNoWorseThanTypeScriptDoes() throws {
        let meta = try Self.loadMeta()
        var worstTS: Float = 0
        var worstSwiftPIL: Float = 0
        var worstTSPIL: Float = 0

        for p in meta.photos {
            let src = try Self.bytes("src_\(Self.tag(p.i)).u8.bin")
            let js = try Self.floats("js_\(Self.tag(p.i)).f32.bin")
            let pil = try Self.floats("ref_\(Self.tag(p.i)).f32.bin")
            let got = CLIPPreprocess.preprocess(
                CLIPPreprocess.RGB(data: src, width: p.w, height: p.h, channels: 3))
            XCTAssertEqual(got.count, js.count, "length for photo \(p.i)")
            for k in 0..<min(got.count, js.count) {
                worstTS = max(worstTS, abs(got[k] - js[k]))
                worstSwiftPIL = max(worstSwiftPIL, abs(got[k] - pil[k]))
                worstTSPIL = max(worstTSPIL, abs(js[k] - pil[k]))
            }
        }

        // Both sides quantise to integers before normalising, so any difference
        // at all means a one-pixel window shift, not float drift.
        XCTAssertEqual(Double(worstTS), 0.0, accuracy: 1e-6,
                       "worst |swift - typescript| across all fixtures")

        // PIL is the ground truth and the shipped web port already sits ~2
        // uint8 units away from it (0.0300, which is 2/255 divided by the
        // smallest CLIP std). Pinning Swift to the SAME bound rather than an
        // invented constant means this fails if Swift ever drifts further from
        // PIL than the implementation already in production.
        XCTAssertLessThanOrEqual(worstSwiftPIL, worstTSPIL + 1e-6,
                                 "swift must be no further from PIL than the web port is")
    }

    func testReadsRGBAWithoutRepacking() throws {
        let meta = try Self.loadMeta()
        let p = meta.photos[0]
        let rgb = try Self.bytes("src_\(Self.tag(p.i)).u8.bin")
        var rgba = [UInt8](repeating: 255, count: p.w * p.h * 4)
        for i in 0..<(p.w * p.h) {
            rgba[i * 4] = rgb[i * 3]
            rgba[i * 4 + 1] = rgb[i * 3 + 1]
            rgba[i * 4 + 2] = rgb[i * 3 + 2]
        }
        let a = CLIPPreprocess.preprocess(
            CLIPPreprocess.RGB(data: rgb, width: p.w, height: p.h, channels: 3))
        let b = CLIPPreprocess.preprocess(
            CLIPPreprocess.RGB(data: rgba, width: p.w, height: p.h, channels: 4))
        XCTAssertEqual(a, b, "4-channel read must skip alpha, not shift the window")
    }

    func testBankersRoundingMatchesPython() {
        // Half-to-even, so 52.5 is 52 and 53.5 is 54. Foundation's rounded()
        // gives 53 and 54, which shifts the crop on odd margins.
        XCTAssertEqual(CLIPPreprocess.bankersRound(52.5), 52)
        XCTAssertEqual(CLIPPreprocess.bankersRound(53.5), 54)
        XCTAssertEqual(CLIPPreprocess.bankersRound(-0.5), 0)
        XCTAssertEqual(CLIPPreprocess.bankersRound(2.4), 2)
        XCTAssertEqual(CLIPPreprocess.bankersRound(2.6), 3)
    }
}
