import Foundation
import Observation

/// Helpers for formatting offset-aware ISO 8601 date strings stored by the API.
///
/// Stored dates look like "2024-01-15T17:00:00-10:00". The offset encodes the
/// original local timezone, so we display the local datetime components directly
/// (formatted via UTC to avoid the device timezone shifting them).
enum DateFormatting {
    private static let internetDateFormat = Date.ISO8601FormatStyle()
    private static let fractionalDateFormat = Date.ISO8601FormatStyle(includingFractionalSeconds: true)


    // MARK: - Date Only

    /// Format a stored date string for display (e.g. "Jan 15, 2024").
    static func formatDate(_ timeStr: String, style: DateFormatter.Style = .medium) -> String {
        guard let comps = parseLocalComponents(timeStr) else {
            return timeStr // un-parseable, return raw
        }
        let utcDate = comps.asUTCDate
        let fmt = DateFormatter()
        fmt.dateStyle = style
        fmt.timeStyle = .none
        fmt.timeZone = TimeZone(identifier: "UTC")
        return fmt.string(from: utcDate)
    }

    /// Short relative-style date: "Today", "Yesterday", or "Jan 15".
    static func relativeDate(_ timeStr: String) -> String {
        guard let comps = parseLocalComponents(timeStr) else { return timeStr }
        let utcDate = comps.asUTCDate

        let now = Date.now
        let calendar = Calendar.current
        let todayStart = calendar.startOfDay(for: now)
        let eventDay = calendar.startOfDay(for: utcDate)

        // Compare using the UTC date components (the "local" day in the original timezone)
        let dayDiff = calendar.dateComponents([.day], from: eventDay, to: todayStart).day ?? 0

        if dayDiff == 0 { return "Today" }
        if dayDiff == 1 { return "Yesterday" }

        let fmt = DateFormatter()
        fmt.dateFormat = "MMM d"
        fmt.timeZone = TimeZone(identifier: "UTC")
        return fmt.string(from: utcDate)
    }

    // MARK: - Time

    /// Format a stored time for display (e.g. "5:00 PM").
    static func formatTime(_ timeStr: String) -> String {
        guard let comps = parseLocalComponents(timeStr) else { return "" }
        let utcDate = comps.asUTCDate
        let fmt = DateFormatter()
        fmt.dateStyle = .none
        fmt.timeStyle = .short
        fmt.timeZone = TimeZone(identifier: "UTC")
        return fmt.string(from: utcDate)
    }

    // MARK: - Duration

    /// Compute a human-readable duration between two stored date strings.
    static func duration(from startStr: String, to endStr: String) -> String? {
        guard let start = parseLocalComponents(startStr),
              let end = parseLocalComponents(endStr)
        else { return nil }

        let startDate = start.asUTCDate
        let endDate = end.asUTCDate
        let seconds = endDate.timeIntervalSince(startDate)
        guard seconds > 0 else { return nil }

        let hours = Int(seconds) / 3600
        let minutes = (Int(seconds) % 3600) / 60

        if hours > 0 {
            return "\(hours)h \(minutes)m"
        }
        return "\(minutes)m"
    }

    // MARK: - Sorting

    /// Parse a stored date string into a Date for sorting purposes.
    /// Falls back to .distantPast if unparseable.
    static func sortDate(_ timeStr: String) -> Date {
        if let date = try? Date(timeStr, strategy: internetDateFormat) { return date }
        if let date = try? Date(timeStr, strategy: fractionalDateFormat) { return date }

        return .distantPast
    }

    // MARK: - Internals

    /// The 1-12 month in the date's OWN timezone, which is the month the rarity
    /// asset is keyed by. Reading it in the device timezone would move an
    /// evening outing near a month boundary into the wrong month.
    static func localMonth(_ timeStr: String) -> Int? {
        guard let comps = parseLocalComponents(timeStr), (1...12).contains(comps.month) else {
            return nil
        }
        return comps.month
    }

    private struct LocalComponents {
        let year: Int, month: Int, day: Int
        let hour: Int, minute: Int, second: Int

        /// Create a Date using UTC so that formatting with UTC timezone
        /// reproduces the original local wall-clock time.
        var asUTCDate: Date {
            var comps = DateComponents()
            comps.year = year
            comps.month = month
            comps.day = day
            comps.hour = hour
            comps.minute = minute
            comps.second = second
            comps.timeZone = TimeZone(identifier: "UTC")
            return Calendar.current.date(from: comps) ?? .distantPast
        }
    }

