import Foundation
import os

private let log = Logger(subsystem: Config.bundleID, category: "DataService")

protocol DataStoreService: Sendable {
    func fetchAllData() async throws -> AllDataResponse
    func deleteOuting(id: String) async throws -> DexUpdateResponse
    func updateOuting(id: String, fields: OutingUpdate) async throws -> Outing
    func rejectObservations(ids: [String]) async throws -> DataService.ObservationsResponse
    func searchSpecies(query: String, limit: Int) async throws -> [DataService.SpeciesSearchResult]
    func createObservations(_ observations: [BirdObservation]) async throws -> DataService.ObservationsResponse
    func exportOutingCSV(outingId: String) async throws -> Data
    func importEBirdCSV(_ csvData: Data) async throws -> [String]
    func confirmImport(previewIds: [String]) async throws -> DataService.ImportConfirmResponse
    func clearAllData() async throws
}

/// Handles all REST API communication with the WingDex backend.
///
/// Every endpoint attaches the session token via `Authorization: Bearer` header.
/// The server middleware translates this to a session cookie for Better Auth.
final class DataService: DataStoreService, Sendable {
    private let auth: AuthService
    private let expectedAccountID: String?

    /// Ephemeral session that never sends or stores cookies.
    /// Prevents stale cookies from conflicting with Bearer token auth.
    private static let bearerSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieAcceptPolicy = .never
        config.httpShouldSetCookies = false
        return URLSession(configuration: config)
    }()

    init(auth: AuthService, expectedAccountID: String? = nil) {
        self.auth = auth
        self.expectedAccountID = expectedAccountID
    }

    // MARK: - Bulk Fetch

    /// Fetch all user data in a single request.
    func fetchAllData() async throws -> AllDataResponse {
        try await get("api/data/all")
    }

    // MARK: - Outings

    func deleteOuting(id: String) async throws -> DexUpdateResponse {
        let data = try await delete("api/data/outings/\(id)")
        return try JSONDecoder().decode(DexUpdateResponse.self, from: data)
    }

    func updateOuting(id: String, fields: OutingUpdate) async throws -> Outing {
        let data = try JSONEncoder().encode(fields)
        let responseData = try await patch("api/data/outings/\(id)", body: data)
        return try JSONDecoder().decode(Outing.self, from: responseData)
    }

    // MARK: - Observations

    func rejectObservations(ids: [String]) async throws -> ObservationsResponse {
        struct Patch: Codable { let certainty: String }
        struct Update: Codable { let ids: [String]; let patch: Patch }
        let data = try JSONEncoder().encode(Update(ids: ids, patch: Patch(certainty: "rejected")))
        let responseData = try await patch("api/data/observations", body: data)
        return try JSONDecoder().decode(ObservationsResponse.self, from: responseData)
    }

    // MARK: - Species

    struct SpeciesSearchResult: Codable, Identifiable, Sendable {
        var id: String { ebirdCode ?? "\(common)|\(scientific)" }
        let common: String
        let scientific: String
        let ebirdCode: String?
        let wikiTitle: String?
    }

    private struct SpeciesSearchResponse: Codable {
        let results: [SpeciesSearchResult]
    }

    func searchSpecies(query: String, limit: Int = 8) async throws -> [SpeciesSearchResult] {
        var components = URLComponents(
            url: Config.apiBaseURL.appendingPathComponent("api/species/search"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [
            URLQueryItem(name: "q", value: query),
            URLQueryItem(name: "limit", value: String(limit)),
        ]
        guard let url = components?.url else {
            throw DataServiceError.invalidResponse
        }

        var request = URLRequest(url: url)
        let token = try await attachAuth(&request)

        let start = Date()
        let (data, response) = try await Self.bearerSession.data(for: request)
        try await validate(response, data: data, rejectedToken: token, path: "api/species/search", method: "GET", start: start, byteCount: data.count)
        return try JSONDecoder().decode(SpeciesSearchResponse.self, from: data).results
    }

    // MARK: - Create Operations

    struct CreateOutingResponse: Codable {
        let id: String
        let userId: String
        let startTime: String
        let endTime: String
        let locationName: String
        let notes: String
        let createdAt: String
    }

    func createOuting(_ outing: Outing) async throws -> Outing {
        let data = try JSONEncoder().encode(outing)
        let responseData = try await post("api/data/outings", body: data)
        return try JSONDecoder().decode(Outing.self, from: responseData)
    }

    struct PhotoPayload: Codable {
        let id: String
        let outingId: String
        let exifTime: String?
        let gps: PhotoGPS?
        let fileHash: String
        let fileName: String

        struct PhotoGPS: Codable {
            let lat: Double
            let lon: Double
        }
    }

    func createPhotos(_ photos: [PhotoPayload]) async throws {
        let data = try JSONEncoder().encode(photos)
        try await post("api/data/photos", body: data)
    }

    struct ObservationsResponse: Codable, Sendable {
        let observations: [BirdObservation]?
        let dexUpdates: [DexEntry]?
    }

    func createObservations(_ observations: [BirdObservation]) async throws -> ObservationsResponse {
        let data = try JSONEncoder().encode(observations)
        let responseData = try await post("api/data/observations", body: data)
        return try JSONDecoder().decode(ObservationsResponse.self, from: responseData)
    }

    // MARK: - Exports

    func exportSightingsCSV() async throws -> Data {
        try await getRaw("api/export/sightings")
    }

    func exportDexCSV() async throws -> Data {
        try await getRaw("api/export/dex")
    }

    func exportOutingCSV(outingId: String) async throws -> Data {
        try await getRaw("api/export/outing/\(outingId)")
    }

    // MARK: - Import

    struct ImportPreview: Codable {
        let previewId: String
        let speciesName: String?
        let conflict: String? // "new", "duplicate", "update_dates"
    }

    struct ImportPreviewResponse: Codable {
        let previews: [ImportPreview]
    }

    struct ImportConfirmResponse: Codable, Sendable {
        let imported: ImportedCounts
        struct ImportedCounts: Codable, Sendable {
            let outings: Int
            let newSpecies: Int
        }
    }

    /// Upload eBird CSV for preview with optional timezone conversion.
    func importEBirdCSVPreview(_ csvData: Data, profileTimezone: String?) async throws -> [ImportPreview] {
        let boundary = UUID().uuidString
        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"import.csv\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: text/csv\r\n\r\n".data(using: .utf8)!)
        body.append(csvData)
        body.append("\r\n".data(using: .utf8)!)

        if let tz = profileTimezone, tz != "observation-local" {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"profileTimezone\"\r\n\r\n".data(using: .utf8)!)
            body.append("\(tz)\r\n".data(using: .utf8)!)
        }

        body.append("--\(boundary)--\r\n".data(using: .utf8)!)

        let url = Config.apiBaseURL.appendingPathComponent("api/import/ebird-csv")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        let token = try await attachAuth(&request)

        let start = Date()
        let (responseData, response) = try await Self.bearerSession.data(for: request)
        try await validate(response, data: responseData, rejectedToken: token, path: "api/import/ebird-csv", method: "POST", start: start, byteCount: responseData.count)

        let preview = try JSONDecoder().decode(ImportPreviewResponse.self, from: responseData)
        return preview.previews
    }

    /// Legacy import without timezone (used by demo data loader).
    func importEBirdCSV(_ csvData: Data) async throws -> [String] {
        let previews = try await importEBirdCSVPreview(csvData, profileTimezone: nil)
        return previews.map(\.previewId)
    }

    func confirmImport(previewIds: [String]) async throws -> ImportConfirmResponse {
        struct ConfirmBody: Codable { let previewIds: [String] }
        let data = try JSONEncoder().encode(ConfirmBody(previewIds: previewIds))
        let responseData = try await post("api/import/ebird-csv/confirm", body: data)
        return try JSONDecoder().decode(ImportConfirmResponse.self, from: responseData)
    }

    // MARK: - Data Management

    func clearAllData() async throws {
        try await delete("api/data/clear")
    }

    // MARK: - HTTP Primitives

    private func get<T: Decodable>(_ path: String) async throws -> T {
        let data = try await getRaw(path)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func getRaw(_ path: String) async throws -> Data {
        let url = Config.apiBaseURL.appendingPathComponent(path)
        var request = URLRequest(url: url)
        let token = try await attachAuth(&request)

        let start = Date()
        let (data, response) = try await Self.bearerSession.data(for: request)
        try await validate(response, data: data, rejectedToken: token, path: path, method: "GET", start: start, byteCount: data.count)
        return data
    }

    @discardableResult
    private func post(_ path: String, body data: Data) async throws -> Data {
        let url = Config.apiBaseURL.appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = data
        let token = try await attachAuth(&request)

        let start = Date()
        let (responseData, response) = try await Self.bearerSession.data(for: request)
        try await validate(response, data: responseData, rejectedToken: token, path: path, method: "POST", start: start, byteCount: responseData.count)
        return responseData
    }

    @discardableResult
    private func patch(_ path: String, body data: Data) async throws -> Data {
        let url = Config.apiBaseURL.appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = data
        let token = try await attachAuth(&request)

        let start = Date()
        let (responseData, response) = try await Self.bearerSession.data(for: request)
        try await validate(response, data: responseData, rejectedToken: token, path: path, method: "PATCH", start: start, byteCount: responseData.count)
        return responseData
    }

    @discardableResult
    private func delete(_ path: String) async throws -> Data {
        let url = Config.apiBaseURL.appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        let token = try await attachAuth(&request)

        let start = Date()
        let (data, response) = try await Self.bearerSession.data(for: request)
        try await validate(response, data: data, rejectedToken: token, path: path, method: "DELETE", start: start, byteCount: data.count)
        return data
    }

    private func attachAuth(_ request: inout URLRequest) async throws -> String {
        let token = try await auth.validToken(forAccountID: expectedAccountID)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(Config.apiBaseURL.absoluteString, forHTTPHeaderField: "Origin")
        AuthenticatedRequest.instrument(&request)
        let method = request.httpMethod ?? "?"
        let path = request.url?.path ?? "?"
        log.debug("Request: \(method) \(path)")
        return token
    }

    private func validate(_ response: URLResponse, data: Data, rejectedToken: String, path: String = "?", method: String = "?", start: Date? = nil, byteCount: Int? = nil) async throws {
        guard let http = response as? HTTPURLResponse else {
            throw DataServiceError.invalidResponse
        }
        let durationMs = start.map { Int(Date().timeIntervalSince($0) * 1000) }
        let durationFragment = durationMs.map { " \($0)ms" } ?? ""
        let bytesFragment = byteCount.map { " \($0)B" } ?? ""
        guard (200...299).contains(http.statusCode) else {
            let status = http.statusCode
            if (400...499).contains(status) {
                log.warning("\(method) \(path) -> HTTP \(status)\(durationFragment)\(bytesFragment)")
            } else {
                log.error("\(method) \(path) -> HTTP \(status)\(durationFragment)\(bytesFragment)")
            }
            // Server rejected the session - clear stale local auth state
            // so the UI shows the sign-in screen instead of a broken homepage.
            if status == 401 {
                await auth.invalidateSession(rejectedToken: rejectedToken)
            }
            throw DataServiceError.http(
                status: status,
                message: Self.safePublicMessage(status: status, data: data),
                retryAfter: http.value(forHTTPHeaderField: "Retry-After").flatMap(TimeInterval.init)
            )
        }
        log.debug("\(method) \(path) -> HTTP \(http.statusCode)\(durationFragment)\(bytesFragment)")
    }

    private static func safePublicMessage(status: Int, data: Data) -> String? {
        guard [400, 409, 422].contains(status), data.count <= 512,
              let message = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
              !message.isEmpty,
              !message.contains("<")
        else { return nil }
        return message
    }
}

enum DataServiceError: LocalizedError {
    case network(URLError)
    case invalidResponse
    case http(status: Int, message: String?, retryAfter: TimeInterval?)

    var errorDescription: String? {
        switch self {
        case .network(let error): error.localizedDescription
        case .invalidResponse: "Invalid response"
        case .http(let status, let message, _): message ?? "HTTP \(status)"
        }
    }
}
