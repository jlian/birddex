import XCTest

/// Render-only audits use local deterministic data. Functional UI tests retain
/// preview-backend coverage in BirdIdFlowUITests. Main screens share a launch,
/// while named activities preserve screen-specific diagnostics.
@MainActor
final class PopulatedAccessibilityAuditUITests: BirdIdFlowUITestCase {
    func testMainScreensPassAccessibilityAudit() {
        continueAfterFailure = true
        let app = launchPopulatedApp()

        XCTContext.runActivity(named: "Home") { _ in
            guard app.buttons["Home"].existsOrWait(timeout: 10) else {
                XCTFail("Populated Home did not appear")
                return
            }
            do {
                try runAccessibilityAudit(
                    in: app,
                    for: .all.subtracting(.contrast),
                    handlingKnownIssue: isKnownHomeAuditIssue
                )
            } catch {
                XCTFail("Populated Home accessibility audit failed: \(error)")
            }
        }

        XCTContext.runActivity(named: "WingDex") { _ in
            app.buttons["WingDex"].tap()
            guard app.descendants(matching: .any)["Chalk-browed Mockingbird"]
                .existsOrWait(timeout: 10) else {
                XCTFail("Populated WingDex did not appear")
                return
            }
            do {
                try performListAccessibilityAudit(app: app, includesContrast: false)
            } catch {
                XCTFail("Populated WingDex accessibility audit failed: \(error)")
            }
        }

        XCTContext.runActivity(named: "Outings") { _ in
            app.buttons["Outings"].tap()
            guard app.navigationBars["Outings"].existsOrWait(timeout: 10) else {
                XCTFail("Populated Outings did not appear")
                return
            }
            do {
                try performListAccessibilityAudit(app: app, includesContrast: false)
            } catch {
                XCTFail("Populated Outings accessibility audit failed: \(error)")
            }
        }
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
    func testMainScreensPassAccessibilityAudit() {
        continueAfterFailure = true
        let app = launchEmptyApp()

        XCTContext.runActivity(named: "Home") { _ in
            guard app.staticTexts["Got bird pics?"].existsOrWait(timeout: 10) else {
                XCTFail("Empty Home did not appear")
                return
            }
            do {
                try runAccessibilityAudit(in: app)
            } catch {
                XCTFail("Empty Home accessibility audit failed: \(error)")
            }
        }

        XCTContext.runActivity(named: "WingDex") { _ in
            app.buttons["WingDex"].tap()
            guard app.staticTexts["No Species Yet"].existsOrWait(timeout: 10) else {
                XCTFail("Empty WingDex did not appear")
                return
            }
            do {
                try performListAccessibilityAudit(app: app, includesContrast: true)
            } catch {
                XCTFail("Empty WingDex accessibility audit failed: \(error)")
            }
        }

        XCTContext.runActivity(named: "Outings") { _ in
            app.buttons["Outings"].tap()
            guard app.staticTexts["No Outings Yet"].existsOrWait(timeout: 10) else {
                XCTFail("Empty Outings did not appear")
                return
            }
            do {
                try performListAccessibilityAudit(app: app, includesContrast: true)
            } catch {
                XCTFail("Empty Outings accessibility audit failed: \(error)")
            }
        }
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
        XCTAssertTrue(app.navigationBars["Data Management"].existsOrWait(timeout: 10))
        try runAccessibilityAudit(in: app)

        app.buttons["Delete All Data"].tap()
        XCTAssertTrue(app.alerts["Delete All Data?"].existsOrWait(timeout: 5))
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
        XCTAssertTrue(app.buttons["Done"].existsOrWait(timeout: 10))

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
        XCTAssertTrue(app.buttons["Done"].existsOrWait(timeout: 10))
        XCTAssertTrue(app.buttons["Shuffle Name"].existsOrWait(timeout: 10))
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
        XCTAssertTrue(app.buttons["Log in"].existsOrWait(timeout: 30))
        app.buttons["Log in"].tap()
        XCTAssertTrue(app.buttons["Continue with Apple"].existsOrWait(timeout: 30))
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
        _ = waitForOutingReview(in: app)
        try runAccessibilityAudit(in: app, handlingKnownIssue: isKnownAddPhotosAuditIssue)
    }
}
