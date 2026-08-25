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
/// The reference is built from the SHIPPED CHECKPOINT'S timm transform,
/// Resize(248) -> CenterCrop(224), read off the checkpoint by
/// ml/distill/jobs/dump_preproc_ref.py. It used to be built from generic
/// open_clip ViT-B-16, which is 224 -> 224 and makes the crop a no-op, so this
/// whole ladder passed while the client fed the model the wrong picture.
/// Fixtures generated before 2026-08-25 are STALE and will fail; regenerate
/// them rather than relaxing the bound.
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
        let target = CLIPPreprocess.resize
        for p in meta.photos {
            let short = min(p.w, p.h)
            let long = max(p.w, p.h)
            let want = Int((Double(target) * Double(long) / Double(short)).rounded(.down))
            let got = CLIPPreprocess.outputSize(width: p.w, height: p.h, size: target)
            XCTAssertEqual(max(got.width, got.height), want, "photo \(p.i) is \(p.w)x\(p.h)")
            XCTAssertEqual(min(got.width, got.height), target)
        }
        // The case the comment in the port calls out: floor gives 335, round 336.
        XCTAssertEqual(CLIPPreprocess.outputSize(width: 1024, height: 683, size: 224).width, 335)
    }

    /// The resize target and the crop size must stay DIFFERENT.
    ///
    /// They were one constant, which made the centre crop a no-op and fed the
    /// model a ~11% wider field of view than it was trained on. Measured cost
    /// on the validation half, shipped scoring path: int8 93.78 against 94.27,
    /// fp32 93.76 against 94.82, McNemar p = 0.0005. Nothing threw, and every
    /// other test in this file still passed, so pin the constants.
    func testResizeAndCropTargetsDiffer() throws {
        XCTAssertEqual(CLIPPreprocess.resize, 248)
        XCTAssertEqual(CLIPPreprocess.crop, 224)
        XCTAssertNotEqual(CLIPPreprocess.resize, CLIPPreprocess.crop)

        // And the crop must actually discard something.
        let n = 300
        let img = CLIPPreprocess.RGB(
            data: [UInt8](repeating: 128, count: n * n * 3), width: n, height: n)
        let r = CLIPPreprocess.resizeShorterSide(img, size: CLIPPreprocess.resize)
        XCTAssertEqual(r.width, 248)
        XCTAssertEqual(r.height, 248)
        let c = CLIPPreprocess.centerCrop(r.data, width: r.width, height: r.height,
                                          size: CLIPPreprocess.crop)
        XCTAssertLessThan(c.count, r.data.count)
        XCTAssertEqual(c.count, CLIPPreprocess.crop * CLIPPreprocess.crop * 3)
    }

    /// The fixtures must match the transform the port claims to implement.
    /// A stale ml/parity generated at 224 would otherwise fail the tensor
    /// comparisons below with no hint as to why.
    func testFixturesWereGeneratedForThisTransform() throws {
        let url = Self.parityDir.appendingPathComponent("meta.json")
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw XCTSkip("Missing \(url.path).")
        }
        let obj = try JSONSerialization.jsonObject(with: Data(contentsOf: url))
        guard let d = obj as? [String: Any],
              let resize = d["resize"] as? Int, let crop = d["crop"] as? Int else {
            XCTFail("ml/parity/meta.json has no resize/crop: regenerate it with "
                    + "ml/distill/jobs/dump_preproc_ref.py")
            return
        }
        XCTAssertEqual(resize, CLIPPreprocess.resize, "stale fixtures, regenerate ml/parity")
        XCTAssertEqual(crop, CLIPPreprocess.crop, "stale fixtures, regenerate ml/parity")
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
