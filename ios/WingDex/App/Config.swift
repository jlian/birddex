import Foundation

/// App-wide configuration constants.
enum Config {
    /// Base URL for the WingDex API.
    ///
    /// Resolution order:
    /// 1. `API_BASE_URL` environment variable (optional launch-time override)
    /// 2. `APIBaseURL` embedded by the selected build configuration
    /// 3. Release builds fall back to production; Debug falls back to localhost
    static let apiBaseURL: URL = {
        #if DEBUG
        let isDebug = true
        #else
        let isDebug = false
        #endif
        return resolveAPIBaseURL(
            environment: ProcessInfo.processInfo.environment,
            infoDictionary: Bundle.main.infoDictionary,
            isDebug: isDebug
        )
    }()

    static func resolveAPIBaseURL(
        environment: [String: String],
        infoDictionary: [String: Any]?,
        isDebug: Bool
    ) -> URL {
        if let value = environment["API_BASE_URL"], let url = URL(string: value) {
            return url
        }
        if let value = infoDictionary?["APIBaseURL"] as? String,
           let url = URL(string: value) {
            return url
        }
        return URL(string: isDebug ? "https://localhost.wingdex.app" : "https://wingdex.app")!
    }

    /// Bundle identifier.
    static let bundleID = "app.wingdex"

    /// OAuth callback URL scheme (for ASWebAuthenticationSession).
    static let oauthCallbackScheme = "wingdex"

    /// WebAuthn Relying Party ID (must match server's rpID and associated domain).
    static let rpID: String = apiBaseURL.host ?? "localhost"

    /// Server-side daily quota for AI requests. Species identification runs on
    /// device and is not subject to it, but AppError still maps HTTP 429 for
    /// every other endpoint.
    static let aiDailyRateLimit = 150
}
