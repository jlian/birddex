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

    /// XCTNSPredicateExpectation is unavailable under strict concurrency here, so poll.
    private func waitUntil(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.5)
        }
        return condition()
    }

    private func scrollUntilVisible(
        _ element: XCUIElement,
        in app: XCUIApplication,
        maximumSwipes: Int = 8
    ) -> Bool {
        for _ in 0..<maximumSwipes {
            if element.exists && element.isHittable { return true }
            app.swipeUp()
        }
        return element.exists && element.isHittable
    }

    private func launchApp(
        extraArguments: [String] = [],
        extraEnvironment: [String: String] = [:]
    ) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "--auto-sign-in",
            "--auto-demo-data",
            "--ui-test-photo", Self.photoPath,
            "--ui-test-lat", "47.7115",
            "--ui-test-lon", "-122.3717",
        ] + extraArguments
        app.launchEnvironment.merge(extraEnvironment) { _, newValue in newValue }
        app.launch()
        return app
    }

    private func localWorkerIsAvailable() async -> Bool {
        let url = localWorkerURL.appendingPathComponent("api/health")
        guard let (data, response) = try? await URLSession.shared.data(from: url),
              let http = response as? HTTPURLResponse
        else { return false }
        return (200...299).contains(http.statusCode) && !data.isEmpty
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
            waitUntil(timeout: 60) { continueButton.isHittable },
            "Continue never became tappable"
        )
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'GPS detected'")).firstMatch.exists,
            "Outing review did not detect the injected GPS coordinates"
        )
        let locationName = app.staticTexts["outing.locationName"]
        XCTAssertTrue(
            scrollUntilVisible(locationName, in: app),
            "Resolved outing location was missing"
        )
        XCTAssertFalse(locationName.label.isEmpty, "Resolved outing location was empty")
        XCTAssertNotEqual(locationName.label, "Unknown Location")
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
        let localWorkerAvailable = await localWorkerIsAvailable()
        try XCTSkipUnless(
            localWorkerAvailable,
            "Requires the current local WingDex Worker and Geoapify access"
        )
        let app = launchApp(extraEnvironment: [
            "API_BASE_URL": localWorkerURL.absoluteString,
        ])
        let continueButton = app.buttons["Continue"]
        XCTAssertTrue(continueButton.waitForExistence(timeout: 120))
        XCTAssertTrue(waitUntil(timeout: 60) { continueButton.isHittable })

        let locationName = app.staticTexts["outing.locationName"]
        XCTAssertTrue(scrollUntilVisible(locationName, in: app))
        let gpsLabel = locationName.label
        locationName.tap()
        let searchField = app.textFields["outing.locationSearch"]
        XCTAssertTrue(scrollUntilVisible(searchField, in: app))
        searchField.typeText("Discovery Park Seattle")
        searchField.typeText("\n")
        let firstResult = app.buttons.matching(identifier: "outing.locationResult").firstMatch
        XCTAssertTrue(firstResult.waitForExistence(timeout: 30), "Explicit place search returned no result")
        XCTAssertTrue(scrollUntilVisible(firstResult, in: app))
        let selectedLabel = firstResult.label
        firstResult.tap()
        XCTAssertEqual(locationName.label, selectedLabel)
        XCTAssertTrue(
            scrollUntilVisible(app.descendants(matching: .any)["outing.locationAttribution"], in: app),
            "Static Geoapify attribution was not visible"
        )
        XCTAssertTrue(
            scrollUntilVisible(app.descendants(matching: .any)["outing.locationSourceAttribution"], in: app),
            "Static OpenStreetMap attribution was not visible"
        )
        let useGPS = app.buttons["Use GPS: \(gpsLabel)"]
        XCTAssertTrue(scrollUntilVisible(useGPS, in: app), "Selecting a search result replaced the GPS suggestion")
        useGPS.tap()
        XCTAssertEqual(locationName.label, gpsLabel)
        XCTAssertTrue(app.descendants(matching: .any)["outing.locationAttribution"].exists)
        continueButton.tap()
        XCTAssertTrue(
            app.staticTexts["confirm.speciesName"].waitForExistence(timeout: 180),
            "Selected place was not persisted before species confirmation"
        )
    }

    func testGeocodingFailureFallsBackToCoordinatesAndAllowsManualEntry() {
        let app = launchApp(extraArguments: [
            "--ui-test-geocoding-failure",
            "--ui-test-clear-last-location",
        ])
        let continueButton = app.buttons["Continue"]
        XCTAssertTrue(continueButton.waitForExistence(timeout: 120))
        XCTAssertTrue(waitUntil(timeout: 30) { continueButton.isHittable })

        let locationName = app.staticTexts["outing.locationName"]
        XCTAssertTrue(scrollUntilVisible(locationName, in: app))
        XCTAssertEqual(locationName.label, "47.712deg, -122.372deg")
        XCTAssertTrue(app.descendants(matching: .any)["outing.locationAttribution"].exists)

        locationName.tap()
        let searchField = app.textFields["outing.locationSearch"]
        XCTAssertTrue(scrollUntilVisible(searchField, in: app))
        searchField.typeText("Manual Test Location")
        let useEnteredName = app.buttons["Use entered name without searching"]
        XCTAssertTrue(scrollUntilVisible(useEnteredName, in: app))
        useEnteredName.tap()
        XCTAssertTrue(
            waitUntil(timeout: 5) { locationName.label == "Manual Test Location" },
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
        XCTAssertFalse(app.staticTexts["outing.locationName"].exists)
        XCTAssertFalse(geocodingStatus.exists)
    }

    func testAddPhotosOutingReviewPassesAccessibilityAudit() throws {
        let app = launchApp(extraArguments: ["--ui-test-geocoding-failure"])
        let continueButton = app.buttons["Continue"]
        XCTAssertTrue(continueButton.waitForExistence(timeout: 120))
        XCTAssertTrue(waitUntil(timeout: 30) { continueButton.isHittable })

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
        XCTAssertTrue(app.buttons["Continue with Apple"].waitForExistence(timeout: 30))

        try app.performAccessibilityAudit()
    }

    func testHomePassesAccessibilityAudit() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--auto-sign-in", "--auto-demo-data"]
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
        let app = XCUIApplication()
        app.launchArguments = ["--auto-sign-in", "--auto-demo-data"]
        app.launch()
        let wingDexTab = app.buttons["WingDex"]
        XCTAssertTrue(wingDexTab.waitForExistence(timeout: 120))
        wingDexTab.tap()
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 120))

        try performListAccessibilityAudit(app: app, expectedPhotoContrastFindings: 4)
    }

    func testOutingsPassesAccessibilityAudit() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--auto-sign-in", "--auto-demo-data"]
        app.launch()
        let outingsTab = app.buttons["Outings"]
        XCTAssertTrue(outingsTab.waitForExistence(timeout: 120))
        outingsTab.tap()
        XCTAssertTrue(app.buttons["Settings"].waitForExistence(timeout: 120))

        try performListAccessibilityAudit(app: app, expectedPhotoContrastFindings: 4)
    }

    func testSettingsAndDeletionConfirmationsPassAccessibilityAudit() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--auto-sign-in", "--auto-demo-data"]
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
