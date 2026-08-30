import Foundation
import os

private let log = Logger(subsystem: Config.bundleID, category: "CommonsGallery")

/// One reference photo plus the file page its license notice lives on.
struct GalleryItem: Sendable, Hashable {
    let url: URL
    let plumage: String?
    let descriptionUrl: URL?
}

/// Reference photos for a species, from a single Wikimedia Commons search.
///
/// Shared rather than private to the confirm screen because the peek sheet asks
/// for a species the confirm screen has not selected, so both need the same
/// search, the same exclusion rules and the same cache.
enum CommonsGallery {
    private static let excludeRE = try! NSRegularExpression(
        pattern: "\\.(svg|gif)$|Status_|IUCN|range_map|distribution|map_of|map\\.png|stamp_of|MHNT|MWNH|_egg|_nest|museum|specimen|skeleton|taxiderm|wikimedia-logo|commons-logo|wikidata-logo|cscr-|question_book|edit-clear|crystal_clear|ambox|folder_hexagonal",
        options: .caseInsensitive
    )
    private static let captionExcludeRE = try! NSRegularExpression(
        // Spanish terms too: Commons captions the nest and chick shots that outrank the bird
        // itself for several New World species.
        pattern: "\\beggs?\\b|\\bnests?\\b|\\bskeleton\\b|\\bspecimen\\b|\\btaxiderm|\\bnido\\b|\\bnidada\\b|\\bpolluelos?\\b|\\bhuevos?\\b",
        options: .caseInsensitive
    )

    /// Fetch reference photos for `displayName`, ordered so images tagged with the
    /// identified `plumage` come first and `leadImageUrl` comes first of all.
    ///
    /// Returns the lead image alone when the search fails, so a caller always has
    /// something to render.
    static func fetch(
        displayName: String,
        leadImageUrl: String?,
        plumage: String? = nil
    ) async -> [GalleryItem] {
        let raw: [GalleryItem]
        if let cached = await Cache.shared.value(for: displayName) {
            raw = cached
        } else if let found = await search(displayName: displayName) {
            raw = found
            await Cache.shared.store(found, for: displayName)
        } else {
            // Cancelled. The peek sheet cancels this task on every swipe, so caching
            // the empty result here would pin the species to its lead image for the
            // rest of the session.
            raw = []
        }
        // Lead promotion runs last so the taxonomy lead image cannot be displaced
        // by a plumage match.
        return promotingLead(leadImageUrl, in: sortedByPlumage(raw, matching: plumage))
    }

