@testable import WingDex
import XCTest

final class AuthenticatedRequestTraceTests: XCTestCase {
    func testPasskeyAuthResultDecodesCanonicalUserAndFractionalExpiry() throws {
        let data = Data(#"{"session":{"token":"raw-token","expiresAt":"2027-08-11T04:30:00.123Z"},"user":{"id":"user-1","name":"quiet-heron","email":"user@example.com","image":null,"isAnonymous":false}}"#.utf8)
        let response = try XCTUnwrap(HTTPURLResponse(
            url: URL(string: "https://example.com/api/auth/passkey/verify-registration")!,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["set-auth-token": "signed-token"]
        ))

        let result = try PasskeyService.decodeAuthResult(data: data, response: response)

        XCTAssertEqual(result.token, "raw-token")
        XCTAssertEqual(result.signedToken, "signed-token")
        XCTAssertEqual(result.userId, "user-1")
        XCTAssertEqual(result.user.name, "quiet-heron")
        XCTAssertFalse(result.user.isAnonymous)
        XCTAssertNotNil(result.expiresAt)
    }

    func testAccountPasskeyNameUsesTheCanonicalDisplayName() {
        XCTAssertEqual(
            PasskeyService.accountPasskeyName(
                deviceName: "iPhone",
                displayName: "quiet-heron"
            ),
            "iPhone (quiet-heron)"
        )
    }

    func testExtractsAndNormalizesSafeTraceID() throws {
        let response = try XCTUnwrap(HTTPURLResponse(
            url: URL(string: "https://example.com")!,
            statusCode: 500,
            httpVersion: nil,
            headerFields: ["X-Trace-Id": "0123456789ABCDEF0123456789abcdef"]
        ))

        let traceID = AuthenticatedRequest.traceID(from: response)

        XCTAssertEqual(traceID, "0123456789abcdef0123456789abcdef")
        XCTAssertEqual(AuthenticatedRequest.referenceSuffix(traceID: traceID), " [ref: 89abcdef]")
    }

    func testRejectsUnsafeTraceIDs() throws {
        for value in [
            "0123456789abcdef0123456789abcde",
            "0123456789abcdef0123456789abcdef0",
            "0123456789abcdef0123456789abcdeg",
            "0123456789abcdef 123456789abcdef",
        ] {
            let response = try XCTUnwrap(HTTPURLResponse(
                url: URL(string: "https://example.com")!,
                statusCode: 500,
                httpVersion: nil,
                headerFields: ["X-Trace-Id": value]
            ))
            XCTAssertNil(AuthenticatedRequest.traceID(from: response), value)
        }
        XCTAssertEqual(AuthenticatedRequest.referenceSuffix(traceID: nil), "")
        XCTAssertEqual(AuthenticatedRequest.referenceSuffix(traceID: "unsafe\nreference"), "")
    }
}

final class AuthCallbackParsingTests: XCTestCase {

    // MARK: - parseCallbackURL

    func testValidCallbackWithAllParams() throws {
        let url = URL(string: "wingdex://auth/callback?token=abc123&signed_token=abc123.sig%252Bvalue&expires_at=2026-03-14T19:41:56.066Z&user_id=user1&user_name=John&user_email=john@example.com&user_image=https://example.com/photo.jpg")!
        let result = try AuthService.parseCallbackURL(url)

        XCTAssertEqual(result.token, "abc123")
        XCTAssertEqual(result.signedToken, "abc123.sig%2Bvalue")
        XCTAssertEqual(result.userId, "user1")
        XCTAssertEqual(result.userName, "John")
        XCTAssertEqual(result.userEmail, "john@example.com")
        XCTAssertEqual(result.userImage, "https://example.com/photo.jpg")
        XCTAssertNotNil(result.expiry)
    }

