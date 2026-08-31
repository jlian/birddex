import XCTest

@MainActor
final class OutingListRegressionUITests: BirdIdFlowUITestCase {
    private let outingName = "Parque Ibirapuera, Sao Paulo"

    func testOutingContextMenuHasViewDetailsAndNoSwipeDelete() {
        let app = launchPopulatedOutings()
        let outing = outingRow(in: app)

        outing.press(forDuration: 1)

        let viewDetails = app.buttons["View Details"]
        XCTAssertTrue(viewDetails.existsOrWait(timeout: 10))
        viewDetails.tap()
        let detailNavigationBar = app.navigationBars[outingName]
        XCTAssertTrue(detailNavigationBar.existsOrWait(timeout: 10))
        detailNavigationBar.buttons["Outings"].tap()

        outingRow(in: app).swipeLeft()
        XCTAssertFalse(app.buttons["Delete"].exists)
        XCTAssertEqual(app.state, .runningForeground)
    }

    private func launchPopulatedOutings() -> XCUIApplication {
        let app = launchPopulatedApp()
        app.buttons["Outings"].tap()
        XCTAssertTrue(app.navigationBars["Outings"].existsOrWait(timeout: 10))
        return app
    }

    private func launchPopulatedApp() -> XCUIApplication {
        let app = application()
        app.launchArguments = ["--ui-test-fixture-populated"]
        app.launch()
        waitForDataSetup(in: app)
        return app
    }

    private func outingRow(in app: XCUIApplication) -> XCUIElement {
        let row = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", outingName)
        ).firstMatch
        XCTAssertTrue(row.existsOrWait(timeout: 10))
        return row
    }
}
