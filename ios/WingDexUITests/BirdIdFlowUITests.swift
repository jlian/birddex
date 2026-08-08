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
        guard let url = URL(string: "https://localhost.wingdex.app/api/health"),
              let (data, response) = try? await URLSession.shared.data(from: url),
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
        XCTAssertTrue(locationName.exists, "Resolved outing location was missing")
        XCTAssertFalse(locationName.label.isEmpty, "Resolved outing location was empty")
        XCTAssertNotEqual(locationName.label, "Unknown Location")
        XCTAssertTrue(
            app.descendants(matching: .any)["outing.locationAttribution"].exists,
            "OpenStreetMap attribution was missing from outing review"
        )
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
            "Requires the current local WingDex Worker and Nominatim access"
        )
        let app = launchApp(extraEnvironment: [
            "API_BASE_URL": "https://localhost.wingdex.app",
        ])
        let continueButton = app.buttons["Continue"]
        XCTAssertTrue(continueButton.waitForExistence(timeout: 120))
        XCTAssertTrue(waitUntil(timeout: 60) { continueButton.isHittable })

        let locationName = app.staticTexts["outing.locationName"]
        XCTAssertTrue(locationName.exists)
        locationName.tap()
        let searchField = app.textFields["outing.locationSearch"]
        XCTAssertTrue(searchField.waitForExistence(timeout: 5))
        searchField.typeText("Discovery Park Seattle")
        let searchButton = app.buttons["outing.locationSearchSubmit"]
        XCTAssertTrue(searchButton.isHittable)
        searchButton.tap()
        let firstResult = app.buttons.matching(identifier: "outing.locationResult").firstMatch
        XCTAssertTrue(firstResult.waitForExistence(timeout: 30), "Explicit place search returned no result")
        let selectedLabel = firstResult.label
        firstResult.tap()
        XCTAssertEqual(locationName.label, selectedLabel)
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
        XCTAssertTrue(locationName.exists)
        XCTAssertEqual(locationName.label, "47.712deg, -122.372deg")

        locationName.tap()
        let searchField = app.textFields["outing.locationSearch"]
        XCTAssertTrue(searchField.waitForExistence(timeout: 5))
        searchField.typeText("Manual Test Location")
        app.buttons["Use entered name without searching"].tap()
        XCTAssertEqual(locationName.label, "Manual Test Location")
    }

    func testDismissingOutingReviewCancelsDelayedGeocoding() {
        let app = launchApp(extraArguments: ["--ui-test-geocoding-delay"])
        XCTAssertTrue(
            app.staticTexts["Identifying location from GPS..."].waitForExistence(timeout: 120),
            "Delayed reverse geocoding never started"
        )

        app.buttons["Close"].tap()
        XCTAssertTrue(app.alerts["Discard progress?"].waitForExistence(timeout: 5))
        app.alerts["Discard progress?"].buttons["Discard"].tap()
        XCTAssertTrue(
            waitUntil(timeout: 5) {
                !app.buttons["Close"].exists
                    && !app.staticTexts["Identifying location from GPS..."].exists
            },
            "Wizard did not dismiss"
        )

        Thread.sleep(forTimeInterval: 3)
        XCTAssertFalse(app.staticTexts["outing.locationName"].exists)
        XCTAssertFalse(app.staticTexts["Identifying location from GPS..."].exists)
    }
}
