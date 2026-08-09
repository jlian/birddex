import AuthenticationServices
import Foundation

enum AppError: Error, Equatable, Identifiable {
    case offline
    case timedOut
    case sessionExpired
    case rateLimited(limit: Int, retryAfter: TimeInterval?)
    case passkeyUnavailable
    case authenticationFailed
    case server
    case invalidResponse
    case message(String)

    var id: String { message }

    var message: String {
        switch self {
        case .offline:
            "You're offline. Check your connection and try again."
        case .timedOut:
            "The request timed out. Try again."
        case .sessionExpired:
            "Your session expired. Please sign in again."
        case .rateLimited(let limit, let retryAfter):
            if let retryAfter {
                "AI identification limit reached (\(limit) requests/day). Try again in \(Self.durationText(retryAfter))."
            } else {
                "AI identification limit reached (\(limit) requests/day). Try again later."
            }
        case .passkeyUnavailable:
            "Passkeys aren't available for this app or domain."
        case .authenticationFailed:
            "Authentication failed. Try again."
        case .server, .invalidResponse:
            "Something went wrong. Try again."
        case .message(let message):
            message
        }
    }

    static func map(
        _ error: Error,
        fallback: String = "Something went wrong. Try again.",
        rateLimit: Int? = nil
    ) -> AppError? {
        if let appError = error as? AppError {
            return appError
        }

        if let authorizationError = error as? ASAuthorizationError {
            switch authorizationError.code {
            case .canceled:
                return nil
            case .notHandled:
                return .passkeyUnavailable
            default:
                return .authenticationFailed
            }
        }

        if let urlError = error as? URLError {
            switch urlError.code {
            case .cancelled:
                return nil
            case .notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost,
                 .cannotFindHost, .dnsLookupFailed, .internationalRoamingOff:
                return .offline
            case .timedOut:
                return .timedOut
            default:
                return .message(fallback)
            }
        }

        if let serviceError = error as? DataServiceError {
            switch serviceError {
            case .network(let urlError):
                return map(urlError, fallback: fallback, rateLimit: rateLimit)
            case .invalidResponse:
                return .invalidResponse
            case .http(let status, let message, let retryAfter, _):
                if status == 401 { return .sessionExpired }
                if status == 429 {
                    if let rateLimit {
                        return .rateLimited(limit: rateLimit, retryAfter: retryAfter)
                    }
                    return .message("Too many requests. Try again later.")
                }
                if (400...499).contains(status), let message {
                    return .message(message)
                }
                return .server
            }
        }

        if error is DecodingError {
            return .invalidResponse
        }
        if let authError = error as? AuthError {
            switch authError {
            case .notAuthenticated:
                return .sessionExpired
            case .oauthFailed:
                return .message(fallback)
            }
        }
        if let passkeyError = error as? PasskeyError {
            switch passkeyError {
            case .authenticationFailed:
                return .authenticationFailed
            default:
                return .message(fallback)
            }
        }
        return .message(fallback)
    }

    private static func durationText(_ duration: TimeInterval) -> String {
        let seconds = max(Int(duration.rounded(.up)), 1)
        if seconds < 60 { return "\(seconds) seconds" }
        let minutes = Int(ceil(Double(seconds) / 60))
        if minutes < 60 { return "\(minutes) minutes" }
        let hours = Int(ceil(Double(minutes) / 60))
        return "\(hours) hours"
    }
}