import XCTest

extension XCUIElement {
    /// XCTest's predicate waiter checks on an approximately one-second cadence.
    /// Take one current snapshot first so already-satisfied state does not pay
    /// that delay, then retain XCTest's native synchronization for real waits.
    func existsOrWait(timeout: TimeInterval) -> Bool {
        exists || waitForExistence(timeout: timeout)
    }

    func disappearsOrWait(timeout: TimeInterval) -> Bool {
        !exists || waitForNonExistence(timeout: timeout)
    }

    func isEnabledOrWait(timeout: TimeInterval) -> Bool {
        isEnabled || wait(for: \.isEnabled, toEqual: true, timeout: timeout)
    }
}

/// Shared fixtures, launch helpers, and accessibility-audit plumbing for the
/// add-photos UI tests. Split into a base class so the audit tests can live in
/// their own XCTestCase: XCTest parallelizes by class, not by method, so a
/// single class always runs on one worker.
@MainActor
class BirdIdFlowUITestCase: XCTestCase {
    /// A shared fixture, also used by BirdIdAccuracyTests and the web tests. Read from
    /// the repo rather than the app bundle so it never ships inside the app.
    static let photo = "Great_blue_heron_roosting_at_Carkeek_Park.jpg"
    static let expectedSpecies = "Great Blue Heron"
    static let avatarEmojiLabels: Set<String> = ["🐦", "🦉", "🦜", "🐧", "🦆", "🦩", "🦅", "🐤"]

    nonisolated var configuredAPIBaseURLValue: String? {
        ProcessInfo.processInfo.environment["API_BASE_URL"]
    }

    nonisolated var configuredAPIBaseURL: URL? {
        guard let value = configuredAPIBaseURLValue,
              let url = URL(string: value),
              let scheme = url.scheme?.lowercased(),
              ["http", "https"].contains(scheme),
              url.host != nil
        else { return nil }
        return url
    }

    var apiBaseURL: URL {
        configuredAPIBaseURL ?? URL(string: "http://127.0.0.1:5000")!
    }

    static var photoPath: String {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("src/assets/images/\(photo)")
            .path
    }

    static var seedCSVPath: String {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("e2e/fixtures/ebird-import.csv")
            .path
    }

    /// Stop at the first failure. Later steps wait up to 180s for the model, so letting a
    /// failed run continue turns one broken assertion into minutes of dead waiting.
    override func setUp() {
        continueAfterFailure = false
        if configuredAPIBaseURLValue != nil {
            XCTAssertNotNil(configuredAPIBaseURL, "API_BASE_URL must be an absolute HTTP(S) URL")
        }
    }

    func scrollUntilVisible(
        _ element: XCUIElement,
        in app: XCUIApplication,
        maximumSwipes: Int = 3
    ) -> Bool {
        for _ in 0..<maximumSwipes {
            if element.exists && element.isHittable { return true }
            app.swipeUp()
        }
        return element.exists && element.isHittable
    }

    /// The outing location is an editable field, so its text lives in `value`, not `label`.
    func locationValue(_ field: XCUIElement) -> String {
        field.value as? String ?? ""
    }

    func runAccessibilityAudit(
        in app: XCUIApplication,
        for auditTypes: XCUIAccessibilityAuditType = .all,
        handlingKnownIssue: ((XCUIAccessibilityAuditIssue) -> Bool)? = nil
    ) throws {
        do {
            try app.performAccessibilityAudit(for: auditTypes) { issue in
                handlingKnownIssue?(issue) ?? false
            }
        } catch {
            if Self.isAccessibilityAuditInfrastructureTimeout(error) {
                XCTFail("XCTest accessibility audit infrastructure timed out before reporting results (Code=-56)")
                return
            }
            throw error
        }
    }

    nonisolated static func isAccessibilityAuditInfrastructureTimeout(
        _ error: Error
    ) -> Bool {
        let auditError = error as NSError
        return auditError.domain == "com.apple.xcode.xctest.accessibilityAudit"
            && auditError.code == -56
    }

    func isKnownAddPhotosAuditIssue(_ issue: XCUIAccessibilityAuditIssue) -> Bool {
        switch issue.auditType {
        case .contrast:
            return issue.element == nil && issue.compactDescription == "Contrast nearly passed"
        case .dynamicType:
            return issue.element?.identifier == "outing.photosHeader"
        case .textClipped:
            return issue.element?.identifier == "outing.locationName"
        default:
            return false
        }
    }

    func isKnownSettingsAuditIssue(_ issue: XCUIAccessibilityAuditIssue) -> Bool {
        switch issue.auditType {
        case .dynamicType:
            return issue.element?.identifier == "settings.birdIdFooter"
        case .textClipped:
            return Self.avatarEmojiLabels.contains(issue.element?.label ?? "")
        default:
            return false
        }
    }

    func isKnownSignInAuditIssue(_ issue: XCUIAccessibilityAuditIssue) -> Bool {
        guard issue.auditType == .contrast, let identifier = issue.element?.identifier else {
            return false
        }
        // The moving collage makes automated contrast readings variable for
        // these translucent controls. Keep the exception scoped to stable IDs.
        return ["auth.passkeySignUp", "auth.google", "auth.github"].contains(identifier)
    }

