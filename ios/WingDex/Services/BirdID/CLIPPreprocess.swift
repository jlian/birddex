import Foundation

/// CLIP preprocessing that matches the SHIPPED CHECKPOINT'S timm transform,
/// resampled exactly as PIL does it.
///
/// Port of src/lib/clip-preprocess.ts. Resize the SHORTER side to 248 with PIL
/// bicubic, center crop to 224, then normalize.
///
/// DO NOT "correct" the 248 back to 224. Generic open_clip really is
/// 224 -> 224, so 224 looks right if you read the open_clip docs. This
/// checkpoint is NOT generic open_clip: it is
/// timm:vit_medium_patch16_clip_224.tinyclip_yfcc15m, whose timm
/// pretrained_cfg is Resize(248, bicubic) -> CenterCrop(224), so the model
/// sees the centre ~90% of the frame. Resizing to 224 and then cropping 224
/// makes the crop a NO-OP and feeds a ~11% wider field of view than the model
/// was trained on. Measured on the validation half with the shipped scoring
/// path: int8 93.78% at 224 against 94.27% at 248, fp32 93.76% against 94.82%,
/// McNemar p = 0.0005. The offline calibration was always fitted in 248 space,
/// so this needs no refit.
///
/// The CoreML input stays [1, 3, 224, 224]. Only the RESIZE target moved.
///
/// The resampling is implemented here rather than delegated to Core Graphics
/// for the same reason the web port does not use canvas: vImage and CIImage
/// use their own kernels, and PIL STRETCHES the bicubic kernel when
/// downscaling so it averages over every source pixel. A fixed 4-tap kernel
/// going from 500px to 248px would alias. The tensor would drift with nothing
/// failing, so this is parity-tested against the PIL reference fixtures.
///
/// Three one-pixel traps are load-bearing and each is commented at its site:
/// resize FLOORS, center crop uses BANKER'S rounding, and the post-resample
/// quantisation is JS Math.round (floor(x + 0.5)), not round-half-away.
enum CLIPPreprocess {
    static let mean: [Double] = [0.48145466, 0.4578275, 0.40821073]
    static let std: [Double] = [0.26862954, 0.26130258, 0.27577711]
    /// Shorter-side resize target, from the checkpoint's timm pretrained_cfg.
    /// Deliberately NOT equal to `crop`; see the type docstring.
    static let resize = 248
    /// Center-crop size, and the model's tensor size. Fixed by the CoreML input.
    static let crop = 224
    // NOTE: the old single `size = 224` constant is GONE on purpose. It was
    // used for both the resize and the crop, which is exactly the bug. There
    // are no remaining references, so removing it makes a stale caller a
    // compile error instead of a silent no-op crop.

    struct RGB {
        let data: [UInt8]
        let width: Int
        let height: Int
        /// 3 for packed RGB, 4 to read an RGBA buffer without repacking it.
        let channels: Int

        init(data: [UInt8], width: Int, height: Int, channels: Int = 3) {
            self.data = data
            self.width = width
            self.height = height
            self.channels = channels
        }
    }

    /// PIL bicubic kernel, a = -0.5.
    private static func cubic(_ x: Double) -> Double {
        let a = -0.5
        let ax = abs(x)
        if ax < 1 { return ((a + 2) * ax - (a + 3)) * ax * ax + 1 }
        if ax < 2 { return ((ax - 5) * ax + 8) * ax * a - 4 * a }
        return 0
    }

    /// Per-output-pixel source window and normalized weights.
    private struct Taps {
        let lo: Int
        let weights: [Double]
    }

    private static func taps(srcLen: Int, dstLen: Int) -> [Taps] {
        let scale = Double(srcLen) / Double(dstLen)
        // Stretch the kernel when downscaling; keep it at 2.0 when upscaling.
        let filterScale = max(scale, 1)
        let support = 2 * filterScale

        return (0..<dstLen).map { d in
            let center = (Double(d) + 0.5) * scale
            var lo = Int((center - support + 0.5).rounded(.down))
            var hi = Int((center + support - 0.5).rounded(.up))
            if lo < 0 { lo = 0 }
            if hi > srcLen { hi = srcLen }
            let n = hi - lo
            guard n > 0 else { return Taps(lo: 0, weights: []) }

            var w = [Double](repeating: 0, count: n)
            var wsum = 0.0
            for k in 0..<n {
                let v = cubic((Double(lo + k) + 0.5 - center) / filterScale)
                w[k] = v
                wsum += v
            }
            if wsum != 0 { for k in 0..<n { w[k] /= wsum } }
            return Taps(lo: lo, weights: w)
        }
    }

