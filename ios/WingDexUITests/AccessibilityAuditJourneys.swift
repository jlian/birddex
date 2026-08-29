import XCTest

/// Render-only audits use local deterministic data. Functional UI tests retain
/// preview-backend coverage in BirdIdFlowUITests. Each screen remains a distinct
/// test so one accessibility failure cannot hide later screens.
@MainActor
final class PopulatedAccessibilityAuditUITests: BirdIdFlowUITestCase {
    func testHomePassesAccessibilityAudit() throws {
        let app = launchPopulatedApp()
        XCTAssertTrue(app.buttons["Home"].waitForExistence(timeout: 10))
        try runAccessibilityAudit(
            in: app,
            for: .all.subtracting(.contrast),
            handlingKnownIssue: isKnownHomeAuditIssue
        )
    }

    func testWingDexPassesAccessibilityAudit() throws {
        let app = launchPopulatedApp()
        app.buttons["WingDex"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["Chalk-browed Mockingbird"].waitForExistence(timeout: 10))
        try performListAccessibilityAudit(app: app, includesContrast: false)
    }

    func testOutingsPassesAccessibilityAudit() throws {
        let app = launchPopulatedApp()
        app.buttons["Outings"].tap()
        XCTAssertTrue(app.navigationBars["Outings"].waitForExistence(timeout: 10))
        try performListAccessibilityAudit(app: app, includesContrast: false)
    }

    private func launchPopulatedApp() -> XCUIApplication {
        let app = application()
        app.launchArguments = ["--ui-test-fixture-populated"]
        app.launch()
        waitForDataSetup(in: app)
        return app
    }
}

@MainActor
final class EmptyAccessibilityAuditUITests: BirdIdFlowUITestCase {
    func testHomePassesAccessibilityAudit() throws {
        let app = launchEmptyApp()
        XCTAssertTrue(app.staticTexts["Got bird pics?"].waitForExistence(timeout: 10))
        try runAccessibilityAudit(in: app)
    }

    func testWingDexPassesAccessibilityAudit() throws {
        let app = launchEmptyApp()
        app.buttons["WingDex"].tap()
        XCTAssertTrue(app.staticTexts["No Species Yet"].waitForExistence(timeout: 10))
        try performListAccessibilityAudit(app: app, includesContrast: true)
    }

    func testOutingsPassesAccessibilityAudit() throws {
        let app = launchEmptyApp()
        app.buttons["Outings"].tap()
        XCTAssertTrue(app.staticTexts["No Outings Yet"].waitForExistence(timeout: 10))
        try performListAccessibilityAudit(app: app, includesContrast: true)
    }

    private func launchEmptyApp() -> XCUIApplication {
        let app = application()
        app.launchArguments = ["--ui-test-fixture-empty"]
        app.launch()
        waitForDataSetup(in: app)
        return app
    }
}

@MainActor
final class SettingsAccessibilityAuditUITests: BirdIdFlowUITestCase {
    func testSettingsAndDeletionConfirmationsPassAccessibilityAudit() throws {
        let app = launchSettingsApp()
        try runAccessibilityAudit(
            in: app,
            for: .all.subtracting(.contrast),
            handlingKnownIssue: isKnownSettingsAuditIssue
        )

        let deleteData = app.buttons["Delete Data..."]
        XCTAssertTrue(scrollUntilVisible(deleteData, in: app, maximumSwipes: 6))
        deleteData.tap()
        XCTAssertTrue(app.navigationBars["Data Management"].waitForExistence(timeout: 10))
        try runAccessibilityAudit(in: app)

        app.buttons["Delete All Data"].tap()
        XCTAssertTrue(app.alerts["Delete All Data?"].waitForExistence(timeout: 5))
        try runAccessibilityAudit(in: app, for: .all.subtracting(.dynamicType))
    }

    func testSettingsPassesContrastAudit() throws {
        let app = application()
        app.launchArguments = [
            "--ui-test-fixture-populated",
            "--ui-test-open-settings",
        ]
        app.launch()
        waitForDataSetup(in: app)
        XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 10))

        try runAccessibilityAudit(in: app, for: .contrast)
        let legalHeader = app.staticTexts["Legal"]
        XCTAssertTrue(scrollUntilVisible(legalHeader, in: app))
        try runAccessibilityAudit(in: app, for: .contrast)
    }

    private func launchSettingsApp() -> XCUIApplication {
        let app = application()
        app.launchArguments = ["--ui-test-fixture-populated", "--ui-test-open-settings"]
        app.launch()
        waitForDataSetup(in: app)
        XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Shuffle Name"].waitForExistence(timeout: 10))
        return app
    }
}

@MainActor
final class SignInAccessibilityAuditUITests: BirdIdFlowUITestCase {
    func testSignInPassesAccessibilityAudit() throws {
        let app = application()
        app.launchArguments = [
            "--ui-test-sign-out",
            "--ui-test-share-store",
            "--ui-test-reset-share-store",
            "--ui-test-ignore-shares",
        ]
        app.launch()
        XCTAssertTrue(app.buttons["Log in"].waitForExistence(timeout: 30))
        app.buttons["Log in"].tap()
        XCTAssertTrue(app.buttons["Continue with Apple"].waitForExistence(timeout: 30))
        try runAccessibilityAudit(in: app, handlingKnownIssue: isKnownSignInAuditIssue)
    }
}

@MainActor
final class AddPhotosAccessibilityAuditUITests: BirdIdFlowUITestCase {
    func testOutingReviewPassesAccessibilityAudit() throws {
        let app = launchApp(extraArguments: [
            "--ui-test-fixture-empty",
            "--ui-test-geocoding-failure",
            "--ui-test-stub-identification",
        ])
        let continueButton = waitForOutingReview(in: app)
        XCTAssertTrue(waitUntil(timeout: 15) { continueButton.isHittable })
        try runAccessibilityAudit(in: app, handlingKnownIssue: isKnownAddPhotosAuditIssue)
    }
}