    /// Reorder so images tagged with a plumage the identification detected come first.
    private static func sortedByPlumage(_ items: [GalleryItem], matching plumage: String?) -> [GalleryItem] {
        guard let detected = plumage?.lowercased(), !detected.isEmpty else { return items }
        let detectedTags = Set(detected.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) })
        let matches: (GalleryItem) -> Bool = { item in
            guard let p = item.plumage?.lowercased() else { return false }
            let tags = p.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            return !detectedTags.isDisjoint(with: tags)
        }
        return items.filter(matches) + items.filter { !matches($0) }
    }

    // MARK: - Cache

    /// Raw search results keyed by display name. The peek sheet pages back and
    /// forth across the same few species, and a refetch per swipe would blank the
    /// image every time.
    private actor Cache {
        static let shared = Cache()
        private var entries: [String: [GalleryItem]] = [:]
        private var order: [String] = []

        func value(for key: String) -> [GalleryItem]? { entries[key] }

        func store(_ items: [GalleryItem], for key: String) {
            if entries[key] == nil { order.append(key) }
            entries[key] = items
            while order.count > 32 {
                entries.removeValue(forKey: order.removeFirst())
            }
        }
    }

    // MARK: - Search

    private struct CommonsResponse: Codable {
        let query: Query?
        struct Query: Codable { let pages: [String: Page]? }
        struct Page: Codable {
            let title: String?
            let index: Int?
            let imageinfo: [ImageInfo]?
        }
        struct ImageInfo: Codable {
            let thumburl: String?
            let descriptionurl: String?
            let mime: String?
            let extmetadata: ExtMetadata?
        }
        struct ExtMetadata: Codable {
            let ImageDescription: MetaValue?
            let Assessments: MetaValue?
        }
        struct MetaValue: Codable { let value: String? }
    }

    /// `nil` means the task was cancelled and the caller must not cache the result.
    /// An empty array is a real answer: the search ran and matched nothing usable.
    private static func search(displayName: String) async -> [GalleryItem]? {
        do {
            let query = "\"\(displayName)\"".addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? displayName
            let urlStr = "https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=\(query)&gsrnamespace=6&gsrlimit=12&prop=imageinfo&iiprop=extmetadata%7Curl%7Cmime&iiurlwidth=500&format=json&origin=*"
            guard let url = URL(string: urlStr) else {
                log.debug("Commons gallery: invalid URL: \(urlStr)")
                return []
            }
            var req = URLRequest(url: url)
            req.setValue(WikimediaUserAgent.value, forHTTPHeaderField: "User-Agent")
            let (data, _) = try await URLSession.shared.data(for: req)
            try Task.checkCancellation()

            let response = try JSONDecoder().decode(CommonsResponse.self, from: data)
            try Task.checkCancellation()
            let pageCount = response.query?.pages?.count ?? 0
            log.debug("Commons gallery: \(pageCount) pages for '\(displayName)'")

            // Score: featured > quality > relevance
            var scored: [(page: CommonsResponse.Page, score: Int, relevance: Int)] = []
            if let pages = response.query?.pages?.values {
                for page in pages {
                    let assessed = page.imageinfo?.first?.extmetadata?.Assessments?.value ?? ""
                    let s = assessed.contains("featured") ? 0 : assessed.contains("quality") ? 1 : 2
                    scored.append((page: page, score: s, relevance: page.index ?? 999))
                }
            }
            scored.sort { $0.score != $1.score ? $0.score < $1.score : $0.relevance < $1.relevance }

            var items: [GalleryItem] = []
            for entry in scored {
                let title = entry.page.title ?? ""
                let titleRange = NSRange(title.startIndex..., in: title)
                if excludeRE.firstMatch(in: title, range: titleRange) != nil { continue }
                let info = entry.page.imageinfo?.first
                // Commons bird photos are JPEG; the PNG and SVG hits are icons and diagrams.
                guard info?.mime == "image/jpeg" else { continue }
                guard let thumbStr = info?.thumburl,
                      let thumbURL = URL(string: thumbStr) else { continue }
                let rawDesc = info?.extmetadata?.ImageDescription?.value ?? ""
                let desc = rawDesc.replacingOccurrences(of: "<[^>]*>", with: "", options: String.CompareOptions.regularExpression)
                let subject = "\(desc) \(title)"
                    .replacingOccurrences(of: "[_-]", with: " ", options: String.CompareOptions.regularExpression)
                let subjectRange = NSRange(subject.startIndex..., in: subject)
                if captionExcludeRE.firstMatch(in: subject, range: subjectRange) != nil { continue }
                items.append(GalleryItem(
                    url: thumbURL,
                    plumage: parsePlumage([desc, title].joined(separator: " ")),
                    descriptionUrl: info?.descriptionurl.flatMap(URL.init(string:))
                ))
                if items.count >= 6 { break }
            }
            try Task.checkCancellation()
            log.debug("Commons gallery: \(items.count) URLs after filtering")
            return items
        } catch is CancellationError {
            return nil
        } catch let error as URLError where error.code == .cancelled {
            // URLSession reports cancellation as URLError rather than CancellationError,
            // and this is the throw that actually fires when a swipe cancels the task.
            return nil
        } catch {
            log.debug("Commons gallery fetch failed")
            return []
        }
    }

    /// Parse plumage from caption + filename text (matches web logic).
    private static func parsePlumage(_ text: String) -> String? {
        let lower = text.lowercased().replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ")
        var tags: [String] = []
        if lower.contains("drake") { tags.append("male") }
        else if lower.contains("male") && !lower.contains("female") { tags.append("male") }
        if lower.contains("female") || lower.contains("hen") { tags.append("female") }
        if lower.range(of: "\\bjuvenile\\b|\\bchick\\b|\\bduckling\\b|\\bimmature\\b", options: .regularExpression) != nil {
            tags.append("juvenile")
        }
        return tags.isEmpty ? nil : tags.joined(separator: ", ")
    }

    // MARK: - Lead promotion

    /// Commons file name from an upload URL or a file page URL, normalised for comparison.
    private static func commonsFileKey(_ urlString: String?) -> String? {
        guard let urlString, let decoded = urlString.removingPercentEncoding else { return nil }
        let name: String?
        if let marker = decoded.range(of: "/wiki/File:") {
            name = String(decoded[marker.upperBound...])
        } else if decoded.contains("/thumb/") {
            name = decoded.split(separator: "/").dropLast().last.map(String.init)
        } else {
            name = decoded.split(separator: "/").last.map(String.init)
        }
        return name?.replacingOccurrences(of: "_", with: " ").lowercased()
    }

    /// Put the lead image first, absorbing the Commons copy of the same file when the search
    /// already returned it.
    private static func promotingLead(_ leadImageUrl: String?, in items: [GalleryItem]) -> [GalleryItem] {
        guard let leadImageUrl,
              let leadURL = URL(string: leadImageUrl),
              let leadKey = commonsFileKey(leadImageUrl)
        else { return items }
        let duplicate = items.first { commonsFileKey($0.descriptionUrl?.absoluteString) == leadKey }
        let rest = items.filter { commonsFileKey($0.descriptionUrl?.absoluteString) != leadKey }
        let lead = GalleryItem(
            url: leadURL,
            plumage: duplicate?.plumage,
            descriptionUrl: duplicate?.descriptionUrl
                ?? wikimediaFilePageUrl(fromImage: leadImageUrl).flatMap(URL.init(string:))
        )
        return [lead] + rest
    }
}
