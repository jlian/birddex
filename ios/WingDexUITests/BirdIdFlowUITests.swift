import XCTest

/// End-to-end cover for on-device identification. BirdIdAccuracyTests checks the
/// engine against a set of photos directly; this one checks that the add-photos
/// flow wires the engine up and renders the result it produces.
@MainActor
final class BirdIdFlowUITests: BirdIdFlowUITestCase {

    func testKnownPhotoReachesConfirmStepWithTheRightSpecies() {
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: Self.photoPath),
            "Fixture missing at \(Self.photoPath)"
        )

        let app = launchApp(
            autoSignIn: false,
            extraArguments: ["--ui-test-clear-data"]
        )

        let continueButton = waitForOutingReview(in: app)
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'GPS detected'")).firstMatch.exists,
            "Outing review did not detect the injected GPS coordinates"
        )
        startNewOuting(in: app)
        let locationName = app.textFields["outing.locationName"]
        XCTAssertTrue(
            locationName.existsOrWait(timeout: 15),
            "Location field never replaced the geocoding progress row"
        )
        XCTAssertTrue(
            scrollUntilVisible(locationName, in: app),
            "Resolved outing location was missing"
        )
        XCTAssertEqual(
            locationValue(locationName),
            "Carkeek Park",
            "Reverse geocoding did not resolve the known fixture coordinate"
        )
        XCTAssertFalse(app.descendants(matching: .any)["outing.locationLookupError"].exists)
        continueButton.tap()

        // A sub-0.8 result routes to the crop prompt instead of the confirm step, and
        // the injected photo carries no location, so the prior cannot sharpen the
        // scores. Back out of the crop and keep the candidates we already have.
        let species = app.staticTexts["confirm.speciesName"]
        let cropBack = app.buttons["crop.back"]
        let identificationDestination = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier IN %@", ["confirm.speciesName", "crop.back"])
        ).firstMatch
        // The model is loaded and compiled on first use, which is slow in the simulator.
        XCTAssertTrue(
            identificationDestination.existsOrWait(timeout: 180),
            "Identification produced neither candidates nor a crop prompt"
        )
        if cropBack.exists {
            let actionableCropBack = app.buttons.matching(
                NSPredicate(format: "identifier == %@ AND hittable == true", "crop.back")
            ).firstMatch
            XCTAssertTrue(actionableCropBack.existsOrWait(timeout: 10))
            actionableCropBack.tap()
            XCTAssertTrue(
                species.existsOrWait(timeout: 30),
                "Never reached the confirm step after keeping the existing crop"
            )
        } else {
            XCTAssertTrue(species.exists, "Never reached the confirm step with an identified species")
        }
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
        XCTAssertTrue(done.existsOrWait(timeout: 30), "The anonymous outing did not finish saving")
        done.tap()
        XCTAssertTrue(
            app.staticTexts["Keep your"].existsOrWait(timeout: 10),
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
        XCTAssertTrue(app.staticTexts["Keep your"].existsOrWait(timeout: 10))
        XCTAssertFalse(app.staticTexts["Keep your sightings"].exists)
        XCTAssertFalse(app.staticTexts["Keep this WingDex or switch accounts"].exists)
        XCTAssertFalse(app.buttons["Export sightings as CSV"].exists)
    }

    func testColdSessionlessShareReachesOutingReview() {
        let app = application()
        app.launchArguments = [
            "--ui-test-sign-out",
            "--ui-test-reset-signup-prompt",
            "--ui-test-delay-session-enrichment",
            "--ui-test-share-store",
            "--ui-test-reset-share-store",
            "--ui-test-stage-share",
        ]
        app.launch()

        XCTAssertTrue(
            app.buttons["Continue"].existsOrWait(timeout: 30),
            "Queued shared photo never reached outing review"
        )
    }

    func testAcceptedShareDoesNotReappearAfterRelaunch() {
        let app = application()
        app.launchArguments = [
            "--ui-test-sign-out",
            "--ui-test-share-store",
            "--ui-test-reset-share-store",
            "--ui-test-stage-share",
        ]
        app.launch()

        XCTAssertTrue(
            app.buttons["Continue"].existsOrWait(timeout: 30),
            "Queued shared photo never reached outing review"
        )

        app.terminate()
        app.launchArguments = [
            "--ui-test-sign-out",
            "--ui-test-share-store",
            "--ui-test-observe-share-queue",
        ]
        app.launch()

        XCTAssertTrue(app.buttons["Home"].existsOrWait(timeout: 30))
        XCTAssertTrue(
            app.descendants(matching: .any)["ui-test.shareQueueChecked"].existsOrWait(timeout: 30),
            "The incoming-share queue was not checked after relaunch"
        )
        XCTAssertFalse(
            app.buttons["Continue"].exists,
            "The accepted share was imported again after relaunch"
        )
        XCTAssertTrue(app.buttons["Log in"].exists)
        XCTAssertFalse(app.buttons["Settings"].exists)
    }

    func testAlreadyLoadedSessionlessAppReceivesStagedShare() {
        let app = application()
        app.launchArguments = [
            "--ui-test-sign-out",
            "--ui-test-share-store",
            "--ui-test-reset-share-store",
            "--ui-test-stage-share-after-launch",
        ]
        app.launch()

        XCTAssertTrue(app.buttons["Home"].existsOrWait(timeout: 30))
        XCTAssertTrue(
            app.buttons["Continue"].existsOrWait(timeout: 30),
            "A share staged after launch was not delivered to the loaded app"
        )
    }

    func testSessionlessShareBootstrapFailureShowsRetry() {
        let app = application()
        app.launchEnvironment["API_BASE_URL"] = "http://127.0.0.1:1"
        app.launchArguments = [
            "--ui-test-sign-out",
            "--ui-test-share-store",
            "--ui-test-reset-share-store",
            "--ui-test-stage-share",
        ]
        app.launch()

        let alert = app.alerts["Could Not Continue"]
        XCTAssertTrue(alert.existsOrWait(timeout: 30), "Share bootstrap failure stayed invisible")
        XCTAssertTrue(alert.buttons["Retry"].exists)
        XCTAssertTrue(alert.buttons["Close Upload"].exists)
        alert.buttons["Close Upload"].tap()
        XCTAssertTrue(alert.disappearsOrWait(timeout: 10))
        XCTAssertFalse(app.buttons["Continue"].exists, "Explicit close immediately reopened the queued share")
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

    func testSubmittedPlaceSearchAppliesNormalizedResultAndRestoresGPS() async throws {
        if let reason = await backendUnavailableReason() {
            guard configuredAPIBaseURLValue == nil else {
                XCTFail("Selected CI backend is not healthy. \(reason)")
                return
            }
            throw XCTSkip("Requires a healthy WingDex backend. \(reason)")
        }
        let app = launchApp(extraArguments: [
            "--ui-test-place-search-result",
            "--ui-test-stub-identification",
        ])
        let continueButton = waitForOutingReview(in: app)

        startNewOuting(in: app)
        let locationName = app.textFields["outing.locationName"]
        XCTAssertTrue(locationName.existsOrWait(timeout: 15))
        XCTAssertTrue(scrollUntilVisible(locationName, in: app))
        let gpsLabel = locationValue(locationName)
        locationName.tap()
        app.buttons["outing.locationClear"].tap()
        locationName.typeText("Discovery Park Seattle\n")
        let firstResult = app.buttons.matching(identifier: "outing.locationResult").firstMatch
        XCTAssertTrue(firstResult.existsOrWait(timeout: 30), "Explicit place search returned no result")
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
            app.staticTexts["confirm.speciesName"].existsOrWait(timeout: 10),
            "Continuing after place selection did not reach species confirmation"
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
        _ = waitForOutingReview(in: app)

        startNewOuting(in: app)
        let locationName = app.textFields["outing.locationName"]
        XCTAssertTrue(locationName.existsOrWait(timeout: 15))
        XCTAssertTrue(scrollUntilVisible(locationName, in: app))

        locationName.tap()
        app.buttons["outing.locationClear"].tap()
        XCTAssertTrue(app.keyboards.firstMatch.existsOrWait(timeout: 5))
        app.buttons["outing.locationSearchSubmit"].tap()

        let firstResult = app.buttons.matching(identifier: "outing.locationResult").firstMatch
        XCTAssertTrue(firstResult.existsOrWait(timeout: 30), "Nearby place suggestions did not appear")
        XCTAssertTrue(
            app.keyboards.firstMatch.disappearsOrWait(timeout: 5),
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
        _ = waitForOutingReview(in: app)

        startNewOuting(in: app)
        let locationName = app.textFields["outing.locationName"]
        XCTAssertTrue(locationName.existsOrWait(timeout: 15))
        XCTAssertTrue(scrollUntilVisible(locationName, in: app))
        XCTAssertEqual(locationValue(locationName), "47.712deg, -122.372deg")
        XCTAssertTrue(app.descendants(matching: .any)["outing.locationLookupError"].exists)
        XCTAssertTrue(app.buttons["outing.locationRetry"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["outing.locationAttribution"].exists)

        locationName.tap()
        app.buttons["outing.locationClear"].tap()
        locationName.typeText("Manual Test Location")
        let manualLocation = app.textFields.matching(
            NSPredicate(
                format: "identifier == %@ AND value == %@",
                "outing.locationName",
                "Manual Test Location"
            )
        ).firstMatch
        XCTAssertTrue(
            manualLocation.existsOrWait(timeout: 5),
            "Manual location name was not applied"
        )
        XCTAssertTrue(
            app.descendants(matching: .any)["outing.locationLookupError"].disappearsOrWait(timeout: 5),
            "Reverse lookup failure remained visible after manual location entry"
        )
        XCTAssertTrue(
            app.descendants(matching: .any)["outing.locationAttribution"].existsOrWait(timeout: 5),
            "Static attribution disappeared after manual location entry"
        )
    }

    func testSuccessfulEmptyGeocodingExplainsCoordinateFallbackWithoutRetry() {
        let app = launchApp(extraArguments: [
            "--ui-test-geocoding-empty",
        ])
        _ = waitForOutingReview(in: app)

        startNewOuting(in: app)
        let locationName = app.textFields["outing.locationName"]
        XCTAssertTrue(locationName.existsOrWait(timeout: 15))
        XCTAssertTrue(scrollUntilVisible(locationName, in: app))
        XCTAssertEqual(locationValue(locationName), "47.712deg, -122.372deg")
        XCTAssertTrue(app.descendants(matching: .any)["outing.locationLookupEmpty"].exists)
        XCTAssertFalse(app.buttons["outing.locationRetry"].exists)

        locationName.tap()
        app.buttons["outing.locationClear"].tap()
        locationName.typeText("Manual Test Location")
        let manualLocation = app.textFields.matching(
            NSPredicate(
                format: "identifier == %@ AND value == %@",
                "outing.locationName",
                "Manual Test Location"
            )
        ).firstMatch
        XCTAssertTrue(manualLocation.existsOrWait(timeout: 5))
        XCTAssertTrue(
            app.descendants(matching: .any)["outing.locationLookupEmpty"].disappearsOrWait(timeout: 5),
            "Empty lookup hint remained visible after manual location entry"
        )
    }

    func testDismissingOutingReviewCancelsDelayedGeocoding() {
        let app = launchApp(extraArguments: ["--ui-test-geocoding-delay"])
        let continueButton = waitForOutingReview(in: app, requireEnabled: false)
        // Declining a matched outing is what starts the lookup for that account state.
        startNewOuting(in: app)
        XCTAssertFalse(continueButton.isEnabled, "Delayed geocoding was not in progress")

        let geocodingStatus = app.staticTexts["Identifying location from GPS..."]
        app.buttons["Close"].tap()
        XCTAssertTrue(app.alerts["Discard progress?"].existsOrWait(timeout: 5))
        app.alerts["Discard progress?"].buttons["Discard"].tap()
        XCTAssertTrue(
            app.buttons["Close"].disappearsOrWait(timeout: 5),
            "Wizard did not dismiss"
        )
        XCTAssertTrue(
            app.descendants(matching: .any).matching(
                NSPredicate(
                    format: "identifier == %@ AND value == %@",
                    "ui-test.dataSetupComplete",
                    "geocodingCancellationAcknowledged"
                )
            ).firstMatch
                .existsOrWait(timeout: 5),
            "Reverse geocoding did not acknowledge cancellation"
        )
        XCTAssertFalse(app.textFields["outing.locationName"].exists)
        XCTAssertFalse(geocodingStatus.exists)
    }
}
