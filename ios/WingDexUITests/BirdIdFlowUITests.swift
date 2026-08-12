import XCTest

/// End-to-end cover for on-device identification. BirdIdAccuracyTests checks the
/// engine against a set of photos directly; this one checks that the add-photos
/// flow wires the engine up and renders the result it produces.
@MainActor
final class BirdIdFlowUITests: XCTestCase {
    /// A shared fixture, also used by BirdIdAccuracyTests and the web tests. Read from
    /// the repo rather than the app bundle so it never ships inside the app.
    private static let photo = "Great_blue_heron_roosting_at_Carkeek_Park.jpg"
    private static let expectedSpecies = "Great Blue Heron"
    private static let avatarEmojiLabels: Set<String> = ["🐦", "🦉", "🦜", "🐧", "🦆", "🦩", "🦅", "🐤"]

    nonisolated private var configuredAPIBaseURLValue: String? {
        ProcessInfo.processInfo.environment["API_BASE_URL"]
    }

    nonisolated private var configuredAPIBaseURL: URL? {
        guard let value = configuredAPIBaseURLValue,
              let url = URL(string: value),
              let scheme = url.scheme?.lowercased(),
              ["http", "https"].contains(scheme),
              url.host != nil
        else { return nil }
        return url
    }

    private var apiBaseURL: URL {
        configuredAPIBaseURL ?? URL(string: "https://localhost.wingdex.app")!
    }

    private static var photoPath: String {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("src/assets/images/\(photo)")
            .path
    }

    private static var seedCSVPath: String {
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

    /// XCTNSPredicateExpectation is unavailable under strict concurrency here, so poll.
    private func waitUntil(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return condition()
    }

    private func scrollUntilVisible(
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
    private func locationValue(_ field: XCUIElement) -> String {
        field.value as? String ?? ""
    }

    private func runAccessibilityAudit(
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

    nonisolated private static func isAccessibilityAuditInfrastructureTimeout(
        _ error: Error
    ) -> Bool {
        let auditError = error as NSError
        return auditError.domain == "com.apple.xcode.xctest.accessibilityAudit"
            && auditError.code == -56
    }

    private func isKnownAddPhotosAuditIssue(_ issue: XCUIAccessibilityAuditIssue) -> Bool {
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

    private func isKnownSettingsAuditIssue(_ issue: XCUIAccessibilityAuditIssue) -> Bool {
        switch issue.auditType {
        case .dynamicType:
            return issue.element?.identifier == "settings.birdIdFooter"
        case .textClipped:
            return issue.element?.identifier == "settings.displayName"
                || Self.avatarEmojiLabels.contains(issue.element?.label ?? "")
        default:
            return false
        }
    }

    private func isKnownSignInAuditIssue(_ issue: XCUIAccessibilityAuditIssue) -> Bool {
        issue.auditType == .contrast && issue.element?.label == "Sign up"
    }

    private func isKnownHomeAuditIssue(_ issue: XCUIAccessibilityAuditIssue) -> Bool {
        issue.auditType == .dynamicType
    }

    private func waitForDataSetup(in app: XCUIApplication) {
        let elements = app.descendants(matching: .any)
        let complete = elements["ui-test.dataSetupComplete"]
        let failed = elements["ui-test.dataSetupFailed"]
        XCTAssertTrue(
            waitUntil(timeout: 120) { complete.exists || failed.exists },
            "UI test data setup did not finish"
        )
        XCTAssertFalse(failed.exists, "UI test data setup failed")
    }

    private func waitForSeededData(in app: XCUIApplication) {
        waitForDataSetup(in: app)
        let elements = app.descendants(matching: .any)
        XCTAssertTrue(elements["Chalk-browed Mockingbird"].waitForExistence(timeout: 10))
        XCTAssertTrue(elements["Eared Dove"].exists)
    }

    private func waitForOutingReview(in app: XCUIApplication) -> XCUIElement {
        waitForDataSetup(in: app)
        let continueButton = app.buttons["Continue"]
        XCTAssertTrue(continueButton.waitForExistence(timeout: 60), "Outing review never appeared")
        return continueButton
    }

    /// An account can already hold an outing that matches the injected cluster, which
    /// inherits its location instead of offering an editable one. Start from a new outing.
    private func startNewOuting(in app: XCUIApplication) {
        // SwiftUI puts the Toggle's identifier on its cell, so match the switch by label.
        let toggle = app.switches
            .matching(NSPredicate(format: "label BEGINSWITH 'Add to existing outing?'"))
            .firstMatch
        guard toggle.waitForExistence(timeout: 5) else { return }
        guard toggle.value as? String == "1" else { return }
        // The element spans the whole row but only the trailing switch flips it.
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.5)).tap()
    }

    private func application() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["API_BASE_URL"] = apiBaseURL.absoluteString
        return app
    }

    private func launchApp(
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
            app.launchArguments.insert(contentsOf: ["--auto-sign-in", "--ui-test-clear-data"], at: 0)
        } else {
            app.launchArguments.insert("--ui-test-sign-out", at: 0)
        }
        app.launch()
        return app
    }

