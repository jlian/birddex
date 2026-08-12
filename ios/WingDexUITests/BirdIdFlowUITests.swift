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

    private var localWorkerURL: URL {
        #if CI
        URL(string: "http://localhost:5000")!
        #else
        URL(string: "https://localhost.wingdex.app")!
        #endif
    }

    private static var photoPath: String {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("src/assets/images/\(photo)")
            .path
    }

    /// Stop at the first failure. Later steps wait up to 180s for the model, so letting a
    /// failed run continue turns one broken assertion into minutes of dead waiting.
    override func setUp() {
        continueAfterFailure = false
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

    private func launchApp(
        autoSignIn: Bool = true,
        extraArguments: [String] = [],
        extraEnvironment: [String: String] = [:]
    ) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            // Empty the account so leftover outings from earlier runs cannot change the
            // flow. None of these tests read the demo dex, and importing it ahead of the
            // identification run left the app busy long enough to time out CI's UI queries.
            "--ui-test-clear-data",
            "--ui-test-reset-signup-prompt",
            "--ui-test-photo", Self.photoPath,
            "--ui-test-lat", "47.7115",
            "--ui-test-lon", "-122.3717",
        ] + extraArguments
        if autoSignIn {
            app.launchArguments.insert("--auto-sign-in", at: 0)
        } else {
            app.launchArguments.insert("--ui-test-sign-out", at: 0)
        }
        app.launchEnvironment.merge(extraEnvironment) { _, newValue in newValue }
        app.launch()
        return app
    }

    /// Why the local Worker could not be reached, or nil when it is healthy.
    ///
    /// Returns the reason rather than a bool so CI can put it in the failure
    /// message. A bare false told us nothing on 2026-08-10, when this test skipped
    /// because the simulator had not finished booting and the run stayed green.
    private func localWorkerUnavailableReason() async -> String? {
        let url = localWorkerURL.appendingPathComponent("api/health")
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

        let continueButton = app.buttons["Continue"]
        XCTAssertTrue(
            continueButton.waitForExistence(timeout: 120),
            "Never reached the outing review step"
        )
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
        app.buttons["Close"].tap()
        let accountButton = app.buttons["Log in"]
        XCTAssertTrue(accountButton.waitForExistence(timeout: 10))
        XCTAssertEqual(
            accountButton.value as? String,
            "These sightings are only on this device",
            "The anonymous data badge did not persist after declining the prompt"
        )

        accountButton.tap()
        let passkeyLogin = app.buttons["auth.passkeyLogin"]
        XCTAssertTrue(passkeyLogin.waitForExistence(timeout: 10))
        passkeyLogin.tap()

        XCTAssertTrue(app.navigationBars["Before You Log In"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Export Sightings as CSV"].exists)
        XCTAssertTrue(app.buttons["Continue to Log In"].exists)
        app.buttons["Back"].tap()
        XCTAssertTrue(app.buttons["Continue with Apple"].waitForExistence(timeout: 10))
    }

    func testColdLaunchShowsTheAccountOptionalShell() {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-sign-out"]
        app.launch()

        XCTAssertTrue(app.buttons["Home"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.buttons["WingDex"].exists)
        XCTAssertTrue(app.buttons["Outings"].exists)
        XCTAssertTrue(app.buttons["Add"].exists)
        XCTAssertTrue(app.buttons["Log in"].exists)
        XCTAssertFalse(app.buttons["Settings"].exists)
    }

    func testAnonymousAccountAccessKeepsSettingsGatedAndDeleteDataReachable() {
        let app = XCUIApplication()
        app.launchArguments = ["--auto-sign-in", "--ui-test-clear-data"]
        app.launch()

        let account = app.buttons["Log in"]
        XCTAssertTrue(account.waitForExistence(timeout: 30))
        account.tap()

        XCTAssertTrue(app.buttons["Continue with Apple"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Delete Data"].exists)
        XCTAssertFalse(app.buttons["Log Out"].exists)
        XCTAssertFalse(app.buttons["Import from eBird CSV"].exists)
    }

    func testSubmittedPlaceSearchSelectsNormalizedResult() async throws {
        if let reason = await localWorkerUnavailableReason() {
            // Skipping is right on a laptop with no Worker running. It is wrong in
            // CI, which provisions one on purpose: a skip there means the harness
            // is broken, and reporting it as success is how the 2026-08-10 release
            // failure went unnoticed until it reached the release job.
            #if CI
            XCTFail("Local Worker is required in CI but was not reachable. \(reason)")
            return
            #else
            throw XCTSkip("Requires the current local WingDex Worker and Geoapify access. \(reason)")
            #endif
        }
        let app = launchApp(extraEnvironment: [
            "API_BASE_URL": localWorkerURL.absoluteString,
        ])
        let continueButton = app.buttons["Continue"]
        XCTAssertTrue(continueButton.waitForExistence(timeout: 120))
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
        if let reason = await localWorkerUnavailableReason() {
            #if CI
            XCTFail("Local Worker is required in CI but was not reachable. \(reason)")
            return
            #else
            throw XCTSkip("Requires the current local WingDex Worker and Geoapify access. \(reason)")
            #endif
        }
        let app = launchApp(extraEnvironment: [
            "API_BASE_URL": localWorkerURL.absoluteString,
        ])
        let continueButton = app.buttons["Continue"]
        XCTAssertTrue(continueButton.waitForExistence(timeout: 120))
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
        let continueButton = app.buttons["Continue"]
        XCTAssertTrue(continueButton.waitForExistence(timeout: 120))
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
        let continueButton = app.buttons["Continue"]
        XCTAssertTrue(
            continueButton.waitForExistence(timeout: 120),
            "Outing review never appeared"
        )
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
        let continueButton = app.buttons["Continue"]
        XCTAssertTrue(continueButton.waitForExistence(timeout: 120))
        XCTAssertTrue(waitUntil(timeout: 15) { continueButton.isHittable })

        try performBoundedAccessibilityAudit(
            app: app,
            // iOS 26 intermittently samples the native Form's Location header in addition
            // to the existing system DatePicker contrast sample.
            expectedContrastFindings: 2,
            expectedDynamicTypeFindings: 4
        )
    }

    func testSignInPassesAccessibilityAudit() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-sign-out"]
        app.launch()
        XCTAssertTrue(app.buttons["Log in"].waitForExistence(timeout: 30))
        app.buttons["Log in"].tap()
        XCTAssertTrue(app.buttons["Continue with Apple"].waitForExistence(timeout: 30))

        try performBoundedAccessibilityAudit(app: app)
    }

    func testHomePassesAccessibilityAudit() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--auto-sign-in", "--ui-test-clear-data"]
        app.launch()
        let homeTab = app.buttons["Home"]
        XCTAssertTrue(homeTab.waitForExistence(timeout: 120))
        homeTab.tap()
        XCTAssertTrue(app.buttons["Log in"].waitForExistence(timeout: 120))
        try performBoundedAccessibilityAudit(
            app: app,
            expectedContrastFindings: 6,
            expectedDynamicTypeFindings: 1,
            expectedTextClippingFindings: 1
        )
    }

    func testWingDexPassesAccessibilityAudit() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--auto-sign-in", "--ui-test-clear-data"]
        app.launch()
        let wingDexTab = app.buttons["WingDex"]
        XCTAssertTrue(wingDexTab.waitForExistence(timeout: 120))
        wingDexTab.tap()
        XCTAssertTrue(app.buttons["Log in"].waitForExistence(timeout: 120))

        try performListAccessibilityAudit(app: app, expectedPhotoContrastFindings: 0)
    }

    func testOutingsPassesAccessibilityAudit() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--auto-sign-in", "--ui-test-clear-data"]
        app.launch()
        let outingsTab = app.buttons["Outings"]
        XCTAssertTrue(outingsTab.waitForExistence(timeout: 120))
        outingsTab.tap()
        XCTAssertTrue(app.buttons["Log in"].waitForExistence(timeout: 120))

        try performListAccessibilityAudit(
            app: app,
            expectedPhotoContrastFindings: 0,
            expectedClippingFindings: 3
        )
    }

    func testAccountAndDeletionConfirmationsPassAccessibilityAudit() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--auto-sign-in", "--ui-test-clear-data"]
        app.launch()
        XCTAssertTrue(app.buttons["Log in"].waitForExistence(timeout: 120))
        app.buttons["Log in"].tap()
        XCTAssertTrue(app.buttons["Continue with Apple"].waitForExistence(timeout: 10))
        try performBoundedAccessibilityAudit(
            app: app,
            expectedContrastFindings: 6,
            expectedDynamicTypeFindings: 1
        )

        app.buttons["Delete Data"].tap()
        XCTAssertTrue(app.navigationBars["Data Management"].waitForExistence(timeout: 10))
        try app.performAccessibilityAudit()

        app.buttons["Delete All Data"].tap()
        XCTAssertTrue(app.alerts["Delete All Data?"].waitForExistence(timeout: 5))
        try performBoundedAccessibilityAudit(
            app: app,
            expectedContrastFindings: 1,
            expectedDynamicTypeFindings: 4
        )
        app.alerts["Delete All Data?"].buttons["Cancel"].tap()
    }

    private func performBoundedAccessibilityAudit(
        app: XCUIApplication,
        expectedContrastFindings: Int = 0,
        expectedDynamicTypeFindings: Int = 0,
        expectedTextClippingFindings: Int = 0
    ) throws {
        var contrastFindings = 0
        var dynamicTypeFindings = 0
        var textClippingFindings = 0
        var contrastDetails: [String] = []
        try app.performAccessibilityAudit { issue in
            switch issue.auditType {
            case .contrast:
                contrastFindings += 1
                contrastDetails.append(String(describing: issue.element))
                return true
            case .dynamicType:
                dynamicTypeFindings += 1
                return true
            case .textClipped where issue.element?.elementType == .textField:
                // A single-line text field scrolls its value instead of truncating it, and
                // VoiceOver still reads the whole thing. The audit cannot model that.
                return true
            case .textClipped where expectedTextClippingFindings > 0:
                textClippingFindings += 1
                return true
            default:
                return false
            }
        }
        XCTAssertLessThanOrEqual(
            contrastFindings,
            expectedContrastFindings,
            "Unexpected contrast samples: \(contrastDetails)"
        )
        XCTAssertLessThanOrEqual(dynamicTypeFindings, expectedDynamicTypeFindings)
        XCTAssertLessThanOrEqual(textClippingFindings, expectedTextClippingFindings)
    }

    private func performListAccessibilityAudit(
        app: XCUIApplication,
        expectedPhotoContrastFindings: Int,
        expectedClippingFindings: Int = 2
    ) throws {
        var photoContrastFindings = 0
        var systemDynamicTypeFindings = 0
        var systemClippingFindings = 0
        var dynamicTypeDetails: [String] = []
        var clippingDetails: [String] = []
        try app.performAccessibilityAudit { issue in
            // The iOS 26 audit flags the native search field and Sort menu while scaling them correctly.
            switch issue.auditType {
            case .contrast:
                photoContrastFindings += 1
                return true
            case .dynamicType:
                systemDynamicTypeFindings += 1
                dynamicTypeDetails.append(String(describing: issue.element))
                return true
            case .textClipped:
                systemClippingFindings += 1
                clippingDetails.append(String(describing: issue.element))
                return true
            default:
                return false
            }
        }
        XCTAssertLessThanOrEqual(photoContrastFindings, expectedPhotoContrastFindings)
        XCTAssertLessThanOrEqual(
            systemDynamicTypeFindings,
            1,
            "Unexpected Dynamic Type samples: \(dynamicTypeDetails)"
        )
        XCTAssertLessThanOrEqual(
            systemClippingFindings,
            expectedClippingFindings,
            "Unexpected clipping samples: \(clippingDetails)"
        )
    }
}
