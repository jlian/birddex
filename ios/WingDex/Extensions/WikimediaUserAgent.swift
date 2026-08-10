import Foundation

/// Wikimedia's User-Agent policy wants a client name and a contact route, and
/// blocks non-descriptive agents. The default URLSession agent is neither, so
/// every Wikimedia request sets this one.
enum WikimediaUserAgent {
    static let value = "WingDex/1.0 (https://wingdex.app)"
}
