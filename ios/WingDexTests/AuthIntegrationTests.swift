@testable import WingDex
import XCTest

/// Exercises anonymous bearer authentication against the selected API backend.
final class AuthIntegrationTests: XCTestCase {

    private let baseURL = Config.apiBaseURL
    private let timeout: TimeInterval = 10

    // MARK: - Anonymous Sign-In + Bearer Auth

    func testAnonymousSignInReturnsBearerToken() async throws {
        let token = try await signInAnonymously()
        XCTAssertFalse(token.isEmpty, "Token should not be empty")
        XCTAssertGreaterThan(token.count, 10, "Token should be a reasonable length")
    }

    func testBearerTokenFetchesData() async throws {
        let token = try await signInAnonymously()

        let url = baseURL.appendingPathComponent("api/data/all")
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await URLSession.shared.data(for: request)
        let http = try XCTUnwrap(response as? HTTPURLResponse)
        XCTAssertEqual(http.statusCode, 200, "Bearer auth should succeed")

        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertNotNil(json?["outings"], "Response should contain outings")
    }

    func testInvalidBearerTokenReturns401() async throws {
        let url = baseURL.appendingPathComponent("api/data/all")
        var request = URLRequest(url: url)
        request.setValue("Bearer invalid-token-12345", forHTTPHeaderField: "Authorization")

        let (_, response) = try await URLSession.shared.data(for: request)
        let http = try XCTUnwrap(response as? HTTPURLResponse)
        XCTAssertEqual(http.statusCode, 401, "Invalid token should return 401")
    }

    func testNoBearerTokenReturns401() async throws {
        // Clear any session cookies from prior tests so this is truly unauthenticated.
        if let cookies = HTTPCookieStorage.shared.cookies(for: baseURL) {
            for cookie in cookies { HTTPCookieStorage.shared.deleteCookie(cookie) }
        }

        let url = baseURL.appendingPathComponent("api/data/all")
        let request = URLRequest(url: url)

        let (_, response) = try await URLSession.shared.data(for: request)
        let http = try XCTUnwrap(response as? HTTPURLResponse)
        XCTAssertEqual(http.statusCode, 401, "No auth should return 401")
    }

    func testBearerGetSessionReturnsUser() async throws {
        let token = try await signInAnonymously()

        let url = baseURL.appendingPathComponent("api/auth/get-session")
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await URLSession.shared.data(for: request)
        let http = try XCTUnwrap(response as? HTTPURLResponse)
        XCTAssertEqual(http.statusCode, 200)

        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let user = json?["user"] as? [String: Any]
        XCTAssertNotNil(user?["id"], "get-session should return user with id")
    }

    func testAnonymousBearerLifecycleIncludesIdentityExpiryAndRevocation() async throws {
        let signIn = try await signInAnonymouslyWithResponse()
        XCTAssertFalse(signIn.token.isEmpty)
        XCTAssertNotNil(
            signIn.response.value(forHTTPHeaderField: "set-auth-token"),
            "Native clients need the bearer plugin's signed token header"
        )

        let sessionURL = baseURL.appendingPathComponent("api/auth/get-session")
        var sessionRequest = URLRequest(url: sessionURL)
        sessionRequest.setValue("Bearer \(signIn.token)", forHTTPHeaderField: "Authorization")
        let (sessionData, sessionResponse) = try await URLSession.shared.data(for: sessionRequest)
        XCTAssertEqual(try XCTUnwrap(sessionResponse as? HTTPURLResponse).statusCode, 200)

        let sessionJSON = try XCTUnwrap(try JSONSerialization.jsonObject(with: sessionData) as? [String: Any])
        let user = try XCTUnwrap(sessionJSON["user"] as? [String: Any])
        let session = try XCTUnwrap(sessionJSON["session"] as? [String: Any])
        XCTAssertEqual(user["isAnonymous"] as? Bool, true)
        let expiryString = try XCTUnwrap(session["expiresAt"] as? String)
        let expiry = try XCTUnwrap(AuthService.parseISO8601(expiryString))
        let days = expiry.timeIntervalSinceNow / 86_400
        XCTAssertGreaterThan(days, 300)
        XCTAssertLessThan(days, 400)

        var signOutRequest = URLRequest(url: baseURL.appendingPathComponent("api/auth/sign-out"))
        signOutRequest.httpMethod = "POST"
        signOutRequest.setValue("Bearer \(signIn.token)", forHTTPHeaderField: "Authorization")
        signOutRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        signOutRequest.httpBody = Data("{}".utf8)
        let (_, signOutResponse) = try await URLSession.shared.data(for: signOutRequest)
        XCTAssertEqual(try XCTUnwrap(signOutResponse as? HTTPURLResponse).statusCode, 200)

        var revokedRequest = URLRequest(url: baseURL.appendingPathComponent("api/data/all"))
        revokedRequest.setValue("Bearer \(signIn.token)", forHTTPHeaderField: "Authorization")
        let (_, revokedResponse) = try await URLSession.shared.data(for: revokedRequest)
        XCTAssertEqual(try XCTUnwrap(revokedResponse as? HTTPURLResponse).statusCode, 401)
    }

