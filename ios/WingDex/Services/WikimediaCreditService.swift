import Foundation

/// Creator and license for one Wikimedia Commons file, plus the file page that
/// carries the full notice.
struct WikimediaImageCredit: Sendable, Equatable {
    let artist: String?
    let license: String?
    let pageUrl: String

    /// "Photo Polinova / CC BY-SA 4.0". Names the source when the file page lists
    /// neither, so the line never renders as a bare "Photo".
    var label: String {
        let parts = [artist, license].compactMap { $0 }
        return parts.isEmpty ? "Wikimedia Commons" : "\(parts.joined(separator: " / "))"
    }
}

/// The creator and license for a Commons file.
///
/// Cached by file page URL: the peek sheet asks for the same handful of photos as
/// the user pages back and forth, and the species detail view asks again on every
/// push.
@MainActor
enum WikimediaCreditService {
    private static var cache: [String: WikimediaImageCredit] = [:]

    /// `imageUrl` is an upload URL; the file page is derived from it, so this stays
    /// one request and no extra data in taxonomy.json.
    static func credit(forImage imageUrl: String?) async -> WikimediaImageCredit? {
        guard let pageUrl = wikimediaFilePageUrl(fromImage: imageUrl) else { return nil }
        return await credit(forFilePage: pageUrl)
    }

    static func credit(forFilePage pageUrl: String) async -> WikimediaImageCredit? {
        if let cached = cache[pageUrl] { return cached }
        guard let separator = pageUrl.range(of: "/wiki/") else { return nil }

        // The title came out of a URL path, so it is already percent-encoded. Decode
        // it first, then let URLComponents re-encode it as a query value: a filename
        // containing `&` (File:A_&_B.jpg) truncates the titles parameter otherwise,
        // and encoding the raw path form turns %28 into %2528 and the API rejects it.
        let encodedTitle = String(pageUrl[separator.upperBound...])
        let title = encodedTitle.removingPercentEncoding ?? encodedTitle
        guard var components = URLComponents(string: "\(pageUrl[..<separator.lowerBound])/w/api.php")
        else { return nil }
        components.queryItems = [
            URLQueryItem(name: "action", value: "query"),
            URLQueryItem(name: "titles", value: title),
            URLQueryItem(name: "prop", value: "imageinfo"),
            URLQueryItem(name: "iiprop", value: "extmetadata"),
            URLQueryItem(name: "format", value: "json"),
        ]
        guard let apiUrl = components.url else { return nil }

        var request = URLRequest(url: apiUrl)
        request.setValue(WikimediaUserAgent.value, forHTTPHeaderField: "User-Agent")
        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let pages = (json["query"] as? [String: Any])?["pages"] as? [String: Any],
              let page = pages.values.first as? [String: Any],
              let info = (page["imageinfo"] as? [[String: Any]])?.first,
              let meta = info["extmetadata"] as? [String: Any]
        else { return nil }

        let read: (String) -> String? = { key in
            guard let value = (meta[key] as? [String: Any])?["value"] as? String else { return nil }
            let text = value
                .replacingOccurrences(of: "<[^>]*>", with: "", options: .regularExpression)
                .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : text
        }
        let credit = WikimediaImageCredit(
            artist: read("Artist"),
            license: read("LicenseShortName"),
            pageUrl: pageUrl
        )
        cache[pageUrl] = credit
        return credit
    }
}
