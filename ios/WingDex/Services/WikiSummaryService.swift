import Foundation

/// Reference type because `NSCache` only stores class instances.
final class WikiSummary: Sendable {
    let extract: String?
    let imageUrl: String?

    init(extract: String?, imageUrl: String?) {
        self.extract = extract
        self.imageUrl = imageUrl
    }
}

/// Wikipedia summaries, cached in memory and keyed by article title.
///
/// Cached because the views that show an extract are short-lived and repeat: a
/// context-menu preview and the view it pops into are separate instances with
/// separate state, and the peek sheet pages back and forth across the same few
/// species. Without this each one refetches and replays its blur-up.
@MainActor
enum WikiSummaryService {
    private static let cache: NSCache<NSString, WikiSummary> = {
        let cache = NSCache<NSString, WikiSummary>()
        cache.countLimit = 128
        return cache
    }()

    static func cached(for title: String) -> WikiSummary? {
        cache.object(forKey: title as NSString)
    }

    /// Fetch and cache the summary, or return the cached one. Failures are not
    /// cached, so a later visit retries.
    @discardableResult
    static func summary(for title: String) async -> WikiSummary? {
        if let cached = cached(for: title) { return cached }
        let encoded = title.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? title
        guard let url = URL(string: "https://en.wikipedia.org/api/rest_v1/page/summary/\(encoded)") else {
            return nil
        }
        var request = URLRequest(url: url)
        request.setValue(WikimediaUserAgent.value, forHTTPHeaderField: "User-Agent")
        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let summary = await parse(data)
        else { return nil }
        cache.setObject(summary, forKey: title as NSString)
        return summary
    }

    /// Off the main actor: extracts run to several KB, and this parse lands on the detail
    /// push path where a hitch is visible.
    private nonisolated static func parse(_ data: Data) async -> WikiSummary? {
        await Task.detached(priority: .utility) {
            guard let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                return nil
            }
            let original = json["originalimage"] as? [String: Any]
            return WikiSummary(
                extract: json["extract"] as? String,
                imageUrl: original?["source"] as? String
            )
        }.value
    }
}
