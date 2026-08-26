import XCTest

/// Accessibility audits for the main screens. Separate from BirdIdFlowUITests so
/// XCTest can run the two suites on different parallel workers, and so CI can skip
/// this whole class by name without listing individual methods.
@MainActor
final class AccessibilityAuditUITests: BirdIdFlowUITestCase {
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
        app.launchArguments = [
            "--auto-sign-in",
            "--ui-test-clear-data",
            "--ui-test-transient-data-setup-failure",
        ]
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
