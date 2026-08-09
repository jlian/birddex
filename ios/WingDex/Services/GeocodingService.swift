import Foundation
import os

private let log = Logger(subsystem: Config.bundleID, category: "Geocoding")

struct GeocodingResult: Codable, Identifiable, Sendable {
    var id: String { "\(latitude),\(longitude),\(label)" }
    let label: String
    let latitude: Double
    let longitude: Double
    let stateProvince: String?
    let countryCode: String?

    enum CodingKeys: String, CodingKey {
        case label
        case latitude = "lat"
        case longitude = "lon"
        case stateProvince
        case countryCode
    }
}

enum GeocodingServiceError: Error {
    case invalidURL
    case invalidResponse
    case server(statusCode: Int, traceID: String?)
}

@MainActor
final class GeocodingService {
    private struct ReverseResponse: Codable {
        let result: GeocodingResult?
    }

    private struct SearchResponse: Codable {
        let results: [GeocodingResult]
    }

    private let auth: AuthService
    private let session: URLSession

    init(auth: AuthService, session: URLSession = .shared) {
        self.auth = auth
        self.session = session
    }

    func reverse(latitude: Double, longitude: Double) async throws -> GeocodingResult? {
        let response: ReverseResponse = try await post(
            path: "api/geocoding/reverse",
            body: ["lat": latitude, "lon": longitude]
        )
        return response.result
    }

    func search(query: String) async throws -> [GeocodingResult] {
        let response: SearchResponse = try await post(
            path: "api/geocoding/search",
            body: ["query": query]
        )
        return response.results
    }

    private func post<Response: Decodable, Body: Encodable>(path: String, body: Body) async throws -> Response {
        let url = Config.apiBaseURL.appendingPathComponent(path)
        let token = try auth.validToken()
        var request = AuthenticatedRequest.withBearer(url: url, token: token)
        request.httpMethod = "POST"
        request.timeoutInterval = 6
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await AuthenticatedRequest.data(
            for: request,
            session: session,
            context: "Geocoding"
        )
        guard let http = response as? HTTPURLResponse else {
            log.error("Geocoding failed: invalid HTTP response")
            throw GeocodingServiceError.invalidResponse
        }
        guard (200...299).contains(http.statusCode) else {
            let traceID = AuthenticatedRequest.traceID(from: http)
            let reference = AuthenticatedRequest.referenceSuffix(traceID: traceID)
            if (400...499).contains(http.statusCode) {
                log.warning("Geocoding failed: HTTP \(http.statusCode)\(reference, privacy: .public)")
            } else {
                log.error("Geocoding failed: HTTP \(http.statusCode)\(reference, privacy: .public)")
            }
            throw GeocodingServiceError.server(statusCode: http.statusCode, traceID: traceID)
        }
        do {
            return try JSONDecoder().decode(Response.self, from: data)
        } catch {
            let reference = AuthenticatedRequest.referenceSuffix(
                traceID: AuthenticatedRequest.traceID(from: http)
            )
            log.error("Geocoding failed: response decoding failed\(reference, privacy: .public)")
            throw error
        }
    }
}