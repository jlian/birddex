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

    private var configuredAPIBaseURLValue: String? {
        ProcessInfo.processInfo.environment["API_BASE_URL"]
    }

    private var configuredAPIBaseURL: URL? {
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

    private func launchApp(extraArguments: [String] = []) -> XCUIApplication {
        let app = application()
        app.launchArguments = [
            "--auto-sign-in",
            // Empty the account so leftover outings from earlier runs cannot change the
            // flow. None of these tests read the demo dex, and importing it ahead of the
            // identification run left the app busy long enough to time out CI's UI queries.
            "--ui-test-clear-data",
            "--ui-test-photo", Self.photoPath,
            "--ui-test-lat", "47.7115",
            "--ui-test-lon", "-122.3717",
        ] + extraArguments
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

        let app = launchApp()

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
        if let reason = await backendUnavailableReason() {
            guard configuredAPIBaseURLValue == nil else {
                XCTFail("Selected CI backend is not healthy. \(reason)")
                return
            }
            throw XCTSkip("Requires a healthy WingDex backend with Geoapify access. \(reason)")
        }
        let app = launchApp()
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
        let app = application()
        app.launchArguments = ["--ui-test-sign-out"]
        app.launch()
        XCTAssertTrue(app.buttons["Continue with Apple"].waitForExistence(timeout: 30))

        try app.performAccessibilityAudit()
    }

    func testHomePassesAccessibilityAudit() throws {
        let app = application()
        app.launchArguments = ["--auto-sign-in", "--auto-demo-data", "--ui-test-reset-data"]
        app.launch()
        let homeTab = app.buttons["Home"]
        XCTAssertTrue(homeTab.waitForExistence(timeout: 120))
        homeTab.tap()
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 120))
        let elements = app.descendants(matching: .any)
        XCTAssertTrue(elements["Chalk-browed Mockingbird"].waitForExistence(timeout: 10))
        XCTAssertTrue(elements["Eared Dove"].exists)

        var photoContrastFindings = 0
        var contrastDetails: [String] = []
        try app.performAccessibilityAudit { issue in
            // XCTest samples photo-backed cells and one compact glyph without exposing their elements.
            if issue.auditType == .contrast {
                photoContrastFindings += 1
            contrastDetails.append(String(describing: issue.element))
                return true
            }
            return false
        }
        XCTAssertLessThanOrEqual(
            photoContrastFindings,
            6,
            "Unexpected contrast samples: \(contrastDetails)"
        )
    }

    func testWingDexPassesAccessibilityAudit() throws {
        let app = application()
        app.launchArguments = ["--auto-sign-in", "--auto-demo-data", "--ui-test-reset-data"]
        app.launch()
        let wingDexTab = app.buttons["WingDex"]
        XCTAssertTrue(wingDexTab.waitForExistence(timeout: 120))
        wingDexTab.tap()
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 120))

        try performListAccessibilityAudit(app: app, expectedPhotoContrastFindings: 4)
    }

    func testOutingsPassesAccessibilityAudit() throws {
        let app = application()
        app.launchArguments = ["--auto-sign-in", "--auto-demo-data", "--ui-test-reset-data"]
        app.launch()
        let outingsTab = app.buttons["Outings"]
        XCTAssertTrue(outingsTab.waitForExistence(timeout: 120))
        outingsTab.tap()
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 120))

        try performListAccessibilityAudit(app: app, expectedPhotoContrastFindings: 4)
    }

    func testSettingsAndDeletionConfirmationsPassAccessibilityAudit() throws {
        let app = application()
        app.launchArguments = ["--auto-sign-in", "--auto-demo-data", "--ui-test-reset-data"]
        app.launch()
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 120))
        app.buttons["Settings"].tap()
        XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 10))
        try performBoundedAccessibilityAudit(
            app: app,
            expectedContrastFindings: 6,
            expectedDynamicTypeFindings: 1
        )

        let deleteData = app.buttons["Delete Data..."]
        while !deleteData.isHittable {
            app.swipeUp()
        }
        deleteData.tap()
        XCTAssertTrue(app.navigationBars["Data Management"].waitForExistence(timeout: 10))
        try app.performAccessibilityAudit()

        app.buttons["Delete Account & All Data"].tap()
        XCTAssertTrue(app.alerts["Delete your entire account?"].waitForExistence(timeout: 5))
        try performBoundedAccessibilityAudit(
            app: app,
            expectedContrastFindings: 1,
            expectedDynamicTypeFindings: 4
        )
        app.alerts["Delete your entire account?"].buttons["I understand, continue"].tap()
        XCTAssertTrue(app.alerts["Are you absolutely sure?"].waitForExistence(timeout: 5))
        try performBoundedAccessibilityAudit(
            app: app,
            expectedContrastFindings: 1,
            expectedDynamicTypeFindings: 4
        )
        app.alerts["Are you absolutely sure?"].buttons["Go back"].tap()
    }

    private func performBoundedAccessibilityAudit(
        app: XCUIApplication,
        expectedContrastFindings: Int = 0,
        expectedDynamicTypeFindings: Int = 0
    ) throws {
        var contrastFindings = 0
        var dynamicTypeFindings = 0
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
    }

    private func performListAccessibilityAudit(
        app: XCUIApplication,
        expectedPhotoContrastFindings: Int
    ) throws {
        var photoContrastFindings = 0
        var systemDynamicTypeFindings = 0
        var systemClippingFindings = 0
        try app.performAccessibilityAudit { issue in
            // The iOS 26 audit flags the native search field and Sort menu while scaling them correctly.
            switch issue.auditType {
            case .contrast:
                photoContrastFindings += 1
                return true
            case .dynamicType:
                systemDynamicTypeFindings += 1
                return true
            case .textClipped:
                systemClippingFindings += 1
                return true
            default:
                return false
            }
        }
        XCTAssertLessThanOrEqual(photoContrastFindings, expectedPhotoContrastFindings)
        XCTAssertLessThanOrEqual(systemDynamicTypeFindings, 1)
        XCTAssertLessThanOrEqual(systemClippingFindings, 2)
    }
}