    /// Horizontal pass reading the source bytes directly, so the full-resolution
    /// image is never copied into a Double buffer first.
    private static func resampleHorizontal(
        _ src: [UInt8], srcW: Int, srcH: Int, dstW: Int, srcCh: Int
    ) -> [Double] {
        let t = taps(srcLen: srcW, dstLen: dstW)
        var out = [Double](repeating: 0, count: dstW * srcH * 3)
        src.withUnsafeBufferPointer { s in
            out.withUnsafeMutableBufferPointer { o in
                for d in 0..<dstW {
                    let tap = t[d]
                    if tap.weights.isEmpty { continue }
                    for y in 0..<srcH {
                        let rowBase = y * srcW
                        for c in 0..<3 {
                            var acc = 0.0
                            for (k, w) in tap.weights.enumerated() {
                                acc += w * Double(s[(rowBase + tap.lo + k) * srcCh + c])
                            }
                            o[(y * dstW + d) * 3 + c] = acc
                        }
                    }
                }
            }
        }
        return out
    }

    private static func resampleVertical(
        _ src: [Double], srcW: Int, srcH: Int, dstH: Int
    ) -> [Double] {
        let t = taps(srcLen: srcH, dstLen: dstH)
        var out = [Double](repeating: 0, count: srcW * dstH * 3)
        src.withUnsafeBufferPointer { s in
            out.withUnsafeMutableBufferPointer { o in
                for d in 0..<dstH {
                    let tap = t[d]
                    if tap.weights.isEmpty { continue }
                    for x in 0..<srcW {
                        for c in 0..<3 {
                            var acc = 0.0
                            for (k, w) in tap.weights.enumerated() {
                                acc += w * s[((tap.lo + k) * srcW + x) * 3 + c]
                            }
                            o[(d * srcW + x) * 3 + c] = acc
                        }
                    }
                }
            }
        }
        return out
    }

    struct Resized {
        let data: [Double]
        let width: Int
        let height: Int
    }

    /// Output dimensions for a shorter-side resize.
    ///
    /// torchvision Resize uses FLOOR, not round. For 1024x683 at size 224 that
    /// is 1024*224/683 = 335.86 -> 335, where round gives 336. A one-pixel
    /// difference shifts every subsequent pixel and silently wrecks parity.
    static func outputSize(width w: Int, height h: Int, size: Int) -> (width: Int, height: Int) {
        if w <= h {
            return (size, Int((Double(size) * Double(h) / Double(w)).rounded(.down)))
        }
        return (Int((Double(size) * Double(w) / Double(h)).rounded(.down)), size)
    }

    /// Resize so the SHORTER side is `size`, preserving aspect ratio.
    static func resizeShorterSide(_ img: RGB, size: Int) -> Resized {
        let w = img.width, h = img.height
        let (nw, nh) = outputSize(width: w, height: h, size: size)
        let hpass = resampleHorizontal(img.data, srcW: w, srcH: h, dstW: nw,
                                       srcCh: img.channels)
        let vpass = resampleVertical(hpass, srcW: nw, srcH: h, dstH: nh)
        return Resized(data: vpass, width: nw, height: nh)
    }

    /// Python round(), which is round-half-to-EVEN, not half-up.
    /// Foundation's `rounded()` gives 53 for 52.5 but Python gives 52, and that
    /// one-pixel shift breaks parity on every odd crop margin while all
    /// dimensions still look correct.
    static func bankersRound(_ x: Double) -> Double {
        x.rounded(.toNearestOrEven)
    }

    /// Center crop to size x size.
    static func centerCrop(_ src: [Double], width w: Int, height h: Int, size: Int) -> [Double] {
        // Resize floors, CenterCrop ROUNDS. They genuinely differ, and mixing
        // them up shifts the window by one pixel on odd margins.
        let left = Int(bankersRound(Double(w - size) / 2.0))
        let top = Int(bankersRound(Double(h - size) / 2.0))
        var out = [Double](repeating: 0, count: size * size * 3)
        for y in 0..<size {
            let sy = top + y
            for x in 0..<size {
                let sx = left + x
                for c in 0..<3 {
                    out[(y * size + x) * 3 + c] = src[(sy * w + sx) * 3 + c]
                }
            }
        }
        return out
    }

    /// Full CLIP preprocess: resize, crop, scale to 0..1, normalize, to CHW.
    /// Returns 3 * crop * crop floats.
    ///
    /// `resize` and `crop` are SEPARATE parameters on purpose. They used to be
    /// one constant, which silently made the crop a no-op; see the type
    /// docstring.
    static func preprocess(
        _ img: RGB,
        resize: Int = CLIPPreprocess.resize,
        crop: Int = CLIPPreprocess.crop
    ) -> [Float] {
        let size = crop
        let r = resizeShorterSide(img, size: resize)
        let c = centerCrop(r.data, width: r.width, height: r.height, size: crop)
        var out = [Float](repeating: 0, count: 3 * size * size)
        let plane = size * size
        for ch in 0..<3 {
            let m = mean[ch]
            let s = std[ch]
            for p in 0..<plane {
                // PIL rounds to uint8 after resampling, before ToTensor. This
                // is JS Math.round, which is floor(x + 0.5) and differs from
                // Swift's round-half-away-from-zero on negative halves that
                // bicubic overshoot can produce.
                var v = (c[p * 3 + ch] + 0.5).rounded(.down)
                if v < 0 { v = 0 }
                if v > 255 { v = 255 }
                out[ch * plane + p] = Float((v / 255 - m) / s)
            }
        }
        return out
    }
}
