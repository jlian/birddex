import AuthenticationServices
import CryptoKit
import Foundation
import KeychainAccess
import Observation
import UIKit
import os

private let log = Logger(subsystem: Config.bundleID, category: "Auth")

enum SessionIdentity: String, Sendable {
    case none
    case anonymous
    case registered
}

enum SessionValidationResult: Sendable {
    case valid
    case rejected
    case offline
}

enum AccountMergeState: Sendable {
    case none
    case pending
    case finalizing
    case failed
}

enum PasskeyRegistrationContext: Equatable, Sendable {
    case sessionless
    case upgrade(userID: String, signedToken: String)
}

/// Manages authentication state, token storage, and OAuth flows.
///
/// Uses Better Auth's raw session token for bearer auth and the signed session token
/// for Better Auth's passkey endpoints that still validate cookie-based sessions.
/// Tokens are obtained via ASWebAuthenticationSession (GitHub / Apple OAuth).
/// The server's mobile callback bridge redirects to wingdex:// with the session token.
@MainActor @Observable
final class AuthService: @unchecked Sendable {
    static let shared = AuthService()

    private(set) var identity: SessionIdentity = .none
    var hasSession: Bool { identity != .none }
    var isRegisteredAccount: Bool { identity == .registered }
    var avatarImage: String? {
        guard identity == .anonymous, let userName else { return userImage }
        return FunNames.emojiAvatarDataUrl(FunNames.emojiForBirdName(userName))
    }
    var userId: String?
    var userName: String?
    var userEmail: String?
    var userImage: String?
    var signInMessage: String?
    private(set) var discardedAccountID: String?
    private(set) var accountMergeState: AccountMergeState = .none
    var hasPendingAccountMerge: Bool { keychain[Self.accountMergeTokenKey] != nil }
    var hasPendingAccountMergeForCurrentAccount: Bool {
        guard identity == .registered,
              hasPendingAccountMerge,
              let currentUserID = userId
        else { return false }
        guard let targetUserID = keychain[Self.accountMergeTargetKey] else { return true }
        return targetUserID == currentUserID
    }

    private var sessionToken: String?
    /// Signed session token (includes HMAC suffix) for cookie-based auth.
    /// Needed by passkey plugin endpoints which use internal cookie validation.
    private(set) var signedSessionToken: String?
    private var sessionExpiry: Date?
    private var sessionValidationTask: Task<SessionValidationResult, Never>?
    private var sessionValidationID: UUID?
    private var lastSuccessfulSessionValidation: Date?
    private var anonymousSessionTask: Task<Void, Error>?
    private var anonymousSessionTaskID: UUID?
    private var sessionEnrichmentTask: Task<Void, Never>?
    private var sessionEnrichmentTaskID: UUID?
    private var authenticationGeneration = 0
    #if DEBUG
    private var usesUITestIdentity = false
    #endif
    private let keychain = Keychain(service: Config.bundleID)
        .accessibility(.whenUnlockedThisDeviceOnly)