    /// Extract the local datetime components from an offset-aware ISO string.
    /// "2024-01-15T17:00:00-10:00" -> year=2024, month=1, day=15, hour=17, min=0, sec=0
    private static func parseLocalComponents(_ timeStr: String) -> LocalComponents? {
        // Strip timezone offset to get local datetime
        let localPart: String
        if let plusRange = timeStr.range(of: #"[+-]\d{2}:\d{2}$"#, options: .regularExpression) {
            localPart = String(timeStr[..<plusRange.lowerBound])
        } else if timeStr.hasSuffix("Z") {
            localPart = String(timeStr.dropLast())
        } else {
            localPart = timeStr
        }

        // Parse "2024-01-15T17:00:00" or "2024-01-15 17:00:00"
        let normalized = localPart.replacingOccurrences(of: "T", with: " ")
        let parts = normalized.split(separator: " ")
        guard parts.count >= 1 else { return nil }

        let dateParts = parts[0].split(separator: "-").compactMap { Int($0) }
        guard dateParts.count == 3 else { return nil }

        var hour = 0, minute = 0, second = 0
        if parts.count >= 2 {
            let timeParts = parts[1].split(separator: ":").compactMap { Int($0) }
            if timeParts.count >= 1 { hour = timeParts[0] }
            if timeParts.count >= 2 { minute = timeParts[1] }
            if timeParts.count >= 3 { second = timeParts[2] }
        }

        return LocalComponents(
            year: dateParts[0], month: dateParts[1], day: dateParts[2],
            hour: hour, minute: minute, second: second
        )
    }
}

// MARK: - Display Name Helpers

/// Extract the common name from "Common Name (Scientific Name)" format.
/// e.g. "Northern Cardinal (Cardinalis cardinalis)" -> "Northern Cardinal"
func getDisplayName(_ speciesName: String) -> String {
    guard let parenRange = speciesName.range(of: " (") else { return speciesName }
    return String(speciesName[..<parenRange.lowerBound])
}

/// Extract the scientific name from "Common Name (Scientific Name)" format.
/// e.g. "Northern Cardinal (Cardinalis cardinalis)" -> "Cardinalis cardinalis"
func getScientificName(_ speciesName: String) -> String? {
    guard let openParen = speciesName.range(of: "("),
          let closeParen = speciesName.range(of: ")", range: openParen.upperBound..<speciesName.endIndex)
    else { return nil }
    return String(speciesName[openParen.upperBound..<closeParen.lowerBound])
}

private struct TaxonomyLookups: Sendable {
    var ebird: [String: String] = [:]
    var birdlife: [String: String] = [:]
    var wikiThumb: [String: String] = [:]
    var order: [String: Int] = [:]
}

@MainActor
@Observable
private final class TaxonomyLookupStore {
    static let shared = TaxonomyLookupStore()

    private(set) var lookups = TaxonomyLookups()
    @ObservationIgnored private var loadTask: Task<TaxonomyLookups, Never>?
    @ObservationIgnored private var publicationTask: Task<Void, Never>?

    func loadIfNeeded() {
        guard lookups.order.isEmpty, publicationTask == nil else { return }
        publicationTask = Task { [weak self] in
            guard let self else { return }
            await self.load()
            self.publicationTask = nil
        }
    }

    #if DEBUG
    func primeSynchronously() {
        guard lookups.order.isEmpty else { return }
        lookups = Self.loadFromBundle()
    }
    #endif

    func load() async {
        if !lookups.order.isEmpty { return }
        if let loadTask {
            lookups = await loadTask.value
            return
        }

        let task = Task.detached(priority: .utility) { Self.loadFromBundle() }
        loadTask = task
        lookups = await task.value
        loadTask = nil
    }

