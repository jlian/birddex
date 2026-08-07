import XCTest

/// End-to-end cover for on-device identification. The unit tests check the engine's
/// accuracy directly; this one checks that the add-photos flow actually wires the
/// engine up and renders a result.
final class BirdIdFlowUITests: XCTestCase {
    /// XCTNSPredicateExpectation is unavailable under strict concurrency here, so poll.
    private func waitUntil(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            Thread.sleep(forTimeInterval: 0.5)
        }
        return condition()
    }

    func testBundledPhotoReachesConfirmStepWithASpeciesAndConfidence() {
        let app = XCUIApplication()
        app.launchArguments = ["--auto-sign-in", "--auto-demo-data", "--ui-test-photo"]
        app.launch()

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
        XCTAssertFalse(species.label.isEmpty, "Species name was blank")

        let confidence = app.staticTexts["confirm.confidence"]
        XCTAssertTrue(confidence.exists, "Confidence was missing from the species card")
        XCTAssertTrue(
            confidence.label.hasSuffix("%"),
            "Expected a percentage, got \(confidence.label)"
        )
        XCTAssertNotEqual(confidence.label, "0%", "Confidence should never round away to zero")
    }
}
