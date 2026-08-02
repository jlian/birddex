import UIKit

/// Shared image cache for remote bird photos.
///
/// Three properties matter here and none of them come for free:
///
/// - **Coalescing.** A dex row, a context-menu preview hero, and the pushed detail hero can
///   ask for the same URL at nearly the same moment. One download serves all of them.
/// - **Load lifetime outlives the caller.** Work runs in unstructured tasks, so cancelling
///   the awaiting view does not cancel the download. Dismissing a preview mid-flight keeps
///   the bytes, which is what makes long-press act as a prefetch for the detail view.
/// - **Downsampling.** Wikipedia originals run to several thousand pixels. Decoding one at
///   full size for a 280pt hero costs tens of MB of RAM.
@MainActor
final class ImageLoader {
    static let shared = ImageLoader()

    private let images = NSCache<NSString, UIImage>()
    private var decodes: [String: Task<UIImage?, Never>] = [:]
    private var downloads: [String: Task<Data?, Never>] = [:]

    init(totalCostLimit: Int = 64 * 1024 * 1024) {
        images.totalCostLimit = totalCostLimit
    }

    /// Synchronous cache probe, for seeding `@State` in an initializer so a warm image
    /// renders on frame one instead of after `.task` runs.
    func cached(_ url: String?, targetPoints: CGFloat) -> UIImage? {
        guard let url, !url.isEmpty else { return nil }
        return images.object(forKey: Self.cacheKey(url, targetPoints) as NSString)
    }

    func image(for url: String?, targetPoints: CGFloat) async -> UIImage? {
        guard let url, !url.isEmpty else { return nil }
        let key = Self.cacheKey(url, targetPoints)
        if let hit = images.object(forKey: key as NSString) { return hit }
        if let inFlight = decodes[key] { return await inFlight.value }

        let maxPixelSize = targetPoints * Self.displayScale
        let task = Task { [weak self] () -> UIImage? in
            guard let self, let data = await self.data(for: url) else { return nil }
            guard let image = await Self.downsample(data, maxPixelSize: maxPixelSize) else { return nil }
            self.images.setObject(image, forKey: key as NSString, cost: image.decodedByteCost)
            return image
        }
        decodes[key] = task
        let image = await task.value
        decodes[key] = nil
        return image
    }

    /// Coalesced at the URL level rather than the cache-key level so the same file
    /// requested at two different target sizes is still only downloaded once.
    private func data(for url: String) async -> Data? {
        if let inFlight = downloads[url] { return await inFlight.value }
        guard let remote = URL(string: url) else { return nil }

        let task = Task { () -> Data? in
            try? await URLSession.shared.data(from: remote).0
        }
        downloads[url] = task
        let data = await task.value
        downloads[url] = nil
        return data
    }

    private static func downsample(_ data: Data, maxPixelSize: CGFloat) async -> UIImage? {
        await Task.detached(priority: .utility) {
            let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
            guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions) else {
                return nil
            }
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true,
                kCGImageSourceThumbnailMaxPixelSize: max(maxPixelSize, 1),
            ]
            guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
                return nil
            }
            return UIImage(cgImage: cgImage)
        }.value
    }

    private static func cacheKey(_ url: String, _ targetPoints: CGFloat) -> String {
        "\(url)|\(Int(targetPoints.rounded()))"
    }

    private static var displayScale: CGFloat {
        let scale = UITraitCollection.current.displayScale
        return scale > 0 ? scale : 3
    }
}

private extension UIImage {
    var decodedByteCost: Int {
        guard let cgImage else { return 1 }
        return cgImage.bytesPerRow * cgImage.height
    }
}