    nonisolated private static func loadFromBundle() -> TaxonomyLookups {
        guard let url = Bundle.main.url(forResource: "taxonomy", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let rawEntries = try? JSONSerialization.jsonObject(with: data) as? [[Any]]
        else { return TaxonomyLookups() }

        var lookups = TaxonomyLookups()
        lookups.ebird.reserveCapacity(rawEntries.count)
        lookups.birdlife.reserveCapacity(rawEntries.count)
        lookups.wikiThumb.reserveCapacity(rawEntries.count)
        lookups.order.reserveCapacity(rawEntries.count)

        for (index, entry) in rawEntries.enumerated() {
            guard let commonName = entry.first as? String else { continue }
            let key = commonName.lowercased()
            lookups.order[key] = index

            if entry.count > 2, let code = entry[2] as? String, !code.isEmpty {
                lookups.ebird[key] = code
            }
            // taxonomy.json stores thumb paths relative to the Commons upload prefix.
            if entry.count > 4, let thumbPath = entry[4] as? String, !thumbPath.isEmpty {
                lookups.wikiThumb[key] = "https://upload.wikimedia.org/wikipedia/commons/" + thumbPath
            }
            if entry.count > 5, let id = entry[5] as? String, !id.isEmpty {
                lookups.birdlife[key] = id
            }
        }
        return lookups
    }
}

@MainActor
func prewarmTaxonomyLookups() async {
    await TaxonomyLookupStore.shared.load()
}

#if DEBUG
/// Prime the taxonomy synchronously, for SwiftUI previews only.
///
/// A preview snapshot is taken from the first frame, before any `.task` has
/// resolved, so anything reading a taxonomy-derived value renders empty. The
/// app never takes this path: parsing 11,167 rows of JSON belongs off the main
/// thread, which is why `load()` is async.
@MainActor
func primeTaxonomyLookupsForPreview() {
    TaxonomyLookupStore.shared.primeSynchronously()
}
#endif

/// Return the bundled eBird taxonomy index for sorting, or Int.max when unknown.
@MainActor
func getTaxonomicOrder(_ speciesName: String) -> Int {
    let commonName = getDisplayName(speciesName).trimmingCharacters(in: .whitespacesAndNewlines)
    let store = TaxonomyLookupStore.shared
    store.loadIfNeeded()
    return store.lookups.order[commonName.lowercased()] ?? Int.max
}

/// Compare stored species names by taxonomic sequence, keeping unknown species last.
@MainActor
func taxonomicSpeciesPrecedes(_ lhs: String, _ rhs: String, ascending: Bool) -> Bool {
    let lhsOrder = getTaxonomicOrder(lhs)
    let rhsOrder = getTaxonomicOrder(rhs)
    let lhsKnown = lhsOrder != Int.max
    let rhsKnown = rhsOrder != Int.max

    if lhsKnown != rhsKnown { return lhsKnown }
    if lhsOrder != rhsOrder { return ascending ? lhsOrder < rhsOrder : lhsOrder > rhsOrder }
    return lhs.localizedCaseInsensitiveCompare(rhs) == .orderedAscending
}

/// Build the eBird species URL for a stored species name.
@MainActor
func getEbirdURL(for speciesName: String) -> URL? {
    let commonName = getDisplayName(speciesName).trimmingCharacters(in: .whitespacesAndNewlines)
    let store = TaxonomyLookupStore.shared
    store.loadIfNeeded()
    guard let ebirdCode = store.lookups.ebird[commonName.lowercased()] else { return nil }
    return URL(string: "https://ebird.org/species/\(ebirdCode)")
}

/// Build a Wikipedia URL from the taxonomy-provided article title.
func getWikipediaURL(for wikiTitle: String?) -> URL? {
    guard let wikiTitle, !wikiTitle.isEmpty else { return nil }
    let encoded = wikiTitle.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? wikiTitle
    return URL(string: "https://en.wikipedia.org/wiki/\(encoded)")
}

/// The Wikipedia lead image for a stored species name, as bundled in taxonomy.json.
@MainActor
func getWikiThumbnailUrl(for speciesName: String) -> String? {
    let commonName = getDisplayName(speciesName).trimmingCharacters(in: .whitespacesAndNewlines)
    let store = TaxonomyLookupStore.shared
    store.loadIfNeeded()
    return store.lookups.wikiThumb[commonName.lowercased()]
}

/// Build the BirdLife DataZone factsheet URL for a stored species name.
@MainActor
func getBirdlifeFactsheetURL(for speciesName: String) -> URL? {
    let commonName = getDisplayName(speciesName).trimmingCharacters(in: .whitespacesAndNewlines)
    let store = TaxonomyLookupStore.shared
    store.loadIfNeeded()
    guard let id = store.lookups.birdlife[commonName.lowercased()] else { return nil }
    return URL(string: "https://datazone.birdlife.org/species/factsheet/\(id)")
}