    /// Ephemeral session that never sends or stores cookies.
    /// Prevents stale cookies from conflicting with Bearer token auth.
    private static let bearerSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieAcceptPolicy = .never
        config.httpShouldSetCookies = false
        return URLSession(configuration: config)
    }()

    private static let tokenKey = "session_token"
    private static let signedTokenKey = "signed_session_token"
    private static let expiryKey = "session_expires_at"
    private static let userIdKey = "user_id"
    private static let userNameKey = "user_name"
    private static let userEmailKey = "user_email"
    private static let userImageKey = "user_image"
    private static let identityKey = "session_identity"
    private static let accountMergeTokenKey = "account_merge_token"
    private static let accountMergeTargetKey = "account_merge_target"

    private static func referenceSuffix(for error: Error) -> String {
        let traceID: String?
        if let authError = error as? AuthError {
            traceID = authError.traceID
        } else if let passkeyError = error as? PasskeyError {
            traceID = passkeyError.traceID
        } else {
            traceID = nil
        }
        return AuthenticatedRequest.referenceSuffix(traceID: traceID)
    }

    init() {
        restoreSession()
        if hasPendingAccountMergeForCurrentAccount {
            accountMergeState = .pending
        }
        log.info("AuthService initialized - identity: \(self.identity.rawValue)")
    }

    #if DEBUG
    func installUITestAnonymousIdentity() {
        authenticationGeneration += 1
        resetSessionValidation()
        sessionEnrichmentTask?.cancel()
        sessionEnrichmentTask = nil
        sessionEnrichmentTaskID = nil
        anonymousSessionTask?.cancel()
        anonymousSessionTask = nil
        anonymousSessionTaskID = nil
        sessionToken = nil
        signedSessionToken = nil
        sessionExpiry = nil
        usesUITestIdentity = true
        identity = .anonymous
        userId = "ui-test-account"
        userName = "Swift Sparrow"
        userEmail = nil
        userImage = nil
    }
    #endif

    /// Validate the locally-cached session with the server.
    /// Signs out when Better Auth rejects the session so the UI goes straight to
    /// sign-in instead of flashing authenticated content. Network errors are
    /// ignored - the user may be offline with a valid cached session.
    func validateSession(force: Bool = true, now: Date = .now) async -> SessionValidationResult {
        #if DEBUG
        if usesUITestIdentity { return .valid }
        #endif
        guard force || Self.shouldValidateSession(
            lastSuccessfulValidation: lastSuccessfulSessionValidation,
            now: now
        ) else { return .valid }
        if let sessionValidationTask {
            return await sessionValidationTask.value
        }
        guard let token = sessionToken else { return .rejected }
        let validationID = UUID()
        sessionValidationID = validationID
        let task = Task<SessionValidationResult, Never> { [weak self] in
            guard let self else { return .rejected }
            return await self.performSessionValidation(token: token, now: now)
        }
        sessionValidationTask = task
        let result = await task.value
        if sessionValidationID == validationID {
            sessionValidationTask = nil
            sessionValidationID = nil
        }
        return result
    }

    private func performSessionValidation(token: String, now: Date) async -> SessionValidationResult {
        let url = Config.apiBaseURL.appendingPathComponent("api/auth/get-session")
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 5
        AuthenticatedRequest.instrument(&request)
        do {
            let (data, response) = try await AuthenticatedRequest.data(
                for: request, session: Self.bearerSession,
                context: "Validate session", logger: log
            )
            if let http = response as? HTTPURLResponse,
               Self.sessionValidationRejects(statusCode: http.statusCode, data: data) {
                invalidateSession(
                    rejectedToken: token,
                    traceID: AuthenticatedRequest.traceID(from: http)
                )
                return .rejected
            } else if let http = response as? HTTPURLResponse,
                    (200...299).contains(http.statusCode),
                    isCurrentSession(token: token) {
                if applySessionMetadata(data: data, response: http, token: token) {
                    lastSuccessfulSessionValidation = now
                    return .valid
                } else {
                    log.error("Session validation returned incomplete session metadata")
                    invalidateSession(rejectedToken: token)
                    return .rejected
                }
            } else if let http = response as? HTTPURLResponse {
                let reference = AuthenticatedRequest.referenceSuffix(
                    traceID: AuthenticatedRequest.traceID(from: http)
                )
                log.error("Session validation failed: HTTP \(http.statusCode)\(reference, privacy: .public)")
            }
        } catch {
            // Network error - don't sign out, user may be offline
        }
        return .offline
    }

    nonisolated static func shouldValidateSession(
        lastSuccessfulValidation: Date?,
        now: Date,
        freshness: TimeInterval = 60
    ) -> Bool {
        guard let lastSuccessfulValidation else { return true }
        return now.timeIntervalSince(lastSuccessfulValidation) >= freshness
    }

    nonisolated static func sessionValidationRejects(statusCode: Int, data: Data) -> Bool {
        if statusCode == 401 { return true }
        guard (200...299).contains(statusCode),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let session = json["session"] as? [String: Any],
              session["id"] is String,
              let user = json["user"] as? [String: Any],
              user["id"] is String
        else {
            return (200...299).contains(statusCode)
        }
        return false
    }

    // MARK: - OAuth Flows

    /// Sign in with GitHub via ASWebAuthenticationSession.
    func signInWithGitHub() async throws {
        try await signInWithProvider("github")
    }

    /// Sign in with Google via ASWebAuthenticationSession.
    func signInWithGoogle() async throws {
        try await signInWithProvider("google")
    }

    /// Sign in with Apple using the native ASAuthorizationAppleIDProvider.
    /// Shows the system Face ID / Touch ID sheet - no web view needed.
    func signInWithAppleNative() async throws {
        let request = ASAuthorizationAppleIDProvider().createRequest()
        configureAppleSignInRequest(request)

        let credential = try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<ASAuthorizationAppleIDCredential, Error>) in
            let handler = AppleSignInHandler(continuation: continuation)
            self.appleSignInHandler = handler
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = handler
            controller.performRequests()
        }

        self.appleSignInHandler = nil
        try await signInWithApple(credential: credential)
    }

    private var appleSignInHandler: AppleSignInHandler?
    private var pendingAppleNonce: String?
    private var pendingAppleState: String?

    func configureAppleSignInRequest(_ request: ASAuthorizationAppleIDRequest) {
        let nonce = Self.randomOAuthValue()
        let state = Self.randomOAuthValue()
        pendingAppleNonce = nonce
        pendingAppleState = state
        request.nonce = Self.appleNonceHash(nonce)
        request.state = state
        request.requestedScopes = [.fullName, .email]
    }

    /// Sign in with Apple using a pre-obtained credential.
    func signInWithApple(credential: ASAuthorizationAppleIDCredential) async throws {
        log.info("Apple sign-in started")
        do {
        guard let nonce = pendingAppleNonce,
              let expectedState = pendingAppleState,
              Self.appleStateMatches(expected: expectedState, received: credential.state)
        else { throw AuthError.oauthFailed("Apple sign-in state did not match") }
        pendingAppleNonce = nil
        pendingAppleState = nil
        guard let identityTokenData = credential.identityToken,
                            let identityToken = String(data: identityTokenData, encoding: .utf8),
                            let authorizationCodeData = credential.authorizationCode,
                            let authorizationCode = String(data: authorizationCodeData, encoding: .utf8)
        else {
                        throw AuthError.oauthFailed("Missing Apple sign-in credentials")
        }

        let sourceToken = identity == .anonymous ? try validToken() : nil
        try await prepareAccountMerge(authMethod: "apple")
        let generation = beginAuthentication()
        let idToken: [String: Any] = ["token": identityToken, "nonce": nonce]

        // POST to Better Auth's sign-in/social endpoint with the Apple ID token.
        // Better Auth verifies the token with Apple, creates/links the account,
        // creates a session, and returns { token, user, redirect: false }.
        let url = Config.apiBaseURL.appendingPathComponent("api/auth/sign-in/social")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(Config.apiBaseURL.absoluteString, forHTTPHeaderField: "Origin")
        if let sourceToken {
            request.setValue("Bearer \(sourceToken)", forHTTPHeaderField: "Authorization")
        }

        let body: [String: Any] = [
            "provider": "apple",
            "idToken": idToken,
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        AuthenticatedRequest.instrument(&request)

        let (data, response) = try await AuthenticatedRequest.data(
            for: request, session: Self.bearerSession,
            context: "Apple sign-in", logger: log
        )

        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode)
        else {
            let http = response as? HTTPURLResponse
            let statusCode = http?.statusCode ?? 0
            throw AuthError.oauthFailed(
                "Apple sign-in failed (HTTP \(statusCode))",
                traceID: http.flatMap(AuthenticatedRequest.traceID(from:))
            )
        }
        guard isCurrentAuthentication(generation) else { throw CancellationError() }

        let token = try processTokenResponse(data: data, response: response)
        try? await fetchUserInfo(token: token)
        if !(await resumePendingAccountMerge()) {
            throw AuthError.oauthFailed("Account merge did not complete")
        }
        // The account and session are now live. Capturing the Apple revocation
        // token is a best-effort step that lets a future account deletion revoke
        // Apple's grant automatically; the server's deletion flow already falls
        // back to manual Apple revocation when the token is absent. The Apple
        // authorization code is single-use and already consumed here, so a
        // failure cannot be retried in place. Tearing the session down would
        // report "sign-in failed" while leaving a live server account and Apple
        // grant the user believes never existed, so treat capture as non-fatal
        // and keep the successful sign-in.
        do {
            try await captureAppleRevocationToken(authorizationCode: authorizationCode)
        } catch {
            let reference = Self.referenceSuffix(for: error)
            log.warning("Apple revocation token capture failed; sign-in kept\(reference, privacy: .public)")
        }
        log.info("Apple sign-in succeeded")
        } catch {
            let reference = Self.referenceSuffix(for: error)
            log.error("Apple sign-in failed\(reference, privacy: .public)")
            throw error
        }
    }

    nonisolated static func appleNonceHash(_ nonce: String) -> String {
        SHA256.hash(data: Data(nonce.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    nonisolated static func appleStateMatches(expected: String, received: String?) -> Bool {
        received == expected
    }

    nonisolated private static func randomOAuthValue() -> String {
        let bytes = (0..<32).map { _ in UInt8.random(in: .min ... .max) }
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private func captureAppleRevocationToken(authorizationCode: String) async throws {
        let token = try validToken()
        let url = Config.apiBaseURL.appendingPathComponent("api/auth/apple/revocation-token")
        let body = try JSONSerialization.data(withJSONObject: ["authorizationCode": authorizationCode])
        let request = AuthenticatedRequest.withBearer(
            url: url,
            token: token,
            method: "POST",
            body: body,
            contentType: "application/json"
        )
        let (_, response) = try await AuthenticatedRequest.data(
            for: request,
            session: Self.bearerSession,
            context: "Capture Apple deletion credential",
            logger: log
        )
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            let http = response as? HTTPURLResponse
            let status = http?.statusCode ?? 0
            throw AuthError.oauthFailed(
                "Apple account setup failed (HTTP \(status))",
                traceID: http.flatMap(AuthenticatedRequest.traceID(from:))
            )
        }
    }

    /// Sign in anonymously via Better Auth's anonymous plugin.
    /// Creates a temporary session for account-optional persistence.
    func signInAnonymously() async throws {
        if hasSession { return }
        let generation = beginAuthentication()
        log.info("Starting anonymous sign-in")
        do {
        // Clear any stale session cookies so Better Auth doesn't reject
        // with "Anonymous users cannot sign in again anonymously".
        clearAPICookies()
        let url = Config.apiBaseURL.appendingPathComponent("api/auth/sign-in/anonymous")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(Config.apiBaseURL.absoluteString, forHTTPHeaderField: "Origin")
        request.httpBody = Data("{}".utf8)
        AuthenticatedRequest.instrument(&request)

        let (data, response) = try await AuthenticatedRequest.data(
            for: request, session: Self.bearerSession,
            context: "Anonymous sign-in", logger: log
        )

        guard let httpResponse = response as? HTTPURLResponse else {
            throw AuthError.oauthFailed("Invalid response")
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            throw AuthError.oauthFailed(
                "Anonymous sign-in failed (\(httpResponse.statusCode))",
                traceID: AuthenticatedRequest.traceID(from: httpResponse)
            )
        }
        guard isCurrentAuthentication(generation) else { throw CancellationError() }

        let token = try processTokenResponse(data: data, response: response)
        startSessionEnrichment(token: token, generation: generation)
        log.info("Anonymous sign-in succeeded")
        } catch {
            let reference = Self.referenceSuffix(for: error)
            log.error("Anonymous sign-in failed\(reference, privacy: .public)")
            throw error
        }
    }

    private func startSessionEnrichment(token: String, generation: Int) {
        sessionEnrichmentTask?.cancel()
        let taskID = UUID()
        sessionEnrichmentTaskID = taskID
        sessionEnrichmentTask = Task { @MainActor [weak self] in
            guard let self else { return }
            try? await self.fetchUserInfo(token: token, expectedGeneration: generation)
            guard !Task.isCancelled else { return }
            if self.sessionEnrichmentTaskID == taskID {
                self.sessionEnrichmentTask = nil
                self.sessionEnrichmentTaskID = nil
            }
        }
    }

    func ensureAnonymousSession() async throws {
        if hasSession { return }
        if let anonymousSessionTask {
            try await anonymousSessionTask.value
            return
        }

        let task = Task { @MainActor [weak self] in
            guard let self else { throw AuthError.notAuthenticated }
            if !self.hasSession {
                try await self.signInAnonymously()
            }
        }
        let taskID = UUID()
        anonymousSessionTask = task
        anonymousSessionTaskID = taskID
        defer {
            if anonymousSessionTaskID == taskID {
                anonymousSessionTask = nil
                anonymousSessionTaskID = nil
            }
        }
        try await task.value
    }

    /// Generic OAuth flow via ASWebAuthenticationSession.
    /// Opens Better Auth's sign-in URL with callbackURL pointed at our mobile bridge.
    private func signInWithProvider(_ provider: String) async throws {
        let mergeToken = try await prepareAccountMerge(authMethod: provider)
        let generation = beginAuthentication()
        log.info("Starting OAuth flow for provider: \(provider)")
        do {
        var components = URLComponents(url: Config.apiBaseURL.appendingPathComponent("api/auth/mobile/start"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "provider", value: provider),
        ]
        if let mergeToken {
            components.queryItems?.append(URLQueryItem(name: "merge_token", value: mergeToken))
        }
        guard let signInURL = components.url else {
            throw AuthError.oauthFailed("Invalid sign-in URL")
        }

        let callbackURL = try await performWebAuth(url: signInURL)
        guard isCurrentAuthentication(generation) else { throw CancellationError() }
        log.debug("OAuth callback received for provider: \(provider)")
        try processAuthCallback(url: callbackURL)
        if !(await resumePendingAccountMerge()) {
            throw AuthError.oauthFailed("Account merge did not complete")
        }
        log.info("OAuth sign-in succeeded for \(provider)")
        } catch {
            let reference = Self.referenceSuffix(for: error)
            log.error("OAuth sign-in failed for \(provider)\(reference, privacy: .public)")
            throw error
        }
    }

    /// Revoke the active server session, then clear local state even if offline.
    func signOut() async {
        log.info("Signing out")
        signInMessage = nil
        if keychain[Self.accountMergeTargetKey] == nil {
            discardPendingAccountMerge()
        }
        guard let token = sessionToken else {
            clearSession()
            return
        }
        clearSession()

        let request = AuthenticatedRequest.withBearer(
            url: Config.apiBaseURL.appendingPathComponent("api/auth/sign-out"),
            token: token,
            method: "POST",
            body: Data("{}".utf8),
            contentType: "application/json"
        )
        do {
            let (data, response) = try await AuthenticatedRequest.data(
                for: request,
                session: Self.bearerSession,
                context: "Sign out",
                logger: log
            )
            try AuthenticatedRequest.validateHTTP(
                response,
                data: data,
                context: "Failed to revoke session",
                logger: log
            )
        } catch {
            let reference = Self.referenceSuffix(for: error)
            log.warning("Server sign-out failed; local session cleared\(reference, privacy: .public)")
        }
    }

    /// Clear a rejected session only if it is still the active session.
    @discardableResult
    func invalidateSession(rejectedToken: String, traceID: String? = nil) -> Bool {
        guard sessionToken == rejectedToken else { return false }
        let reference = AuthenticatedRequest.referenceSuffix(traceID: traceID)
        log.warning("Session invalidated\(reference, privacy: .public)")
        signInMessage = "Your session expired. Please sign in again."
        clearSession()
        return true
    }

    nonisolated static func isSameSession(currentToken: String?, initiatingToken: String) -> Bool {
        currentToken == initiatingToken
    }

    func consumeSignInMessage() -> String? {
        defer { signInMessage = nil }
        return signInMessage
    }

    func consumeDiscardedAccountID() -> String? {
        defer { discardedAccountID = nil }
        return discardedAccountID
    }

    private func clearSession() {
        authenticationGeneration += 1
        #if DEBUG
        usesUITestIdentity = false
        #endif
        resetSessionValidation()
        sessionEnrichmentTask?.cancel()
        sessionEnrichmentTask = nil
        sessionEnrichmentTaskID = nil
        anonymousSessionTask?.cancel()
        anonymousSessionTask = nil
        anonymousSessionTaskID = nil
        if let userId {
            discardedAccountID = userId
        }
        sessionToken = nil
        signedSessionToken = nil
        sessionExpiry = nil
        identity = .none
        userId = nil
        userName = nil
        userEmail = nil
        userImage = nil
        clearKeychain()
        clearAPICookies()
    }

    private func resetSessionValidation() {
        sessionValidationTask?.cancel()
        sessionValidationTask = nil
        sessionValidationID = nil
        lastSuccessfulSessionValidation = nil
    }

    // MARK: - Profile Updates

    /// Send name and image to Better Auth's update-user endpoint and persist on success.
    func updateProfile(name: String, image: String) async throws {
        let token = try validToken()
        try await updateProfile(name: name, image: image, token: token)
    }

    private func updateProfile(name: String, image: String, token: String) async throws {
        guard Self.isSameSession(currentToken: sessionToken, initiatingToken: token) else {
            throw AuthError.notAuthenticated
        }
        let url = Config.apiBaseURL.appendingPathComponent("api/auth/update-user")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(Config.apiBaseURL.absoluteString, forHTTPHeaderField: "Origin")

        let body: [String: String] = ["name": name.trimmingCharacters(in: .whitespacesAndNewlines), "image": image]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        AuthenticatedRequest.instrument(&request)

        let (_, response) = try await AuthenticatedRequest.data(
            for: request, session: Self.bearerSession,
            context: "Update profile", logger: log
        )
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            let http = response as? HTTPURLResponse
            let statusCode = http?.statusCode ?? 0
            let traceID = http.flatMap(AuthenticatedRequest.traceID(from:))
            let reference = AuthenticatedRequest.referenceSuffix(traceID: traceID)
            log.error("Profile update failed: HTTP \(statusCode)\(reference, privacy: .public)")
            if statusCode == 401 {
                invalidateSession(rejectedToken: token, traceID: traceID)
            }
            throw AuthError.oauthFailed(
                "Profile update failed (HTTP \(statusCode))",
                traceID: traceID
            )
        }

        guard Self.isSameSession(currentToken: sessionToken, initiatingToken: token) else { return }
        userName = name
        userImage = image
        persistSession()
    }

    /// Revoke linked providers, then permanently delete the account and its data.
    func deleteAccount() async throws -> Bool {
        log.info("Account deletion started")
        do {
        let token = try validToken()
        let url = Config.apiBaseURL.appendingPathComponent("api/auth/delete-account")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(Config.apiBaseURL.absoluteString, forHTTPHeaderField: "Origin")
        request.httpBody = Data("{}".utf8)
        AuthenticatedRequest.instrument(&request)

        let (data, response) = try await AuthenticatedRequest.data(
            for: request, session: Self.bearerSession,
            context: "Delete account", logger: log
        )
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            let http = response as? HTTPURLResponse
            let statusCode = http?.statusCode ?? 0
            let traceID = http.flatMap(AuthenticatedRequest.traceID(from:))
            if statusCode == 401 {
                invalidateSession(rejectedToken: token, traceID: traceID)
            }
            throw AuthError.oauthFailed(
                "Account deletion failed (HTTP \(statusCode))",
                traceID: traceID
            )
        }

        let result = try? JSONDecoder().decode(AccountDeletionResponse.self, from: data)
        log.info("Account deletion succeeded")
        return result?.manualAppleRevocationRequired ?? false
        } catch {
            let reference = Self.referenceSuffix(for: error)
            log.error("Account deletion failed\(reference, privacy: .public)")
            throw error
        }
    }

    private struct AccountDeletionResponse: Decodable {
        let manualAppleRevocationRequired: Bool
    }

    // MARK: - Passkey Flows

    /// Sign in with a passkey. Presents the system passkey sheet.
    func signInWithPasskey() async throws {
        var sourceSignedToken: String?
        if identity == .anonymous {
            if signedSessionToken == nil, let token = sessionToken {
                try await fetchUserInfo(token: token)
            }
            sourceSignedToken = signedSessionToken
        }
        try await prepareAccountMerge(authMethod: "passkey")
        let generation = beginAuthentication()
        log.info("Starting passkey sign-in")
        do {
        let service = PasskeyService()
        let result = try await service.authenticate(signedToken: sourceSignedToken)
        guard isCurrentAuthentication(generation) else { throw CancellationError() }

        resetSessionValidation()
        sessionToken = result.token
        signedSessionToken = result.signedToken
        sessionExpiry = result.expiresAt
        userId = result.user.id
        userName = result.user.name
        userEmail = result.user.email
        userImage = result.user.image
        identity = Self.sessionIdentity(isAnonymous: result.user.isAnonymous)
        persistSession()
        if !(await resumePendingAccountMerge()) {
            throw AuthError.oauthFailed("Account merge did not complete")
        }
        log.info("Passkey sign-in succeeded")
        } catch {
            let reference = Self.referenceSuffix(for: error)
            log.error("Passkey sign-in failed\(reference, privacy: .public)")
            throw error
        }
    }

    /// Sign up with one passkey ceremony, upgrading an anonymous session in place.
    func signUpWithPasskey() async throws {
        let generation = beginAuthentication()
        log.info("Starting passkey sign-up flow")
        do {
        if identity == .anonymous {
            guard let currentUserID = userId else { throw AuthError.notAuthenticated }
            if signedSessionToken == nil, let token = sessionToken {
                try await fetchUserInfo(token: token)
            }
            guard identity == .anonymous, userId == currentUserID else {
                throw AuthError.notAuthenticated
            }
        }
        try await prepareAccountMerge(authMethod: "passkey")
        let context = try Self.passkeyRegistrationContext(
            identity: identity,
            userID: userId,
            signedToken: signedSessionToken
        )
        let registrationToken: String?
        if case .upgrade(_, let signedToken) = context {
            registrationToken = signedToken
        } else {
            registrationToken = nil
        }

        let service = PasskeyService()
        let result = try await service.registerAccount(
            deviceName: UIDevice.current.model,
            displayName: identity == .anonymous ? userName : nil,
            signedToken: registrationToken
        )
        guard isCurrentAuthentication(generation) else { throw CancellationError() }
          if case .upgrade(let userID, _) = context,
              result.user.id != userID {
            throw AuthError.oauthFailed("Account upgrade returned a different user")
        }

        resetSessionValidation()
        sessionToken = result.token
        signedSessionToken = result.signedToken
        sessionExpiry = result.expiresAt
        userId = result.user.id
        userName = result.user.name
        userEmail = result.user.email
        userImage = result.user.image
        identity = Self.sessionIdentity(isAnonymous: result.user.isAnonymous)
        persistSession()
        clearAPICookies()
        try await fetchUserInfo(token: result.token)
        guard identity == .registered else {
            throw AuthError.oauthFailed("Passkey account upgrade did not complete")
        }
        if !(await resumePendingAccountMerge()) {
            throw AuthError.oauthFailed("Account merge did not complete")
        }
        log.info("Passkey sign-up succeeded")
        } catch {
            let reference = Self.referenceSuffix(for: error)
            log.error("Passkey sign-up failed\(reference, privacy: .public)")
            throw error
        }
    }

    /// Register a new passkey for the current user.
    func registerPasskey(name: String) async throws {
        let token = try validToken()
        // Ensure we have the signed token for passkey cookie auth
        if signedSessionToken == nil {
            try? await fetchUserInfo(token: token)
        }
        let service = PasskeyService()
        try await service.register(name: name, signedToken: signedSessionToken)
    }

    /// List the current user's passkeys.
    func listPasskeys() async throws -> [PasskeyService.PasskeyInfo] {
        let token = try validToken()
        if signedSessionToken == nil {
            try? await fetchUserInfo(token: token)
        }
        guard let signedToken = signedSessionToken else {
            throw AuthError.notAuthenticated
        }
        let service = PasskeyService()
        return try await service.listPasskeys(signedToken: signedToken)
    }

    /// Delete a passkey by ID.
    func deletePasskey(id: String) async throws {
        let token = try validToken()
        if signedSessionToken == nil {
            try? await fetchUserInfo(token: token)
        }
        guard let signedToken = signedSessionToken else {
            throw AuthError.notAuthenticated
        }
        let service = PasskeyService()
        try await service.deletePasskey(id: id, signedToken: signedToken)
    }

    /// Fetch user info from Better Auth's get-session endpoint.
    /// Uses Bearer token auth via the bearer() plugin.
    /// Also captures the signed session token for passkey endpoint cookies.
    private func fetchUserInfo(token: String, expectedGeneration: Int? = nil) async throws {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-test-delay-session-enrichment") {
            try await Task.sleep(for: .seconds(60))
        }
        #endif
        let url = Config.apiBaseURL.appendingPathComponent("api/auth/get-session")
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 5
        AuthenticatedRequest.instrument(&request)

        let (data, response) = try await AuthenticatedRequest.data(
            for: request, session: Self.bearerSession,
            context: "Fetch user info", logger: log
        )

        guard let httpResponse = response as? HTTPURLResponse else {
            log.warning("fetchUserInfo: non-HTTP response, skipping user-info enrichment")
            return
        }
        guard httpResponse.statusCode == 200 else {
            let reference = AuthenticatedRequest.referenceSuffix(
                traceID: AuthenticatedRequest.traceID(from: httpResponse)
            )
            log.warning("fetchUserInfo: HTTP \(httpResponse.statusCode)\(reference, privacy: .public)")
            return
        }
                guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["user"] is [String: Any]
        else {
            log.warning("fetchUserInfo: response 200 but body could not be decoded as { user: ... }")
            return
        }

        if let expectedGeneration,
           !Self.isSameAuthenticationGeneration(
            current: authenticationGeneration,
            expected: expectedGeneration
           ) {
            return
        }

        guard applySessionMetadata(data: data, response: httpResponse, token: token) else {
            log.warning("fetchUserInfo: response 200 but session metadata was incomplete")
            return
        }
    }

    /// Get a valid session token for API requests.
    /// Attach as `Authorization: Bearer <token>`.
    func validToken() throws -> String {
        guard let token = sessionToken else {
            clearSession()
            throw AuthError.notAuthenticated
        }
        return token
    }

    func validToken(forAccountID expectedAccountID: String?) throws -> String {
        if let expectedAccountID,
           !Self.isSameAccount(currentAccountID: userId, expectedAccountID: expectedAccountID) {
            throw AuthError.notAuthenticated
        }
        return try validToken()
    }

    /// Stage a server-side merge of the current anonymous account. Only the web OAuth flow
    /// consumes the returned token; native flows carry the session bearer and let
    /// `resumePendingAccountMerge` finish the job.
    @discardableResult
    private func prepareAccountMerge(authMethod: String) async throws -> String? {
        guard identity == .anonymous else { return nil }
        let token = try validToken()
        let body = try JSONSerialization.data(withJSONObject: ["authMethod": authMethod])
        let request = AuthenticatedRequest.withBearer(
            url: Config.apiBaseURL.appendingPathComponent("api/auth/merge/prepare"),
            token: token,
            method: "POST",
            body: body,
            contentType: "application/json"
        )
        let (data, response) = try await AuthenticatedRequest.data(
            for: request,
            session: Self.bearerSession,
            context: "Prepare account merge",
            logger: log
        )
        try AuthenticatedRequest.validateHTTP(
            response,
            data: data,
            context: "Could not prepare account merge",
            logger: log
        )
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let mergeToken = json["token"] as? String,
              mergeToken.count >= 32
        else { throw AuthError.oauthFailed("Invalid account merge response") }
        keychain[Self.accountMergeTokenKey] = mergeToken
        keychain[Self.accountMergeTargetKey] = nil
        return mergeToken
    }

    func resumePendingAccountMerge() async -> Bool {
        let mergeToken = keychain[Self.accountMergeTokenKey]
        guard identity == .registered, let currentUserID = userId else { return false }
        if mergeToken != nil {
            if let targetUserID = keychain[Self.accountMergeTargetKey],
               targetUserID != currentUserID {
                accountMergeState = .none
                return false
            }
            keychain[Self.accountMergeTargetKey] = currentUserID
        }
        accountMergeState = .finalizing
        do {
            let token = try validToken()
            let body = if let mergeToken {
                try JSONSerialization.data(withJSONObject: ["token": mergeToken])
            } else {
                Data("{}".utf8)
            }
            let request = AuthenticatedRequest.withBearer(
                url: Config.apiBaseURL.appendingPathComponent("api/auth/merge/finalize"),
                token: token,
                method: "POST",
                body: body,
                contentType: "application/json"
            )
            let (data, response) = try await AuthenticatedRequest.data(
                for: request,
                session: Self.bearerSession,
                context: "Finalize account merge",
                logger: log
            )
            try AuthenticatedRequest.validateHTTP(
                response,
                data: data,
                context: "Could not finalize account merge",
                logger: log
            )
            if mergeToken != nil {
                keychain[Self.accountMergeTokenKey] = nil
                keychain[Self.accountMergeTargetKey] = nil
            }
            accountMergeState = .none
            return true
        } catch {
            accountMergeState = .failed
            let reference = Self.referenceSuffix(for: error)
            log.error("Account merge finalization failed; source preserved\(reference, privacy: .public)")
            return false
        }
    }

    private func discardPendingAccountMerge() {
        keychain[Self.accountMergeTokenKey] = nil
        keychain[Self.accountMergeTargetKey] = nil
        accountMergeState = .none
    }

    nonisolated static func isSameAccount(currentAccountID: String?, expectedAccountID: String) -> Bool {
        currentAccountID == expectedAccountID
    }

    private func isCurrentSession(token: String) -> Bool {
        Self.isSameSession(currentToken: sessionToken, initiatingToken: token)
    }

    // MARK: - ASWebAuthenticationSession

    @MainActor
    private func performWebAuth(url: URL) async throws -> URL {
        guard let contextProvider = AuthenticationPresentationContextProvider.active() else {
            throw AuthError.oauthFailed("No active window is available for sign-in")
        }
        webAuthContext = contextProvider
        defer { webAuthContext = nil }

        return try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: url,
                callback: .customScheme(Config.oauthCallbackScheme)
            ) { url, error in
                if let error {
                    continuation.resume(throwing: AuthError.oauthFailed(error.localizedDescription))
                } else if let url {
                    continuation.resume(returning: url)
                } else {
                    continuation.resume(throwing: AuthError.oauthFailed("No callback URL"))
                }
            }
            // Use non-ephemeral so OAuth cookies persist across the redirect chain
            session.prefersEphemeralWebBrowserSession = false
            session.presentationContextProvider = contextProvider
            session.start()
        }
    }

    private var webAuthContext: AuthenticationPresentationContextProvider?

    // MARK: - Callback Processing

    /// Parsed result from an OAuth callback URL.
    struct CallbackResult {
        let token: String
        let signedToken: String?
        let expiry: Date
        let userId: String?
        let userName: String?
        let userEmail: String?
        let userImage: String?
    }

    /// Parse the wingdex://auth/callback?token=...&user_id=... redirect URL.
    /// Extracted as a static method for testability.
    nonisolated static func parseCallbackURL(_ url: URL) throws -> CallbackResult {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw AuthError.oauthFailed("Invalid callback URL")
        }

        let params = Dictionary(
            uniqueKeysWithValues: (components.queryItems ?? []).compactMap { item in
                item.value.map { (item.name, $0) }
            }
        )

        if let error = params["error"] {
            throw AuthError.oauthFailed(error)
        }

        guard let token = params["token"],
              let expiresAt = params["expires_at"]
        else {
            throw AuthError.oauthFailed("Missing token in callback")
        }

        guard let expiry = Self.parseISO8601(expiresAt) else {
            throw AuthError.oauthFailed("Invalid expiry date")
        }

        return CallbackResult(
            token: token,
            signedToken: params["signed_token"],
            expiry: expiry,
            userId: params["user_id"],
            userName: params["user_name"],
            userEmail: params["user_email"],
            userImage: params["user_image"]
        )
    }

    /// Parse an ISO 8601 date string, trying with fractional seconds first.
    nonisolated static func parseISO8601(_ string: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: string) { return date }
        let basic = ISO8601DateFormatter()
        return basic.date(from: string)
    }

    private func processAuthCallback(url: URL) throws {
        log.info("Processing callback (\(url.host ?? "?"))")
        let result = try Self.parseCallbackURL(url)

        resetSessionValidation()
        sessionToken = result.token
        signedSessionToken = result.signedToken
        sessionExpiry = result.expiry
        userId = result.userId
        userName = result.userName
        userEmail = result.userEmail
        userImage = result.userImage
        identity = .registered

        persistSession()
        clearAPICookies()
    }

    /// Parse Better Auth's JSON response from sign-in/social with idToken.
    /// Response shape: { token: string, user: { id, name, email, image, ... } }
    ///
    /// With the bearer() plugin, the server also sets a `set-auth-token` response
    /// header containing the session token. We prefer that, falling back to the
    /// raw `token` field from the JSON body.
    @discardableResult
    private func processTokenResponse(data: Data, response: URLResponse? = nil) throws -> String {
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw AuthError.oauthFailed("Invalid token response")
        }

        guard let rawToken = json["token"] as? String,
              let user = json["user"] as? [String: Any],
              let userID = user["id"] as? String,
              let isAnonymous = user["isAnonymous"] as? Bool
        else {
            throw AuthError.oauthFailed("Incomplete session response")
        }

        resetSessionValidation()

        // Signed token from set-auth-token header - used for cookie auth on passkey endpoints
        if let httpResponse = response as? HTTPURLResponse,
           let signed = httpResponse.value(forHTTPHeaderField: "set-auth-token") {
            signedSessionToken = signed
        }

        self.sessionToken = rawToken
        sessionExpiry = nil
        userId = userID
        userName = user["name"] as? String
        userEmail = user["email"] as? String
        userImage = user["image"] as? String
        identity = Self.sessionIdentity(isAnonymous: isAnonymous)

        persistSession()
        // Clear cookies set by sign-in so URLSession doesn't send them
        // alongside Bearer headers on subsequent API requests.
        clearAPICookies()
        return rawToken
    }

    struct SessionMetadata {
        let expiresAt: Date
        let user: PasskeyService.UserResult
    }

    nonisolated static func decodeSessionMetadata(data: Data) -> SessionMetadata? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let session = json["session"] as? [String: Any],
              let user = json["user"] as? [String: Any],
                            let userID = user["id"] as? String,
                            let isAnonymous = user["isAnonymous"] as? Bool,
                            let expiresAtString = session["expiresAt"] as? String,
                            let expiresAt = Self.parseISO8601(expiresAtString)
        else { return nil }

        return SessionMetadata(
                        expiresAt: expiresAt,
            user: PasskeyService.UserResult(
                id: userID,
                name: user["name"] as? String,
                email: user["email"] as? String,
                image: user["image"] as? String,
                isAnonymous: isAnonymous
            )
        )
    }

    private func applySessionMetadata(
        data: Data,
        response: HTTPURLResponse,
        token: String
    ) -> Bool {
        guard isCurrentSession(token: token),
              let metadata = Self.decodeSessionMetadata(data: data)
        else { return false }

        sessionExpiry = metadata.expiresAt
        userId = metadata.user.id
        userName = metadata.user.name
        userEmail = metadata.user.email
        userImage = metadata.user.image
        identity = Self.sessionIdentity(isAnonymous: metadata.user.isAnonymous)
        if let signed = response.value(forHTTPHeaderField: "set-auth-token") {
            signedSessionToken = signed
        }
        persistSession()
        return true
    }

    // MARK: - Keychain Persistence

    private func persistSession() {
        keychain[Self.tokenKey] = sessionToken
        keychain[Self.signedTokenKey] = signedSessionToken
        keychain[Self.expiryKey] = sessionExpiry?.ISO8601Format()
        keychain[Self.userIdKey] = userId
        keychain[Self.userNameKey] = userName
        keychain[Self.userEmailKey] = userEmail
        keychain[Self.userImageKey] = userImage
        keychain[Self.identityKey] = identity.rawValue
    }

    private func restoreSession() {
        guard let token = keychain[Self.tokenKey],
              let userID = keychain[Self.userIdKey],
              let identityValue = keychain[Self.identityKey],
              let restoredIdentity = SessionIdentity(rawValue: identityValue)
        else {
            clearKeychain()
            return
        }

        sessionToken = token
        signedSessionToken = keychain[Self.signedTokenKey]
        sessionExpiry = keychain[Self.expiryKey].flatMap(Self.parseISO8601)
        userId = userID
        userName = keychain[Self.userNameKey]
        userEmail = keychain[Self.userEmailKey]
        userImage = keychain[Self.userImageKey]
        identity = restoredIdentity

        // Clear stale cookies so URLSession doesn't send them alongside
        // the Bearer header. Stale cookies can cause 401 if Better Auth
        // checks them before the Bearer token.
        clearAPICookies()
    }

    private func clearKeychain() {
        keychain[Self.tokenKey] = nil
        keychain[Self.signedTokenKey] = nil
        keychain[Self.expiryKey] = nil
        keychain[Self.userIdKey] = nil
        keychain[Self.userNameKey] = nil
        keychain[Self.userEmailKey] = nil
        keychain[Self.userImageKey] = nil
        keychain[Self.identityKey] = nil
    }

    nonisolated static func sessionIdentity(isAnonymous: Bool) -> SessionIdentity {
        isAnonymous ? .anonymous : .registered
    }

    nonisolated static func passkeyRegistrationContext(
        identity: SessionIdentity,
        userID: String?,
        signedToken: String?
    ) throws -> PasskeyRegistrationContext {
        guard identity == .anonymous else { return .sessionless }
        guard let userID, let signedToken else { throw AuthError.notAuthenticated }
        return .upgrade(userID: userID, signedToken: signedToken)
    }

    nonisolated static func isSameAuthenticationGeneration(
        current: Int,
        expected: Int
    ) -> Bool {
        current == expected
    }

    private func beginAuthentication() -> Int {
        authenticationGeneration += 1
        sessionEnrichmentTask?.cancel()
        sessionEnrichmentTask = nil
        sessionEnrichmentTaskID = nil
        return authenticationGeneration
    }

    private func isCurrentAuthentication(_ generation: Int) -> Bool {
        Self.isSameAuthenticationGeneration(
            current: authenticationGeneration,
            expected: generation
        )
    }

    /// Remove cookies for the API domain so URLSession doesn't send stale session cookies.
    private func clearAPICookies() {
        guard let cookies = HTTPCookieStorage.shared.cookies(for: Config.apiBaseURL) else { return }
        for cookie in cookies {
            HTTPCookieStorage.shared.deleteCookie(cookie)
        }
    }
}