    func testBearerCRUDRoundtrip() async throws {
        let token = try await signInAnonymously()

        // Create outing
        let outingId = "integration-test-\(UUID().uuidString)"
        let createURL = baseURL.appendingPathComponent("api/data/outings")
        var createReq = URLRequest(url: createURL)
        createReq.httpMethod = "POST"
        createReq.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        createReq.setValue("application/json", forHTTPHeaderField: "Content-Type")
        createReq.httpBody = try JSONSerialization.data(withJSONObject: [
            "id": outingId,
            "startTime": "2026-03-07T08:00:00.000Z",
            "endTime": "2026-03-07T09:00:00.000Z",
            "locationName": "Integration Test Park",
            "createdAt": "2026-03-07T09:00:00.000Z",
        ])

        let (_, createResp) = try await URLSession.shared.data(for: createReq)
        let createHttp = try XCTUnwrap(createResp as? HTTPURLResponse)
        XCTAssertEqual(createHttp.statusCode, 200, "Create outing should succeed")

        // Verify it exists
        let allURL = baseURL.appendingPathComponent("api/data/all")
        var allReq = URLRequest(url: allURL)
        allReq.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (allData, _) = try await URLSession.shared.data(for: allReq)
        let allJson = try JSONSerialization.jsonObject(with: allData) as? [String: Any]
        let outings = allJson?["outings"] as? [[String: Any]] ?? []
        XCTAssertTrue(outings.contains { ($0["id"] as? String) == outingId }, "Created outing should appear in data")

        // Delete it
        let deleteURL = baseURL.appendingPathComponent("api/data/outings/\(outingId)")
        var deleteReq = URLRequest(url: deleteURL)
        deleteReq.httpMethod = "DELETE"
        deleteReq.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (_, deleteResp) = try await URLSession.shared.data(for: deleteReq)
        let deleteHttp = try XCTUnwrap(deleteResp as? HTTPURLResponse)
        XCTAssertEqual(deleteHttp.statusCode, 200, "Delete outing should succeed")
    }

