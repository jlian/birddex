import AuthenticationServices
import Foundation
import os
import UIKit

private let log = Logger(subsystem: Config.bundleID, category: "Passkey")

/// Handles WebAuthn passkey operations against Better Auth's passkey plugin.
///
/// The two-step challenge flow (generate-options then verify) uses a signed cookie
/// to bind the challenge. This service manually extracts that cookie from the first
/// response and forwards it to the verification request so we don't depend on
/// URLSession's automatic cookie storage.
///
/// For authenticated endpoints (registration, list, delete) the session token is
/// sent as an `Authorization: Bearer` header, validated by Better Auth's bearer plugin.
final class PasskeyService: NSObject, @unchecked Sendable {

    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpShouldSetCookies = false
        return URLSession(configuration: configuration)
    }()

    // MARK: - Public Types

    struct UserResult: Sendable {
        let id: String
        let name: String?
        let email: String?
        let image: String?
        let isAnonymous: Bool
    }

    struct AuthResult {
        let token: String
        let signedToken: String?
        let user: UserResult
        let expiresAt: Date

        var userId: String { user.id }
    }

    struct PasskeyInfo: Decodable, Identifiable {
        let id: String
        let name: String?
        let credentialID: String
        let createdAt: String
    }

    // MARK: - Authentication (Sign In)

    /// Perform a full passkey authentication:
    /// 1. Fetch challenge options from the server
    /// 2. Present the system passkey sheet
    /// 3. Verify the assertion with the server
    /// Returns a session token on success.
    func authenticate() async throws -> AuthResult {
        // Step 1 - Fetch authentication options (no auth needed - user not signed in yet)
        let optionsURL = Config.apiBaseURL.appendingPathComponent("api/auth/passkey/generate-authenticate-options")
        var optionsRequest = URLRequest(url: optionsURL)
        optionsRequest.setValue(Config.apiBaseURL.absoluteString, forHTTPHeaderField: "Origin")
        AuthenticatedRequest.instrument(&optionsRequest)

        let (optionsData, optionsResponse) = try await AuthenticatedRequest.data(
            for: optionsRequest, session: Self.session,
            context: "Passkey authentication options", logger: log
        )

        let httpResponse = try AuthenticatedRequest.validateHTTP(
            optionsResponse, data: optionsData,
            context: "Failed to get authentication options", logger: log
        )

        let challengeCookies = AuthenticatedRequest.extractCookies(from: httpResponse, for: optionsURL)
        let options = try JSONDecoder().decode(AuthenticationOptions.self, from: optionsData)

        guard let challengeData = Data(base64URLEncoded: options.challenge) else {
            throw PasskeyError.invalidChallenge
        }

        // Step 2 - Platform passkey assertion
        let assertion = try await performAssertion(
            challenge: challengeData,
            rpId: Config.rpID,
            allowCredentials: options.allowCredentials
        )

        // Step 3 - Verify assertion with server (no session token - user authenticating)
        let verifyURL = Config.apiBaseURL.appendingPathComponent("api/auth/passkey/verify-authentication")
        let credentialID = assertion.credentialID.base64URLEncodedString()
        let body: [String: Any] = [
            "response": [
                "id": credentialID,
                "rawId": credentialID,
                "type": "public-key",
                "response": [
                    "clientDataJSON": assertion.rawClientDataJSON.base64URLEncodedString(),
                    "authenticatorData": assertion.rawAuthenticatorData.base64URLEncodedString(),
                    "signature": assertion.signature.base64URLEncodedString(),
                    "userHandle": assertion.userID.base64URLEncodedString(),
                ] as [String: Any],
                "authenticatorAttachment": "platform",
                "clientExtensionResults": [String: Any](),
            ] as [String: Any],
        ]
        var verifyRequest = URLRequest(url: verifyURL)
        verifyRequest.httpMethod = "POST"
        verifyRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        verifyRequest.setValue(Config.apiBaseURL.absoluteString, forHTTPHeaderField: "Origin")
        if let cookies = challengeCookies {
            verifyRequest.setValue(cookies, forHTTPHeaderField: "Cookie")
        }
        verifyRequest.httpBody = try JSONSerialization.data(withJSONObject: body)
        AuthenticatedRequest.instrument(&verifyRequest)

        let (verifyData, verifyResponse) = try await AuthenticatedRequest.data(
            for: verifyRequest, session: Self.session,
            context: "Passkey authentication verify", logger: log
        )

        let verifyHttp = try AuthenticatedRequest.validateHTTP(
            verifyResponse, data: verifyData,
            context: "Passkey authentication failed", logger: log
        )

        return try Self.decodeAuthResult(data: verifyData, response: verifyHttp)
    }

    // MARK: - Registration (Add Passkey)

    func registerAccount(
        deviceName: String,
        displayName: String?,
        signedToken: String?
    ) async throws -> AuthResult {
        guard let result = try await registerPasskey(
            name: nil,
            accountDeviceName: deviceName,
            signedToken: signedToken,
            displayName: displayName,
            createSession: true
        ), result.signedToken != nil else {
            throw PasskeyError.invalidResponse
        }
        return result
    }

    /// Register a new passkey for the currently authenticated user.
    /// - signedToken: HMAC-signed token for cookie auth on passkey verify endpoint
    /// - displayName: Override for the Keychain "User Name" field (defaults to server value)
    func register(name: String, signedToken: String?, displayName: String? = nil) async throws {
        _ = try await registerPasskey(
            name: name,
            accountDeviceName: nil,
            signedToken: signedToken,
            displayName: displayName,
            createSession: false
        )
    }

    private func registerPasskey(
        name: String?,
        accountDeviceName: String?,
        signedToken: String?,
        displayName: String?,
        createSession: Bool
    ) async throws -> AuthResult? {
        log.info("Passkey registration started")
        do {
        if !createSession && signedToken == nil {
            throw PasskeyError.serverError(
                "Missing signed session token for passkey registration",
                traceID: nil
            )
        }

        // Step 1 - Fetch registration options (cookie-only, no Bearer)
        // Passkey plugin endpoints use internal cookie session validation.
        // Mixing Bearer + cookies causes 401 on HTTPS.
        var components = URLComponents(
            url: Config.apiBaseURL.appendingPathComponent("api/auth/passkey/generate-register-options"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [
            URLQueryItem(name: "authenticatorAttachment", value: "platform"),
        ]
        let optionsURL = components.url!
        let optionsRequest = AuthenticatedRequest.withCookieOnly(url: optionsURL, signedToken: signedToken)

        let (optionsData, optionsResponse) = try await AuthenticatedRequest.data(
            for: optionsRequest, session: Self.session,
            context: "Passkey registration options", logger: log
        )

        let httpResponse = try AuthenticatedRequest.validateHTTP(
            optionsResponse, data: optionsData,
            context: "Failed to get registration options", logger: log
        )

        let challengeCookies = AuthenticatedRequest.extractCookies(from: httpResponse, for: optionsURL)
        log.info("Registration options received, challenge cookie: \(challengeCookies != nil)")
        let options = try JSONDecoder().decode(RegistrationOptions.self, from: optionsData)
        let credentialDisplayName = displayName ?? options.user.displayName
        let resolvedName: String
        if let name {
            resolvedName = name
        } else if let accountDeviceName {
            resolvedName = Self.accountPasskeyName(
                deviceName: accountDeviceName,
                displayName: credentialDisplayName
            )
        } else {
            throw PasskeyError.invalidResponse
        }

        guard let challengeData = Data(base64URLEncoded: options.challenge) else {
            throw PasskeyError.invalidChallenge
        }
        guard let userIDData = Data(base64URLEncoded: options.user.id) else {
            throw PasskeyError.invalidChallenge
        }

        // Step 2 - Platform passkey registration
        let registration = try await performRegistration(
            challenge: challengeData,
            rpId: options.rp.id,
            userName: credentialDisplayName,
            userID: userIDData
        )

        // Step 3 - Verify registration (cookie-only + challenge cookie)
        let verifyURL = Config.apiBaseURL.appendingPathComponent("api/auth/passkey/verify-registration")
        let credentialID = registration.credentialID.base64URLEncodedString()
        let registrationBody: [String: Any] = [
            "response": [
                "id": credentialID,
                "rawId": credentialID,
                "type": "public-key",
                "response": [
                    "clientDataJSON": registration.rawClientDataJSON.base64URLEncodedString(),
                    "attestationObject": (registration.rawAttestationObject ?? Data()).base64URLEncodedString(),
                    "transports": ["internal"],
                ] as [String: Any],
                "authenticatorAttachment": "platform",
                "clientExtensionResults": [String: Any](),
            ] as [String: Any],
            "name": resolvedName,
            "createSession": createSession,
        ]
        let verifyRequest = AuthenticatedRequest.withCookieOnly(
            url: verifyURL,
            signedToken: signedToken,
            additionalCookies: challengeCookies,
            method: "POST",
            body: try JSONSerialization.data(withJSONObject: registrationBody),
            contentType: "application/json"
        )
        log.debug("Verify request: challenge=\(challengeCookies != nil)")

        let (verifyData, verifyResponse) = try await AuthenticatedRequest.data(
            for: verifyRequest, session: Self.session,
            context: "Passkey registration verify", logger: log
        )

        let verifyHTTP = try AuthenticatedRequest.validateHTTP(
            verifyResponse, data: verifyData,
            context: "Passkey registration failed", logger: log
        )
        log.info("Passkey registration succeeded")
        return createSession
            ? try Self.decodeAuthResult(data: verifyData, response: verifyHTTP)
            : nil
        } catch {
            let reference = AuthenticatedRequest.referenceSuffix(
                traceID: (error as? PasskeyError)?.traceID
            )
            log.error("Passkey registration failed\(reference, privacy: .public)")
            throw error
        }
    }

    nonisolated static func decodeAuthResult(
        data: Data,
        response: HTTPURLResponse
    ) throws -> AuthResult {
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let session = json["session"] as? [String: Any],
              let user = json["user"] as? [String: Any],
              let token = session["token"] as? String,
              let userID = user["id"] as? String,
              let isAnonymous = user["isAnonymous"] as? Bool,
              let expiresAtString = session["expiresAt"] as? String,
              let expiresAt = AuthService.parseISO8601(expiresAtString)
        else {
            throw PasskeyError.invalidResponse
        }

        return AuthResult(
            token: token,
            signedToken: response.value(forHTTPHeaderField: "set-auth-token"),
            user: UserResult(
                id: userID,
                name: user["name"] as? String,
                email: user["email"] as? String,
                image: user["image"] as? String,
                isAnonymous: isAnonymous
            ),
            expiresAt: expiresAt
        )
    }

    nonisolated static func accountPasskeyName(
        deviceName: String,
        displayName: String
    ) -> String {
        "\(deviceName) (\(displayName))"
    }

    // MARK: - List Passkeys

    func listPasskeys(signedToken: String) async throws -> [PasskeyInfo] {
        let url = Config.apiBaseURL.appendingPathComponent("api/auth/passkey/list-user-passkeys")
        let request = AuthenticatedRequest.withCookieOnly(url: url, signedToken: signedToken)

        let (data, response) = try await AuthenticatedRequest.data(
            for: request, session: Self.session,
            context: "List passkeys", logger: log
        )

        try AuthenticatedRequest.validateHTTP(
            response, data: data,
            context: "Failed to list passkeys", logger: log
        )

        return try JSONDecoder().decode([PasskeyInfo].self, from: data)
    }

    // MARK: - Delete Passkey

    func deletePasskey(id: String, signedToken: String) async throws {
        log.info("Passkey deletion started")
        do {
        let url = Config.apiBaseURL.appendingPathComponent("api/auth/passkey/delete-passkey")
        let request = AuthenticatedRequest.withCookieOnly(
            url: url,
            signedToken: signedToken,
            method: "POST",
            body: try JSONSerialization.data(withJSONObject: ["id": id]),
            contentType: "application/json"
        )

        let (data, response) = try await AuthenticatedRequest.data(
            for: request, session: Self.session,
            context: "Delete passkey", logger: log
        )

        try AuthenticatedRequest.validateHTTP(
            response, data: data,
            context: "Failed to delete passkey", logger: log
        )
        log.info("Passkey deletion succeeded")
        } catch {
            let reference = AuthenticatedRequest.referenceSuffix(
                traceID: (error as? PasskeyError)?.traceID
            )
            log.error("Passkey deletion failed\(reference, privacy: .public)")
            throw error
        }
    }

    // MARK: - ASAuthorizationController Bridge

    private var authContinuation: CheckedContinuation<ASAuthorization, Error>?
    private var activeController: ASAuthorizationController?
    private var presentationContext: AuthenticationPresentationContextProvider?
    // Prevent premature deallocation while the authorization sheet is shown.
    // ASAuthorizationController holds its delegate weakly.
    private var selfRetain: PasskeyService?

    @MainActor
    private func performAssertion(
        challenge: Data,
        rpId: String,
        allowCredentials: [WebAuthnCredential]?
    ) async throws -> ASAuthorizationPlatformPublicKeyCredentialAssertion {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
        let request = provider.createCredentialAssertionRequest(challenge: challenge)

        if let allowCredentials {
            request.allowedCredentials = allowCredentials.compactMap { cred in
                guard let idData = Data(base64URLEncoded: cred.id) else { return nil }
                return ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: idData)
            }
        }

        let authorization = try await requestAuthorization(requests: [request])

        guard let assertion = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
            throw PasskeyError.unexpectedCredentialType
        }
        return assertion
    }

    @MainActor
    private func performRegistration(
        challenge: Data,
        rpId: String,
        userName: String,
        userID: Data
    ) async throws -> ASAuthorizationPlatformPublicKeyCredentialRegistration {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
        let request = provider.createCredentialRegistrationRequest(
            challenge: challenge,
            name: userName,
            userID: userID
        )

        let authorization = try await requestAuthorization(requests: [request])

        guard let registration = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration else {
            throw PasskeyError.unexpectedCredentialType
        }
        return registration
    }

    @MainActor
    private func requestAuthorization(requests: [ASAuthorizationRequest]) async throws -> ASAuthorization {
        guard let presentationContext = AuthenticationPresentationContextProvider.active() else {
            throw PasskeyError.presentationUnavailable
        }

        return try await withCheckedThrowingContinuation { continuation in
            self.selfRetain = self
            self.authContinuation = continuation
            self.presentationContext = presentationContext
            let controller = ASAuthorizationController(authorizationRequests: requests)
            self.activeController = controller
            controller.delegate = self
            controller.presentationContextProvider = presentationContext
            controller.performRequests()
        }
    }

    // MARK: - Decodable Models

    private struct AuthenticationOptions: Decodable {
        let challenge: String
        let allowCredentials: [WebAuthnCredential]?
    }

    private struct RegistrationOptions: Decodable {
        let challenge: String
        let rp: RP
        let user: User

        struct RP: Decodable {
            let name: String
            let id: String
        }

        struct User: Decodable {
            let id: String
            let name: String
            let displayName: String
        }
    }

    struct WebAuthnCredential: Decodable {
        let id: String
        let type: String?
        let transports: [String]?
    }
}