@MainActor
final class AuthenticationPresentationContextProvider: NSObject,
    ASWebAuthenticationPresentationContextProviding,
    ASAuthorizationControllerPresentationContextProviding
{
    private let anchor: ASPresentationAnchor

    static func active() -> AuthenticationPresentationContextProvider? {
        let activeScenes = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .filter { $0.activationState == .foregroundActive }

        guard let anchor = activeScenes.lazy.compactMap({ scene in
            scene.windows.first(where: { $0.isKeyWindow })
                ?? scene.windows.first(where: {
                    !$0.isHidden && $0.alpha > 0 && $0.windowLevel == .normal
                })
        }).first else {
            return nil
        }

        return AuthenticationPresentationContextProvider(anchor: anchor)
    }

    private init(anchor: ASPresentationAnchor) {
        self.anchor = anchor
        super.init()
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        anchor
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        anchor
    }
}

enum AuthError: LocalizedError {
    case notAuthenticated
    case oauthFailed(String, traceID: String? = nil)

    var errorDescription: String? {
        switch self {
        case .notAuthenticated:
            "Not authenticated"
        case .oauthFailed(let message, _):
            "Log in failed: \(message)"
        }
    }

    var traceID: String? {
        guard case .oauthFailed(_, let traceID) = self else { return nil }
        return traceID
    }
}

// MARK: - Apple Sign-In Delegate

/// Bridges the delegate-based ASAuthorizationController flow into async/await
/// via CheckedContinuation. Retained by AuthService until the flow completes.
private final class AppleSignInHandler: NSObject, ASAuthorizationControllerDelegate, @unchecked Sendable {
    private var continuation: CheckedContinuation<ASAuthorizationAppleIDCredential, Error>?

    init(continuation: CheckedContinuation<ASAuthorizationAppleIDCredential, Error>) {
        self.continuation = continuation
    }

    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
            continuation?.resume(throwing: AuthError.oauthFailed("Unexpected credential type"))
            continuation = nil
            return
        }
        continuation?.resume(returning: credential)
        continuation = nil
    }

    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithError error: Error
    ) {
        continuation?.resume(throwing: error)
        continuation = nil
    }
}