    func testOutingDetailEditingRoundtrip() async throws {
        let token = try await signInAnonymously()
        let suffix = UUID().uuidString
        let outingId = "outing-phase5-\(suffix)"
        let observationId = "obs-phase5-\(suffix)"

        let createURL = baseURL.appendingPathComponent("api/data/outings")
        var createRequest = URLRequest(url: createURL)
        createRequest.httpMethod = "POST"
        createRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        createRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        createRequest.httpBody = try JSONSerialization.data(withJSONObject: [
            "id": outingId,
            "startTime": "2026-07-20T08:00:00.000Z",
            "endTime": "2026-07-20T09:00:00.000Z",
            "locationName": "Phase 5 Test Park",
            "lat": 47.6205,
            "lon": -122.3493,
            "stateProvince": "US-WA",
            "countryCode": "US",
            "protocol": "Stationary",
            "numberObservers": 1,
            "allObsReported": true,
            "createdAt": "2026-07-20T09:00:00.000Z",
        ])

        let (_, createResponse) = try await URLSession.shared.data(for: createRequest)
        XCTAssertEqual(try XCTUnwrap(createResponse as? HTTPURLResponse).statusCode, 200)

        let updateURL = baseURL.appendingPathComponent("api/data/outings/\(outingId)")
        var updateRequest = URLRequest(url: updateURL)
        updateRequest.httpMethod = "PATCH"
        updateRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        updateRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        updateRequest.httpBody = try JSONSerialization.data(withJSONObject: [
            "locationName": "Renamed Phase 5 Park",
            "defaultLocationName": "Phase 5 Test Park",
        ])
        let (updateData, updateResponse) = try await URLSession.shared.data(for: updateRequest)
        XCTAssertEqual(try XCTUnwrap(updateResponse as? HTTPURLResponse).statusCode, 200)
        let updatedOuting = try XCTUnwrap(try JSONSerialization.jsonObject(with: updateData) as? [String: Any])
        XCTAssertEqual(updatedOuting["locationName"] as? String, "Renamed Phase 5 Park")
        XCTAssertEqual(updatedOuting["defaultLocationName"] as? String, "Phase 5 Test Park")

        var searchComponents = URLComponents(
            url: baseURL.appendingPathComponent("api/species/search"),
            resolvingAgainstBaseURL: false
        )
        searchComponents?.queryItems = [
            URLQueryItem(name: "q", value: "American Robin"),
            URLQueryItem(name: "limit", value: "8"),
        ]
        var searchRequest = URLRequest(url: try XCTUnwrap(searchComponents?.url))
        searchRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (searchData, searchResponse) = try await URLSession.shared.data(for: searchRequest)
        XCTAssertEqual(try XCTUnwrap(searchResponse as? HTTPURLResponse).statusCode, 200)
        let searchJSON = try XCTUnwrap(try JSONSerialization.jsonObject(with: searchData) as? [String: Any])
        let searchResults = try XCTUnwrap(searchJSON["results"] as? [[String: Any]])
        let robin = try XCTUnwrap(searchResults.first)
        let common = try XCTUnwrap(robin["common"] as? String)
        let scientific = try XCTUnwrap(robin["scientific"] as? String)
        let speciesName = "\(common) (\(scientific))"

        let observationsURL = baseURL.appendingPathComponent("api/data/observations")
        var addRequest = URLRequest(url: observationsURL)
        addRequest.httpMethod = "POST"
        addRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        addRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        addRequest.httpBody = try JSONSerialization.data(withJSONObject: [[
            "id": observationId,
            "outingId": outingId,
            "speciesName": speciesName,
            "count": 1,
            "certainty": "confirmed",
            "notes": "Manually added",
        ]])
        let (addData, addResponse) = try await URLSession.shared.data(for: addRequest)
        XCTAssertEqual(try XCTUnwrap(addResponse as? HTTPURLResponse).statusCode, 200)
        let addJSON = try XCTUnwrap(try JSONSerialization.jsonObject(with: addData) as? [String: Any])
        XCTAssertNotNil(addJSON["dexUpdates"] as? [[String: Any]])

        let exportURL = baseURL.appendingPathComponent("api/export/outing/\(outingId)")
        var exportRequest = URLRequest(url: exportURL)
        exportRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (exportData, exportResponse) = try await URLSession.shared.data(for: exportRequest)
        XCTAssertEqual(try XCTUnwrap(exportResponse as? HTTPURLResponse).statusCode, 200)
        let csv = try XCTUnwrap(String(data: exportData, encoding: .utf8))
        XCTAssertTrue(csv.contains(common), "CSV should contain the confirmed species")

        var rejectRequest = URLRequest(url: observationsURL)
        rejectRequest.httpMethod = "PATCH"
        rejectRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        rejectRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        rejectRequest.httpBody = try JSONSerialization.data(withJSONObject: [
            "ids": [observationId],
            "patch": ["certainty": "rejected"],
        ])
        let (rejectData, rejectResponse) = try await URLSession.shared.data(for: rejectRequest)
        XCTAssertEqual(try XCTUnwrap(rejectResponse as? HTTPURLResponse).statusCode, 200)
        let rejectJSON = try XCTUnwrap(try JSONSerialization.jsonObject(with: rejectData) as? [String: Any])
        let rejected = try XCTUnwrap(rejectJSON["observations"] as? [[String: Any]])
        XCTAssertEqual(rejected.first?["certainty"] as? String, "rejected")
        XCTAssertNotNil(rejectJSON["dexUpdates"] as? [[String: Any]])

        let deleteURL = baseURL.appendingPathComponent("api/data/outings/\(outingId)")
        var deleteRequest = URLRequest(url: deleteURL)
        deleteRequest.httpMethod = "DELETE"
        deleteRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (_, deleteResponse) = try await URLSession.shared.data(for: deleteRequest)
        XCTAssertEqual(try XCTUnwrap(deleteResponse as? HTTPURLResponse).statusCode, 200)
    }

    // MARK: - Helpers

    /// Sign in anonymously and return the raw session token.
    private func signInAnonymously() async throws -> String {
        try await signInAnonymouslyWithResponse().token
    }

    private func signInAnonymouslyWithResponse() async throws -> (token: String, response: HTTPURLResponse) {
        let url = baseURL.appendingPathComponent("api/auth/sign-in/anonymous")

        // Clear stale session cookies so Better Auth doesn't reject with
        // "Anonymous users cannot sign in again anonymously".
        if let cookies = HTTPCookieStorage.shared.cookies(for: baseURL) {
            for cookie in cookies { HTTPCookieStorage.shared.deleteCookie(cookie) }
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(baseURL.absoluteString, forHTTPHeaderField: "Origin")
        request.httpBody = Data("{}".utf8)

        let (data, response) = try await URLSession.shared.data(for: request)
        let http = try XCTUnwrap(response as? HTTPURLResponse)
        XCTAssertEqual(http.statusCode, 200, "Anonymous sign-in should succeed")

        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let token = try XCTUnwrap(json["token"] as? String)

        // Clear cookies set by sign-in so subsequent requests use only the
        // Bearer header, matching how the app works (AuthService.clearAPICookies).
        if let cookies = HTTPCookieStorage.shared.cookies(for: baseURL) {
            for cookie in cookies { HTTPCookieStorage.shared.deleteCookie(cookie) }
        }

        return (token, http)
    }
}