    func testValidCallbackWithMinimalParams() throws {
        let url = URL(string: "wingdex://auth/callback?token=abc123&expires_at=2026-03-14T19:41:56Z")!
        let result = try AuthService.parseCallbackURL(url)

        XCTAssertEqual(result.token, "abc123")
        XCTAssertNil(result.signedToken)
        XCTAssertNil(result.userId)
        XCTAssertNil(result.userName)
        XCTAssertNil(result.userEmail)
        XCTAssertNil(result.userImage)
    }

    func testCallbackWithURLEncodedValues() throws {
        let url = URL(string: "wingdex://auth/callback?token=abc%3D123&expires_at=2026-03-14T19%3A41%3A56.066Z&user_name=John%20Lian&user_email=john%40example.com")!
        let result = try AuthService.parseCallbackURL(url)

        XCTAssertEqual(result.token, "abc=123")
        XCTAssertEqual(result.userName, "John Lian")
        XCTAssertEqual(result.userEmail, "john@example.com")
    }

    func testCallbackWithErrorParam() {
        let url = URL(string: "wingdex://auth/callback?error=no_session")!

        XCTAssertThrowsError(try AuthService.parseCallbackURL(url)) { error in
            XCTAssertTrue(error.localizedDescription.contains("no_session"))
        }
    }

    func testCallbackMissingToken() {
        let url = URL(string: "wingdex://auth/callback?expires_at=2026-03-14T19:41:56Z&user_id=user1")!

        XCTAssertThrowsError(try AuthService.parseCallbackURL(url)) { error in
            XCTAssertTrue(error.localizedDescription.contains("Missing token"))
        }
    }

    func testCallbackMissingExpiresAt() {
        let url = URL(string: "wingdex://auth/callback?token=abc123&user_id=user1")!

        XCTAssertThrowsError(try AuthService.parseCallbackURL(url)) { error in
            XCTAssertTrue(error.localizedDescription.contains("Missing token"))
        }
    }

    func testCallbackInvalidExpiryDate() {
        let url = URL(string: "wingdex://auth/callback?token=abc123&expires_at=not-a-date")!

        XCTAssertThrowsError(try AuthService.parseCallbackURL(url)) { error in
            XCTAssertTrue(error.localizedDescription.contains("Invalid expiry"))
        }
    }

    func testCallbackEmptyURL() {
        let url = URL(string: "wingdex://auth/callback")!

        XCTAssertThrowsError(try AuthService.parseCallbackURL(url))
    }

    // MARK: - parseISO8601

    func testISO8601WithFractionalSeconds() {
        let date = AuthService.parseISO8601("2026-03-14T19:41:56.066Z")
        XCTAssertNotNil(date)
    }

    func testISO8601WithoutFractionalSeconds() {
        let date = AuthService.parseISO8601("2026-03-14T19:41:56Z")
        XCTAssertNotNil(date)
    }

    func testISO8601WithTimezoneOffset() {
        let date = AuthService.parseISO8601("2026-03-14T12:41:56-07:00")
        XCTAssertNotNil(date)
    }

    func testISO8601WithHighPrecisionFractional() {
        let date = AuthService.parseISO8601("2026-03-14T19:41:56.123456Z")
        XCTAssertNotNil(date)
    }

    func testISO8601InvalidString() {
        let date = AuthService.parseISO8601("March 14, 2026")
        XCTAssertNil(date)
    }

    func testISO8601EmptyString() {
        let date = AuthService.parseISO8601("")
        XCTAssertNil(date)
    }

    // MARK: - Token extraction from real-world callback URLs