    func isKnownHomeAuditIssue(_ issue: XCUIAccessibilityAuditIssue) -> Bool {
        switch issue.auditType {
        case .dynamicType:
            return true
        case .textClipped:
            // The Recent Species carousel peeks the next card past the right
            // screen edge on purpose, to show that it scrolls, and the audit
            // reads that cut as clipped text. SpeciesCard already truncates at
            // two lines and is accessibilityHidden, and the UIKit cell carries
            // the real label, so nothing is actually unreadable.
            //
            // Blanket for the screen rather than scoped to that element,
            // because the audit reports this issue with a NIL element: there is
            // nothing to match on. Verified by dumping every issue on Home.
            //
            // It had never fired before only because the seed held two species,
            // too few for the carousel to overflow. Adding coordinates to the
            // seed does NOT cause it; a second outing does.
            return true
        default:
            return false
        }
    }

    func performListAccessibilityAudit(
        app: XCUIApplication,
        includesContrast: Bool
    ) throws {
        let auditTypes: XCUIAccessibilityAuditType = includesContrast
            ? .all
            : .all.subtracting(.contrast)
        try runAccessibilityAudit(in: app, for: auditTypes) { issue in
            switch issue.auditType {
            case .dynamicType where issue.element?.label == "Sort":
                return true
            case .textClipped where ["Search species", "Search outings", "Sort"].contains(issue.element?.label):
                return true
            default:
                return false
            }
        }
    }

    func waitForDataSetup(in app: XCUIApplication) {
        let elements = app.descendants(matching: .any)
        let complete = elements["ui-test.dataSetupComplete"]
        let failed = elements["ui-test.dataSetupFailed"]
        let outcome = elements.matching(
            NSPredicate(
                format: "identifier IN %@",
                ["ui-test.dataSetupComplete", "ui-test.dataSetupFailed"]
            )
        ).firstMatch
        XCTAssertTrue(
            outcome.existsOrWait(timeout: 120),
            "UI test data setup did not finish"
        )
        XCTAssertTrue(complete.exists || failed.exists, "UI test data setup reported an unknown outcome")
        XCTAssertFalse(failed.exists, "UI test data setup failed")
    }

    func waitForSeededData(in app: XCUIApplication) {
        waitForDataSetup(in: app)
        let elements = app.descendants(matching: .any)
        XCTAssertTrue(elements["Chalk-browed Mockingbird"].existsOrWait(timeout: 10))
        XCTAssertTrue(elements["Eared Dove"].existsOrWait(timeout: 10))
    }

    func waitForOutingReview(
        in app: XCUIApplication,
        requireEnabled: Bool = true
    ) -> XCUIElement {
        waitForDataSetup(in: app)
        let continueButton = app.buttons["outing.continue"]
        XCTAssertTrue(continueButton.existsOrWait(timeout: 60), "Outing review never appeared")
        if requireEnabled {
            XCTAssertTrue(
                continueButton.isEnabledOrWait(timeout: 15),
                "Continue never became enabled"
            )
        }
        return continueButton
    }

    /// An account can already hold an outing that matches the injected cluster, which
    /// inherits its location instead of offering an editable one. Start from a new outing.
    func startNewOuting(in app: XCUIApplication) {
        // SwiftUI puts the Toggle's identifier on its cell, so match the switch by label.
        let toggle = app.switches
            .matching(NSPredicate(format: "label BEGINSWITH 'Add to existing outing?'"))
            .firstMatch
        guard toggle.exists else { return }
        guard toggle.value as? String == "1" else { return }
        // The element spans the whole row but only the trailing switch flips it.
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
    }

    func application() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["API_BASE_URL"] = apiBaseURL.absoluteString
        return app
    }

    func launchApp(
        autoSignIn: Bool = true,
        extraArguments: [String] = []
    ) -> XCUIApplication {
        let app = application()
        app.launchArguments = [
            "--ui-test-reset-signup-prompt",
            "--ui-test-photo", Self.photoPath,
            "--ui-test-lat", "47.7115",
            "--ui-test-lon", "-122.3717",
        ] + extraArguments
        if autoSignIn {
            let usesLocalFixture = extraArguments.contains("--ui-test-fixture-empty")
                || extraArguments.contains("--ui-test-fixture-populated")
            let setupArguments = usesLocalFixture
                ? ["--auto-sign-in"]
                : ["--auto-sign-in", "--ui-test-clear-data"]
            app.launchArguments.insert(contentsOf: setupArguments, at: 0)
        } else {
            app.launchArguments.insert("--ui-test-sign-out", at: 0)
        }
        app.launch()
        return app
    }

    func backendUnavailableReason() async -> String? {
        let url = apiBaseURL.appendingPathComponent("api/health")
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let http = response as? HTTPURLResponse else {
                return "\(url) returned a non-HTTP response"
            }
            guard (200...299).contains(http.statusCode) else {
                return "\(url) returned HTTP \(http.statusCode)"
            }
            guard !data.isEmpty else {
                return "\(url) returned an empty body"
            }
            return nil
        } catch {
            return "\(url) is unreachable: \(error.localizedDescription)"
        }
    }
}
