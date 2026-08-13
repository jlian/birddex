import Foundation
import os
import Security

private let log = Logger(subsystem: Config.bundleID, category: "API")

/// Centralized helper for building authenticated API requests.
///
/// Better Auth has two auth mechanisms:
/// - **Bearer token**: Used by the `bearer()` plugin for middleware-protected routes
///   (`/api/data/*`) and some auth endpoints (`get-session`).
///   Accepts the raw session token.
/// - **Session cookie**: Used by Better Auth's internal plugin endpoints (all passkey
///   endpoints) which do their own cookie-based session validation.
///   Requires the HMAC-signed session token as a cookie value.
///
/// This helper encapsulates both patterns so callers don't need to know which to use.
enum AuthenticatedRequest {

    static func traceID(from response: HTTPURLResponse) -> String? {
        normalizedTraceID(response.value(forHTTPHeaderField: "X-Trace-Id"))
    }

    static func referenceSuffix(traceID: String?) -> String {
        guard let traceID = normalizedTraceID(traceID) else { return "" }
        return " [ref: \(traceID.suffix(8))]"
    }

    private static func normalizedTraceID(_ value: String?) -> String? {
        guard let value,
              value.utf8.count == 32,
              value.unicodeScalars.allSatisfy({ scalar in
                  (48...57).contains(scalar.value)
                      || (65...70).contains(scalar.value)
                      || (97...102).contains(scalar.value)
              })
        else { return nil }
        return value.lowercased()
    }

    static func instrument(_ request: inout URLRequest) {
        if request.value(forHTTPHeaderField: "Origin") == nil {
            request.setValue(Config.apiBaseURL.absoluteString, forHTTPHeaderField: "Origin")
        }
        request.setValue(generateTraceparent(), forHTTPHeaderField: "traceparent")
    }

    static func data(
        for request: URLRequest,
        session: URLSession = .shared,
        context: String,
        logger: Logger = log
    ) async throws -> (Data, URLResponse) {
        let start = Date()
        do {
            let (data, response) = try await session.data(for: request)
            let durationMs = Int(Date().timeIntervalSince(start) * 1000)
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            logger.debug("\(context): HTTP \(status) \(durationMs)ms \(data.count)B")
            return (data, response)
        } catch {
            let durationMs = Int(Date().timeIntervalSince(start) * 1000)
            logger.error("\(context): transport failure after \(durationMs)ms")
            throw error
        }
    }

    /// Build a request with Bearer token auth (for middleware-protected routes).
    static func withBearer(
        url: URL,
        token: String,
        method: String = "GET",
        body: Data? = nil,
        contentType: String? = nil
    ) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(Config.apiBaseURL.absoluteString, forHTTPHeaderField: "Origin")
        if let contentType {
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }
        request.httpBody = body
        instrument(&request)
        return request
    }

    /// Build a request with signed session cookie only (NO Bearer).
    /// Used for Better Auth internal plugin endpoints (passkey register, verify)
    /// where mixing Bearer + cookies causes auth failures.
    /// Optionally forwards additional cookies (e.g., challenge cookies).
    static func withCookieOnly(
        url: URL,
        signedToken: String?,
        additionalCookies: String? = nil,
        method: String = "GET",
        body: Data? = nil,
        contentType: String? = nil
    ) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(Config.apiBaseURL.absoluteString, forHTTPHeaderField: "Origin")
        if let contentType {
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }
        request.httpBody = body

        // Session cookie only - both prefixed variants for HTTP/HTTPS compat
        var cookieParts: [String] = []
        if let signedToken {
            cookieParts.append("better-auth.session_token=\(signedToken)")
            cookieParts.append("__Secure-better-auth.session_token=\(signedToken)")
        }
        if let extra = additionalCookies {
            cookieParts.append(extra)
        }
        if !cookieParts.isEmpty {
            request.setValue(cookieParts.joined(separator: "; "), forHTTPHeaderField: "Cookie")
        }
        instrument(&request)

        return request
    }

    /// Extract cookie name=value pairs from Set-Cookie response headers.
    /// Uses HTTPCookie parsing and preserves URL-encoded values.
    static func extractCookies(from response: HTTPURLResponse, for url: URL) -> String? {
        guard let headerFields = response.allHeaderFields as? [String: String] else { return nil }
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: headerFields, for: url)
        guard !cookies.isEmpty else { return nil }
        let result = cookies.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
        log.debug("Extracted cookies: \(cookies.map { $0.name }.joined(separator: ", "))")
        return result
    }

    /// Validate an HTTP response without logging response bodies.
    @discardableResult
    static func validateHTTP(
        _ response: URLResponse,
        data: Data,
        context: String,
        logger: Logger = log
    ) throws -> HTTPURLResponse {
        guard let http = response as? HTTPURLResponse,
              (200...299).contains(http.statusCode)
        else {
            let http = response as? HTTPURLResponse
            let status = http?.statusCode ?? -1
            let traceID = http.flatMap(traceID(from:))
            let reference = referenceSuffix(traceID: traceID)
            if (400...499).contains(status) {
                logger.warning("\(context): HTTP \(status)\(reference, privacy: .public)")
            } else {
                logger.error("\(context): HTTP \(status)\(reference, privacy: .public)")
            }
            throw PasskeyError.serverError("\(context) (HTTP \(status))", traceID: traceID)
        }
        return http
    }

    private static func generateTraceparent() -> String {
        var bytes = [UInt8](repeating: 0, count: 24)
        let status = bytes.withUnsafeMutableBufferPointer { buffer in
            SecRandomCopyBytes(kSecRandomDefault, buffer.count, buffer.baseAddress!)
        }
        if status != errSecSuccess {
            let fallback = (UUID().uuidString + UUID().uuidString)
                .replacingOccurrences(of: "-", with: "")
                .lowercased()
            return "00-\(fallback.prefix(32))-\(fallback.dropFirst(32).prefix(16))-01"
        }
        let hex = bytes.map { String(format: "%02x", $0) }.joined()
        return "00-\(hex.prefix(32))-\(hex.dropFirst(32).prefix(16))-01"
    }
}