// MARK: - ASAuthorizationControllerDelegate

extension PasskeyService: ASAuthorizationControllerDelegate {
    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        authContinuation?.resume(returning: authorization)
        authContinuation = nil
        activeController = nil
        presentationContext = nil
        selfRetain = nil
    }

    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithError error: Error
    ) {
        authContinuation?.resume(throwing: error)
        authContinuation = nil
        activeController = nil
        presentationContext = nil
        selfRetain = nil
    }
}

// MARK: - Errors

enum PasskeyError: LocalizedError {
    case serverError(String, traceID: String? = nil)
    case invalidChallenge
    case invalidResponse
    case authenticationFailed
    case registrationFailed
    case presentationUnavailable
    case unexpectedCredentialType

    var errorDescription: String? {
        switch self {
        case .serverError(let message, _): message
        case .invalidChallenge: "Invalid challenge from server"
        case .invalidResponse: "Invalid response from server"
        case .authenticationFailed: "Passkey authentication failed"
        case .registrationFailed: "Passkey registration failed"
        case .presentationUnavailable: "No active window is available for passkey authentication"
        case .unexpectedCredentialType: "Unexpected credential type"
        }
    }

    var traceID: String? {
        guard case .serverError(_, let traceID) = self else { return nil }
        return traceID
    }
}
