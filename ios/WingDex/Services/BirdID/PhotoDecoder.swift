import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Decode a photo at reduced scale for identification.
///
/// The iOS counterpart of the `createImageBitmap` resize path in
/// bird-id-local-adapter.ts. A JPEG is DCT coefficients, not pixels, so it
/// cannot be resized before it is decoded, but it CAN be decoded at reduced
/// scale: ImageIO discards high-frequency coefficients per 8x8 block and never
/// allocates the full-size bitmap. `kCGImageSourceThumbnailMaxPixelSize` caps
/// the LONGER side, which is the same axis the web cap applies to.
///
/// No JPEG header walk is needed here. The web path reads SOF markers because
/// `createImageBitmap` wants explicit target dimensions, so measuring would
/// mean decoding twice. ImageIO takes a single max and derives the rest, so the
/// dimensions never have to be known up front.
///
/// PARITY NOTE. ImageIO's downsampler is not the browser's `resizeQuality:
/// "high"`, so the tensor differs between platforms even at the same cap. The
/// web change measured that class of perturbation as costing nothing
/// (95.09 against 95.00 absolute top-1 on the 3,322-photo split), but that is
/// evidence for the approach, not a measurement of this decoder. See the note
/// in CLIPPreprocessParityTests.
enum PhotoDecoder {
    /// Longest side we ask the decoder for, matching DECODE_CAP on the web.
    /// The model sees 224x224 after a resize to 224 on the SHORTER side, so
    /// anything above ~500 is detail the tensor throws away.
    static let decodeCap = 500

    /// Returns RGBA bytes, which `CLIPPreprocess` reads directly with
    /// `channels: 4` rather than repacking to RGB first.
    static func decode(_ data: Data, cap: Int = decodeCap) -> CLIPPreprocess.RGB? {
        let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else {
            return nil
        }
        let options: [CFString: Any] = [
            // From the full image, never an embedded EXIF thumbnail, which can
            // be a different crop or a stale render of the photo.
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: max(cap, 1),
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return nil
        }
        return rgba(from: image)
    }

    private static func rgba(from image: CGImage) -> CLIPPreprocess.RGB? {
        let w = image.width
        let h = image.height
        guard w > 0, h > 0 else { return nil }

        var buffer = [UInt8](repeating: 0, count: w * h * 4)
        let ok = buffer.withUnsafeMutableBytes { raw -> Bool in
            guard let ctx = CGContext(
                data: raw.baseAddress,
                width: w,
                height: h,
                bitsPerComponent: 8,
                bytesPerRow: w * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                // The context has no alpha channel, so a source with alpha is
                // composited over black. The web reads getImageData, which is
                // unpremultiplied, and then ignores the alpha byte. The two
                // therefore differ for alpha-bearing PNG and HEIC; camera and
                // library photos are JPEG or opaque HEIC and are unaffected.
                // CGBitmapContext cannot emit unpremultiplied RGBA, so matching
                // the canvas exactly would mean reading the provider directly.
                //
                // byteOrder32Big pins the layout to R,G,B,X in memory. Without
                // it the order is the platform default, and a silent swap to
                // BGRX would feed CLIP inverted colours with nothing failing.
                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
                    | CGBitmapInfo.byteOrder32Big.rawValue
            ) else { return false }
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard ok else { return nil }
        return CLIPPreprocess.RGB(data: buffer, width: w, height: h, channels: 4)
    }
}