    func testRealWorldGitHubCallbackURL() throws {
        // Simulates what the mobile/callback endpoint sends with encodeURIComponent
        // (spaces as %20, not + as URLSearchParams would produce)
        let url = URL(string: "wingdex://auth/callback?token=hf2znuT4gSpDhB3VJkjAFsyH6wahdBP2&signed_token=hf2znuT4gSpDhB3VJkjAFsyH6wahdBP2.WxY%252Bsig%253D&expires_at=2026-03-14T19%3A41%3A56.066Z&user_id=w3mYQIVlKKAlUANNqylaCCEJrG0du0Fw&user_name=John%20Lian&user_email=lianguanlun%40gmail.com&user_image=https%3A%2F%2Favatars.githubusercontent.com%2Fu%2F2320572%3Fv%3D4")!

        let result = try AuthService.parseCallbackURL(url)
        XCTAssertEqual(result.token, "hf2znuT4gSpDhB3VJkjAFsyH6wahdBP2")
        XCTAssertEqual(result.signedToken, "hf2znuT4gSpDhB3VJkjAFsyH6wahdBP2.WxY%2Bsig%3D")
        XCTAssertEqual(result.userId, "w3mYQIVlKKAlUANNqylaCCEJrG0du0Fw")
        XCTAssertEqual(result.userName, "John Lian")
        XCTAssertEqual(result.userEmail, "lianguanlun@gmail.com")
        XCTAssertTrue(result.userImage?.contains("avatars.githubusercontent.com") ?? false)
        XCTAssertNotNil(result.expiry)
    }
}

// MARK: - Session Validation Tests

final class SessionValidationTests: XCTestCase {
    func testAnonymousUpgradeRequiresItsSignedSessionToken() throws {
        XCTAssertThrowsError(try AuthService.passkeyRegistrationContext(
            identity: .anonymous,
            userID: "anonymous-user",
            signedToken: nil
        ))

        XCTAssertEqual(
            try AuthService.passkeyRegistrationContext(
                identity: .anonymous,
                userID: "anonymous-user",
                signedToken: "signed-token"
            ),
            .upgrade(userID: "anonymous-user", signedToken: "signed-token")
        )
    }

    func testStaleAuthenticationGenerationCannotInstallState() {
        XCTAssertTrue(AuthService.isSameAuthenticationGeneration(current: 4, expected: 4))
        XCTAssertFalse(AuthService.isSameAuthenticationGeneration(current: 5, expected: 4))
    }

    func testSessionIdentityDistinguishesAnonymousAndRegisteredUsers() {
        XCTAssertEqual(AuthService.sessionIdentity(isAnonymous: true), .anonymous)
        XCTAssertEqual(AuthService.sessionIdentity(isAnonymous: false), .registered)
    }

