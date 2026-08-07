import Foundation

struct GeocodingResult: Codable, Identifiable, Sendable {
    struct Attribution: Codable, Sendable {
        let label: String
        let url: URL
    }

    var id: String { "\(latitude),\(longitude),\(label)" }
    let label: String
    let latitude: Double
    let longitude: Double
    let stateProvince: String?
    let countryCode: String?
    let attribution: Attribution

    enum CodingKeys: String, CodingKey {
        case label
        case latitude = "lat"
        case longitude = "lon"
        case stateProvince
        case countryCode
        case attribution
    }
}

enum GeocodingServiceError: Error {
    case invalidURL
    case invalidResponse
    case server(statusCode: Int)
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
        var components = URLComponents(
            url: Config.apiBaseURL.appendingPathComponent("api/geocoding/reverse"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [
            URLQueryItem(name: "lat", value: String(latitude)),
            URLQueryItem(name: "lon", value: String(longitude)),
        ]
        let response: ReverseResponse = try await get(components)
        return response.result
    }

    func search(query: String) async throws -> [GeocodingResult] {
        var components = URLComponents(
            url: Config.apiBaseURL.appendingPathComponent("api/geocoding/search"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [URLQueryItem(name: "q", value: query)]
        let response: SearchResponse = try await get(components)
        return response.results
    }

    private func get<Response: Decodable>(_ components: URLComponents?) async throws -> Response {
        guard let url = components?.url else { throw GeocodingServiceError.invalidURL }
        let token = try auth.validToken()
        let request = AuthenticatedRequest.withBearer(url: url, token: token)
        let (data, response) = try await AuthenticatedRequest.data(
            for: request,
            session: session,
            context: "Geocoding"
        )
        guard let http = response as? HTTPURLResponse else {
            throw GeocodingServiceError.invalidResponse
        }
        guard (200...299).contains(http.statusCode) else {
            throw GeocodingServiceError.server(statusCode: http.statusCode)
        }
        return try JSONDecoder().decode(Response.self, from: data)
    }
}