    private func backendUnavailableReason() async -> String? {
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

    func testKnownPhotoReachesConfirmStepWithTheRightSpecies() {
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: Self.photoPath),
            "Fixture missing at \(Self.photoPath)"
        )

        let app = launchApp(autoSignIn: false)

        let continueButton = waitForOutingReview(in: app)
        // The button stays disabled while the outing's location is resolving.
        XCTAssertTrue(
            waitUntil(timeout: 15) { continueButton.isHittable },
            "Continue never became tappable"
        )
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'GPS detected'")).firstMatch.exists,
            "Outing review did not detect the injected GPS coordinates"
        )
        startNewOuting(in: app)
        let locationName = app.textFields["outing.locationName"]
        XCTAssertTrue(
            locationName.waitForExistence(timeout: 15),
            "Location field never replaced the geocoding progress row"
        )
        XCTAssertTrue(
            scrollUntilVisible(locationName, in: app),
            "Resolved outing location was missing"
        )
        XCTAssertFalse(locationValue(locationName).isEmpty, "Resolved outing location was empty")
        XCTAssertNotEqual(locationValue(locationName), "Unknown Location")
        continueButton.tap()

        // A sub-0.8 result routes to the crop prompt instead of the confirm step, and
        // the injected photo carries no location, so the prior cannot sharpen the
        // scores. Back out of the crop and keep the candidates we already have.
        let species = app.staticTexts["confirm.speciesName"]
        let cropBack = app.buttons["crop.back"]
        // The model is loaded and compiled on first use, which is slow in the simulator.
        _ = waitUntil(timeout: 180) { species.exists || cropBack.isHittable }
        if cropBack.isHittable { cropBack.tap() }

        XCTAssertTrue(
            species.waitForExistence(timeout: 30),
            "Never reached the confirm step with an identified species"
        )
        XCTAssertEqual(species.label, Self.expectedSpecies)

        let confidence = app.staticTexts["confirm.confidence"]
        XCTAssertTrue(confidence.exists, "Confidence was missing from the species card")
        XCTAssertTrue(
            confidence.label.hasSuffix("%"),
            "Expected a percentage, got \(confidence.label)"
        )
        XCTAssertNotEqual(confidence.label, "0%", "Confidence should never round away to zero")

        app.buttons["confirm.accept"].tap()
        let done = app.buttons["upload.done"]
        XCTAssertTrue(done.waitForExistence(timeout: 30), "The anonymous outing did not finish saving")
        done.tap()
        XCTAssertTrue(
            app.staticTexts["Keep your sightings"].waitForExistence(timeout: 10),
            "The first anonymous save did not show the durability prompt"
        )
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] 'An account keeps them'")).firstMatch.exists)
        XCTAssertFalse(app.buttons["Delete Data"].exists)
        app.buttons["Close"].tap()
        let accountButton = app.buttons["Log in"]
        XCTAssertEqual(
            accountButton.value as? String,
            "These sightings are only on this device"
        )
        accountButton.tap()
        XCTAssertTrue(app.staticTexts["Keep your sightings"].waitForExistence(timeout: 10))
        app.buttons["auth.passkeyLogin"].tap()
        XCTAssertTrue(app.staticTexts["Your sightings stay on this device"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Export sightings as CSV"].exists)
        XCTAssertTrue(app.buttons["Continue to log in"].exists)
        app.buttons["Back"].tap()
    }

    func testColdSessionlessShareReachesOutingReview() {
        let app = application()
        app.launchArguments = [
            "--ui-test-sign-out",
            "--ui-test-reset-signup-prompt", "--ui-test-share-photo",
        ]
        app.launch()

        XCTAssertTrue(
            app.buttons["Continue"].waitForExistence(timeout: 120),
            "Queued shared photo never reached outing review"
        )
    }

    func testSessionlessShareBootstrapFailureShowsRetry() {
        let app = application()
        app.launchEnvironment["API_BASE_URL"] = "http://127.0.0.1:1"
        app.launchArguments = [
            "--ui-test-sign-out",
            "--ui-test-share-photo",
        ]
        app.launch()

        let alert = app.alerts["Could Not Continue"]
        XCTAssertTrue(alert.waitForExistence(timeout: 30), "Share bootstrap failure stayed invisible")
        XCTAssertTrue(alert.buttons["Retry"].exists)
        XCTAssertTrue(alert.buttons["Close Upload"].exists)
        alert.buttons["Close Upload"].tap()
        XCTAssertTrue(waitUntil(timeout: 10) { !app.alerts["Could Not Continue"].exists })
        XCTAssertFalse(app.buttons["Continue"].exists, "Explicit close immediately reopened the queued share")
    }

    func testColdLaunchShowsAccountOptionalShellAndGates() {
        let app = application()
        app.launchArguments = ["--ui-test-sign-out", "--ui-test-clear-pending-share"]
        app.launch()

        XCTAssertTrue(app.buttons["Home"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.buttons["Log in"].exists)
        XCTAssertFalse(app.buttons["Settings"].exists)
    }

    func testAccessibilityAuditTimeoutClassification() {
        XCTAssertTrue(Self.isAccessibilityAuditInfrastructureTimeout(
            NSError(domain: "com.apple.xcode.xctest.accessibilityAudit", code: -56)
        ))
        XCTAssertFalse(Self.isAccessibilityAuditInfrastructureTimeout(
            NSError(domain: "com.apple.xcode.xctest.accessibilityAudit", code: -55)
        ))
        XCTAssertFalse(Self.isAccessibilityAuditInfrastructureTimeout(
            NSError(domain: NSCocoaErrorDomain, code: -56)
        ))
    }

    func testSubmittedPlaceSearchSelectsNormalizedResult() async throws {
        if let reason = await backendUnavailableReason() {
            guard configuredAPIBaseURLValue == nil else {
                XCTFail("Selected CI backend is not healthy. \(reason)")
                return
            }
            throw XCTSkip("Requires a healthy WingDex backend with Geoapify access. \(reason)")
        }
        let app = launchApp()
        let continueButton = waitForOutingReview(in: app)
        XCTAssertTrue(waitUntil(timeout: 15) { continueButton.isHittable })

        startNewOuting(in: app)
        let locationName = app.textFields["outing.locationName"]
        XCTAssertTrue(locationName.waitForExistence(timeout: 15))
        XCTAssertTrue(scrollUntilVisible(locationName, in: app))
        let gpsLabel = locationValue(locationName)
        locationName.tap()
        app.buttons["outing.locationClear"].tap()
        locationName.typeText("Discovery Park Seattle\n")
        let firstResult = app.buttons.matching(identifier: "outing.locationResult").firstMatch
        XCTAssertTrue(firstResult.waitForExistence(timeout: 30), "Explicit place search returned no result")
        let selectedLabel = firstResult.label
        firstResult.tap()
        let selectedValue = locationValue(locationName)
        XCTAssertFalse(selectedValue.isEmpty, "Tapping a result did not set the location name")
        // The row reads "<place>, <context>"; only the place name becomes the outing name.
        XCTAssertTrue(
            selectedLabel.hasPrefix(selectedValue),
            "Expected \(selectedLabel) to start with the applied name \(selectedValue)"
        )
        XCTAssertTrue(
            scrollUntilVisible(app.descendants(matching: .any)["outing.locationAttribution"], in: app),
            "Static provider attribution was not visible"
        )
        let useGPS = app.buttons["Use GPS: \(gpsLabel)"]
        XCTAssertTrue(scrollUntilVisible(useGPS, in: app), "Selecting a search result replaced the GPS suggestion")
        useGPS.tap()
        XCTAssertEqual(locationValue(locationName), gpsLabel)
        XCTAssertTrue(app.descendants(matching: .any)["outing.locationAttribution"].exists)
        continueButton.tap()
        XCTAssertTrue(
            app.staticTexts["confirm.speciesName"].waitForExistence(timeout: 180),
            "Selected place was not persisted before species confirmation"
        )
    }

    func testFocusedEmptyLocationShowsNearbyPlacesWithoutKeyboard() async throws {
        if let reason = await backendUnavailableReason() {
            guard configuredAPIBaseURLValue == nil else {
                XCTFail("Selected CI backend is not healthy. \(reason)")
                return
            }
            throw XCTSkip("Requires a healthy WingDex backend with Geoapify access. \(reason)")
        }
        let app = launchApp()
        let continueButton = waitForOutingReview(in: app)
        XCTAssertTrue(waitUntil(timeout: 15) { continueButton.isHittable })

        startNewOuting(in: app)
        let locationName = app.textFields["outing.locationName"]
        XCTAssertTrue(locationName.waitForExistence(timeout: 15))
        XCTAssertTrue(scrollUntilVisible(locationName, in: app))

        locationName.tap()
        app.buttons["outing.locationClear"].tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        app.buttons["outing.locationSearchSubmit"].tap()

        let firstResult = app.buttons.matching(identifier: "outing.locationResult").firstMatch
        XCTAssertTrue(firstResult.waitForExistence(timeout: 30), "Nearby place suggestions did not appear")
        XCTAssertTrue(
            waitUntil(timeout: 5) { !app.keyboards.firstMatch.exists },
            "The keyboard remained active behind the nearby places popover"
        )
        XCTAssertTrue(firstResult.isHittable, "Nearby place suggestions were not interactive")
        firstResult.tap()
        XCTAssertFalse(locationValue(locationName).isEmpty, "Tapping a nearby place did not set the location name")
    }

    func testGeocodingFailureFallsBackToCoordinatesAndAllowsManualEntry() {
        let app = launchApp(extraArguments: [
            "--ui-test-geocoding-failure",
            "--ui-test-clear-last-location",
        ])
        let continueButton = waitForOutingReview(in: app)
        XCTAssertTrue(waitUntil(timeout: 15) { continueButton.isHittable })

        startNewOuting(in: app)
        let locationName = app.textFields["outing.locationName"]
        XCTAssertTrue(locationName.waitForExistence(timeout: 15))
        XCTAssertTrue(scrollUntilVisible(locationName, in: app))
        XCTAssertEqual(locationValue(locationName), "47.712deg, -122.372deg")
        XCTAssertTrue(app.descendants(matching: .any)["outing.locationAttribution"].exists)

        locationName.tap()
        app.buttons["outing.locationClear"].tap()
        locationName.typeText("Manual Test Location")
        XCTAssertTrue(
            waitUntil(timeout: 5) { locationValue(locationName) == "Manual Test Location" },
            "Manual location name was not applied"
        )
        XCTAssertTrue(
            waitUntil(timeout: 5) {
                app.descendants(matching: .any)["outing.locationAttribution"].exists
            },
            "Static attribution disappeared after manual location entry"
        )
    }

    func testDismissingOutingReviewCancelsDelayedGeocoding() {
        let app = launchApp(extraArguments: ["--ui-test-geocoding-delay"])
        let continueButton = waitForOutingReview(in: app)
        // Declining a matched outing is what starts the lookup for that account state.
        startNewOuting(in: app)
        XCTAssertFalse(continueButton.isEnabled, "Delayed geocoding was not in progress")

        let geocodingStatus = app.staticTexts["Identifying location from GPS..."]
        app.buttons["Close"].tap()
        XCTAssertTrue(app.alerts["Discard progress?"].waitForExistence(timeout: 5))
        app.alerts["Discard progress?"].buttons["Discard"].tap()
        XCTAssertTrue(
            waitUntil(timeout: 5) {
                !app.buttons["Close"].exists
                    && !geocodingStatus.exists
            },
            "Wizard did not dismiss"
        )

        Thread.sleep(forTimeInterval: 3)
        XCTAssertFalse(app.textFields["outing.locationName"].exists)
        XCTAssertFalse(geocodingStatus.exists)
    }

    func testAddPhotosOutingReviewPassesAccessibilityAudit() throws {
        let app = launchApp(extraArguments: ["--ui-test-geocoding-failure"])
        let continueButton = waitForOutingReview(in: app)
        XCTAssertTrue(waitUntil(timeout: 15) { continueButton.isHittable })

        try runAccessibilityAudit(in: app, handlingKnownIssue: isKnownAddPhotosAuditIssue)
    }

    func testSignInPassesAccessibilityAudit() throws {
        let app = application()
        app.launchArguments = ["--ui-test-sign-out", "--ui-test-clear-pending-share"]
        app.launch()
        XCTAssertTrue(app.buttons["Log in"].waitForExistence(timeout: 30))
        app.buttons["Log in"].tap()
        XCTAssertTrue(app.buttons["Continue with Apple"].waitForExistence(timeout: 30))

        try runAccessibilityAudit(in: app, handlingKnownIssue: isKnownSignInAuditIssue)
    }

    func testHomePassesAccessibilityAudit() throws {
        let app = application()
        app.launchArguments = ["--auto-sign-in", "--ui-test-clear-data", "--ui-test-seed-csv", Self.seedCSVPath]
        app.launch()
        waitForSeededData(in: app)
        let homeTab = app.buttons["Home"]
        XCTAssertTrue(homeTab.waitForExistence(timeout: 10))
        homeTab.tap()
        XCTAssertTrue(app.buttons["Log in"].waitForExistence(timeout: 10))

        try runAccessibilityAudit(
            in: app,
            for: .all.subtracting(.contrast),
            handlingKnownIssue: isKnownHomeAuditIssue
        )
    }

    func testEmptyHomePassesAccessibilityAudit() throws {
        let app = application()
        app.launchArguments = ["--auto-sign-in", "--ui-test-clear-data"]
        app.launch()
        waitForDataSetup(in: app)
        XCTAssertTrue(app.staticTexts["Got bird pics?"].waitForExistence(timeout: 10))

        try runAccessibilityAudit(in: app)
    }

    func testWingDexPassesAccessibilityAudit() throws {
        let app = application()
        app.launchArguments = ["--auto-sign-in", "--ui-test-clear-data", "--ui-test-seed-csv", Self.seedCSVPath]
        app.launch()
        waitForSeededData(in: app)
        let wingDexTab = app.buttons["WingDex"]
        XCTAssertTrue(wingDexTab.waitForExistence(timeout: 10))
        wingDexTab.tap()
        XCTAssertTrue(app.buttons["Log in"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.descendants(matching: .any)["Chalk-browed Mockingbird"].waitForExistence(timeout: 10))

        try performListAccessibilityAudit(app: app, includesContrast: false)
    }

    func testEmptyWingDexPassesAccessibilityAudit() throws {
        let app = application()
        app.launchArguments = ["--auto-sign-in", "--ui-test-clear-data"]
        app.launch()
        waitForDataSetup(in: app)
        let wingDexTab = app.buttons["WingDex"]
        XCTAssertTrue(wingDexTab.waitForExistence(timeout: 10))
        wingDexTab.tap()
        XCTAssertTrue(app.staticTexts["No Species Yet"].waitForExistence(timeout: 10))

        try performListAccessibilityAudit(app: app, includesContrast: true)
    }

    func testOutingsPassesAccessibilityAudit() throws {
        let app = application()
        app.launchArguments = ["--auto-sign-in", "--ui-test-clear-data", "--ui-test-seed-csv", Self.seedCSVPath]
        app.launch()
        waitForSeededData(in: app)
        let outingsTab = app.buttons["Outings"]
        XCTAssertTrue(outingsTab.waitForExistence(timeout: 10))
        outingsTab.tap()
        XCTAssertTrue(app.navigationBars["Outings"].waitForExistence(timeout: 10))

        try performListAccessibilityAudit(app: app, includesContrast: false)
    }

    func testEmptyOutingsPassesAccessibilityAudit() throws {
        let app = application()
        app.launchArguments = ["--auto-sign-in", "--ui-test-clear-data"]
        app.launch()
        waitForDataSetup(in: app)
        let outingsTab = app.buttons["Outings"]
        XCTAssertTrue(outingsTab.waitForExistence(timeout: 10))
        outingsTab.tap()
        XCTAssertTrue(app.navigationBars["Outings"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["No Outings Yet"].waitForExistence(timeout: 10))

        try performListAccessibilityAudit(app: app, includesContrast: true)
    }

    func testSettingsAndDeletionConfirmationsPassAccessibilityAudit() throws {
        let app = application()
        app.launchArguments = [
            "--auto-sign-in", "--ui-test-clear-data",
            "--ui-test-seed-csv", Self.seedCSVPath,
            "--ui-test-open-settings",
        ]
        app.launch()
        waitForDataSetup(in: app)
        if !app.buttons["Done"].waitForExistence(timeout: 10) {
            app.terminate()
            app.launch()
            waitForDataSetup(in: app)
        }
        XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 10))
        try runAccessibilityAudit(
            in: app,
            for: .all.subtracting(.contrast),
            handlingKnownIssue: isKnownSettingsAuditIssue
        )

        let deleteData = app.buttons["Delete Data..."]
        while !deleteData.isHittable {
            app.swipeUp()
        }
        deleteData.tap()
        XCTAssertTrue(app.navigationBars["Data Management"].waitForExistence(timeout: 10))
        try runAccessibilityAudit(in: app)

        app.buttons["Delete All Data"].tap()
        XCTAssertTrue(app.alerts["Delete All Data?"].waitForExistence(timeout: 5))
        try runAccessibilityAudit(in: app, for: .all.subtracting(.dynamicType))
        app.alerts["Delete All Data?"].buttons["Cancel"].tap()
    }

    func testSettingsPassesContrastAudit() throws {
        let app = application()
        app.launchArguments = [
            "--auto-sign-in",
            "--ui-test-clear-data",
            "--ui-test-seed-csv", Self.seedCSVPath,
            "--ui-test-open-settings",
            "--ui-test-hide-avatar-options",
        ]
        app.launch()
        waitForDataSetup(in: app)
        XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 10))

        try runAccessibilityAudit(in: app, for: .contrast)

        let legalHeader = app.staticTexts["Legal"]
        XCTAssertTrue(scrollUntilVisible(legalHeader, in: app))
        try runAccessibilityAudit(in: app, for: .contrast)
    }

    private func performListAccessibilityAudit(
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
}