    func testSessionMetadataDecodesAnonymousIdentityAndFractionalExpiry() throws {
        let data = Data(#"{"session":{"id":"session-1","expiresAt":"2027-08-11T04:30:00.123Z"},"user":{"id":"user-1","name":"quiet-heron","isAnonymous":true}}"#.utf8)

        let metadata = try XCTUnwrap(AuthService.decodeSessionMetadata(data: data))

        XCTAssertEqual(metadata.user.id, "user-1")
        XCTAssertEqual(metadata.user.name, "quiet-heron")
        XCTAssertTrue(metadata.user.isAnonymous)
        XCTAssertNotNil(metadata.expiresAt)
    }

    func testSessionValidationIsRequiredWithoutSuccessfulValidation() {
        XCTAssertTrue(AuthService.shouldValidateSession(
            lastSuccessfulValidation: nil,
            now: Date(timeIntervalSince1970: 100)
        ))
    }

    func testRecentSuccessfulSessionValidationSkipsForegroundRequest() {
        let validation = Date(timeIntervalSince1970: 100)
        XCTAssertFalse(AuthService.shouldValidateSession(
            lastSuccessfulValidation: validation,
            now: validation.addingTimeInterval(59)
        ))
    }

    func testExpiredSessionValidationFreshnessRequiresRequest() {
        let validation = Date(timeIntervalSince1970: 100)
        XCTAssertTrue(AuthService.shouldValidateSession(
            lastSuccessfulValidation: validation,
            now: validation.addingTimeInterval(60)
        ))
    }

    func testExpectedAccountMustMatchCurrentAccount() {
        XCTAssertTrue(AuthService.isSameAccount(currentAccountID: "account-a", expectedAccountID: "account-a"))
        XCTAssertFalse(AuthService.isSameAccount(currentAccountID: "account-b", expectedAccountID: "account-a"))
    }

    func testNullSuccessfulSessionIsRejected() {
        XCTAssertTrue(AuthService.sessionValidationRejects(statusCode: 200, data: Data("null".utf8)))
    }

    func testMalformedSuccessfulSessionIsRejected() {
        XCTAssertTrue(AuthService.sessionValidationRejects(statusCode: 200, data: Data("{}".utf8)))
    }

    func testSuccessfulSessionWithoutIdsIsRejected() {
        let data = Data(#"{"session":{},"user":{}}"#.utf8)
        XCTAssertTrue(AuthService.sessionValidationRejects(statusCode: 200, data: data))
    }

    func testValidSuccessfulSessionIsAccepted() {
        let data = Data(#"{"session":{"id":"session-1"},"user":{"id":"user-1"}}"#.utf8)
        XCTAssertFalse(AuthService.sessionValidationRejects(statusCode: 200, data: data))
    }

    func testUnauthorizedSessionIsRejected() {
        XCTAssertTrue(AuthService.sessionValidationRejects(statusCode: 401, data: Data()))
    }

    func testServerFailureDoesNotRejectCachedSession() {
        XCTAssertFalse(AuthService.sessionValidationRejects(statusCode: 500, data: Data()))
    }

    func testRejectedCurrentTokenInvalidatesSession() {
        XCTAssertTrue(AuthService.isSameSession(currentToken: "token-a", initiatingToken: "token-a"))
    }

    func testRejectedOldTokenDoesNotInvalidateReplacementSession() {
        XCTAssertFalse(AuthService.isSameSession(currentToken: "token-b", initiatingToken: "token-a"))
    }

    @MainActor
    func testSignInMessageIsConsumedOnce() {
        let auth = AuthService()
        auth.signInMessage = "Your session expired. Please sign in again."

        XCTAssertEqual(auth.consumeSignInMessage(), "Your session expired. Please sign in again.")
        XCTAssertNil(auth.consumeSignInMessage())
    }

    @MainActor
    func testDiscardedAccountIDIsConsumedOnce() async {
        let auth = AuthService()
        auth.userId = "account-a"
        await auth.signOut()

        XCTAssertEqual(auth.consumeDiscardedAccountID(), "account-a")
        XCTAssertNil(auth.consumeDiscardedAccountID())
    }
}

@MainActor
final class DataStoreSessionTests: XCTestCase {
    func testResetClearsAccountOwnedState() {
        let auth = AuthService()
        let store = DataStore(service: DataService(auth: auth))
        store.outings = [Outing(
            id: "outing-1",
            userId: "user-1",
            startTime: "2026-07-20T12:00:00Z",
            endTime: "2026-07-20T13:00:00Z",
            locationName: "Test Marsh",
            notes: "",
            createdAt: "2026-07-20T12:00:00Z"
        )]
        store.isLoading = true
        store.error = .message("Previous account error")

        store.reset()

        XCTAssertTrue(store.outings.isEmpty)
        XCTAssertTrue(store.photos.isEmpty)
        XCTAssertTrue(store.observations.isEmpty)
        XCTAssertTrue(store.dex.isEmpty)
        XCTAssertFalse(store.isLoading)
        XCTAssertNil(store.error)
    }
}

final class AppErrorTests: XCTestCase {
    func testHTTPErrorModelsRetainTraceIDs() {
        let traceID = "0123456789abcdef0123456789abcdef"
        let dataError = DataServiceError.http(
            status: 503,
            message: nil,
            retryAfter: nil,
            traceID: traceID
        )
        guard case .http(_, _, _, let retainedDataTraceID) = dataError else {
            return XCTFail("Expected data HTTP error")
        }
        XCTAssertEqual(retainedDataTraceID, traceID)
        XCTAssertEqual(AuthError.oauthFailed("HTTP 503", traceID: traceID).traceID, traceID)
        XCTAssertEqual(PasskeyError.serverError("HTTP 503", traceID: traceID).traceID, traceID)
    }

    func testExistingAppErrorIsPreserved() {
        let error = AppError.message("Specific recovery guidance")
        XCTAssertEqual(AppError.map(error), error)
    }

    func testOfflineMapping() {
        XCTAssertEqual(AppError.map(URLError(.notConnectedToInternet)), .offline)
        XCTAssertEqual(AppError.map(URLError(.networkConnectionLost)), .offline)
    }

    func testTimeoutMapping() {
        XCTAssertEqual(AppError.map(URLError(.timedOut)), .timedOut)
    }

    func testCancellationIsSilent() {
        XCTAssertNil(AppError.map(URLError(.cancelled)))
    }

    func testRateLimitIncludesConfiguredLimitAndRetryAfter() {
        let error = DataServiceError.http(status: 429, message: nil, retryAfter: 120, traceID: nil)
        let mapped = AppError.map(error, rateLimit: Config.aiDailyRateLimit)
        XCTAssertEqual(mapped, .rateLimited(limit: Config.aiDailyRateLimit, retryAfter: 120))
        XCTAssertTrue(mapped?.message.contains("150 requests/day") == true)
        XCTAssertTrue(mapped?.message.contains("2 minutes") == true)
    }

    func testUnrelatedRateLimitUsesGenericCopy() {
        let error = DataServiceError.http(status: 429, message: nil, retryAfter: 120, traceID: nil)
        XCTAssertEqual(AppError.map(error), .message("Too many requests. Try again later."))
    }

    func testAuthErrorsRespectPresentationContext() {
        XCTAssertEqual(AppError.map(AuthError.notAuthenticated), .sessionExpired)
        XCTAssertEqual(
            AppError.map(AuthError.oauthFailed("unsafe detail"), fallback: "Could not save your profile. Try again."),
            .message("Could not save your profile. Try again.")
        )
    }

    func testSafeClientMessageIsPreserved() {
        let error = DataServiceError.http(
            status: 409,
            message: "This import was already confirmed.",
            retryAfter: nil,
            traceID: "0123456789abcdef0123456789abcdef"
        )
        XCTAssertEqual(AppError.map(error), .message("This import was already confirmed."))
    }

    func testServerAndDecodingFailuresUseSafeCopy() {
        let error = DataServiceError.http(
            status: 500,
            message: nil,
            retryAfter: nil,
            traceID: "0123456789abcdef0123456789abcdef"
        )
        XCTAssertEqual(AppError.map(error), .server)
        XCTAssertEqual(AppError.map(DataServiceError.invalidResponse), .invalidResponse)
    }
}

// MARK: - Config Tests

final class ConfigURLTests: XCTestCase {

    func testAPIBaseURLIsValid() {
        let url = Config.apiBaseURL
        XCTAssertNotNil(url.host)
        XCTAssertTrue(url.scheme == "http" || url.scheme == "https")
    }

    func testAPIBaseURLUsesBundledBuildConfigurationWithoutLaunchEnvironment() {
        let url = Config.resolveAPIBaseURL(
            environment: [:],
            infoDictionary: ["APIBaseURL": "https://dev.wingdex.app"],
            isDebug: true
        )

        XCTAssertEqual(url.absoluteString, "https://dev.wingdex.app")
    }

    func testAPIBaseURLLaunchEnvironmentOverridesBundledConfiguration() {
        let url = Config.resolveAPIBaseURL(
            environment: ["API_BASE_URL": "https://localhost.wingdex.app"],
            infoDictionary: ["APIBaseURL": "https://dev.wingdex.app"],
            isDebug: true
        )

        XCTAssertEqual(url.absoluteString, "https://localhost.wingdex.app")
    }

    func testBundleID() {
        XCTAssertEqual(Config.bundleID, "app.wingdex")
    }

    func testOAuthCallbackScheme() {
        XCTAssertEqual(Config.oauthCallbackScheme, "wingdex")
    }

    func testRPIDMatchesAPIHost() {
        XCTAssertEqual(Config.rpID, Config.apiBaseURL.host)
    }

    func testAIDailyRateLimit() {
        XCTAssertEqual(Config.aiDailyRateLimit, 150)
    }
}
