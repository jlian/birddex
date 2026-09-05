import CoreLocation
import XCTest
@testable import WingDex

@MainActor
final class CurrentLocationServiceTests: XCTestCase {
    private final class Manager: CLLocationManager {
        var status: CLAuthorizationStatus = .notDetermined
        var authorizationRequests = 0
        var locationRequests = 0
        var stops = 0

        override var authorizationStatus: CLAuthorizationStatus { status }
        override func requestWhenInUseAuthorization() { authorizationRequests += 1 }
        override func requestLocation() { locationRequests += 1 }
        override func stopUpdatingLocation() { stops += 1 }
    }

    private func fix(accuracy: Double = 5_000, age: TimeInterval = 0) -> CLLocation {
        CLLocation(
            coordinate: CLLocationCoordinate2D(latitude: 47.7115123, longitude: -122.3717456),
            altitude: 0, horizontalAccuracy: accuracy, verticalAccuracy: -1,
            timestamp: Date().addingTimeInterval(-age)
        )
    }

    func testDoesNotCreateManagerOrPromptUntilRequested() async throws {
        let manager = Manager()
        let started = expectation(description: "request started")
        let service = CurrentLocationService(servicesEnabled: { true }, makeManager: {
            started.fulfill()
            return manager
        })
        XCTAssertEqual(manager.authorizationRequests, 0)
        XCTAssertEqual(manager.locationRequests, 0)
        let task = Task { try await service.request() }
        await fulfillment(of: [started], timeout: 1)
        XCTAssertEqual(manager.authorizationRequests, 1)
        service.locationManagerDidChangeAuthorization(manager)
        XCTAssertEqual(manager.authorizationRequests, 1)
        XCTAssertEqual(manager.locationRequests, 0)
        manager.status = .authorizedWhenInUse
        service.locationManagerDidChangeAuthorization(manager)
        service.locationManagerDidChangeAuthorization(manager)
        XCTAssertEqual(manager.locationRequests, 1)
        service.locationManager(manager, didUpdateLocations: [fix()])
        let coordinate = try await task.value
        XCTAssertEqual(coordinate.latitude, 47.7115123)
        XCTAssertEqual(coordinate.longitude, -122.3717456)
        XCTAssertEqual(manager.stops, 1)
        XCTAssertNil(manager.delegate)
    }

    func testDisabledServicesNeverPrompt() async {
        let service = CurrentLocationService(servicesEnabled: { false }, makeManager: {
            XCTFail("Disabled services must not create a manager")
            return Manager()
        })
        do {
            _ = try await service.request()
            XCTFail("Expected disabled services")
        } catch {
            XCTAssertEqual(error as? CurrentLocationError, .servicesDisabled)
        }
    }

    func testDeniedAndRestrictedAuthorizationFailWithoutRequesting() async {
        for (status, expected) in [
            (CLAuthorizationStatus.denied, CurrentLocationError.denied),
            (.restricted, .restricted),
        ] {
            let manager = Manager()
            manager.status = status
            let service = CurrentLocationService(servicesEnabled: { true }, makeManager: { manager })
            do {
                _ = try await service.request()
                XCTFail("Expected authorization error")
            } catch {
                XCTAssertEqual(error as? CurrentLocationError, expected)
            }
            XCTAssertEqual(manager.authorizationRequests, 0)
            XCTAssertEqual(manager.locationRequests, 0)
        }
    }

    func testTimeoutIncludesUnansweredPermissionPrompt() async {
        let manager = Manager()
        let service = CurrentLocationService(
            timeout: .milliseconds(10), servicesEnabled: { true }, makeManager: { manager }
        )
        do {
            _ = try await service.request()
            XCTFail("Expected timeout")
        } catch {
            XCTAssertEqual(error as? CurrentLocationError, .timedOut)
        }
        XCTAssertEqual(manager.stops, 1)
        XCTAssertNil(manager.delegate)
    }

    func testInvalidStaleAndUnavailableFixesFail() async {
        for location in [fix(accuracy: -1), fix(age: 120), nil] {
            let manager = Manager()
            manager.status = .authorizedWhenInUse
            let started = expectation(description: "request started")
            let service = CurrentLocationService(servicesEnabled: { true }, makeManager: {
                started.fulfill()
                return manager
            })
            let task = Task { try await service.request() }
            await fulfillment(of: [started], timeout: 1)
            if let location {
                service.locationManager(manager, didUpdateLocations: [location])
            } else {
                service.locationManager(manager, didFailWithError: CLError(.locationUnknown))
            }
            do {
                _ = try await task.value
                XCTFail("Expected unavailable")
            } catch {
                XCTAssertEqual(error as? CurrentLocationError, .unavailable)
            }
        }
    }

    func testCancellationAndReplacementIgnoreLateCallbacks() async throws {
        let old = Manager()
        let new = Manager()
        old.status = .authorizedWhenInUse
        new.status = .authorizedWhenInUse
        let firstStarted = expectation(description: "first started")
        let secondStarted = expectation(description: "second started")
        var calls = 0
        let service = CurrentLocationService(servicesEnabled: { true }, makeManager: {
            calls += 1
            (calls == 1 ? firstStarted : secondStarted).fulfill()
            return calls == 1 ? old : new
        })
        let first = Task { try await service.request() }
        await fulfillment(of: [firstStarted], timeout: 1)
        let second = Task { try await service.request() }
        await fulfillment(of: [secondStarted], timeout: 1)
        first.cancel()
        service.locationManager(old, didUpdateLocations: [fix()])
        service.locationManager(old, didFailWithError: CLError(.denied))
        service.locationManagerDidChangeAuthorization(old)
        service.locationManager(new, didUpdateLocations: [fix()])
        do {
            _ = try await first.value
            XCTFail("Expected cancellation")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }
        let result = try await second.value
        XCTAssertEqual(result.latitude, 47.7115123)
        XCTAssertEqual(old.stops, 1)
        XCTAssertEqual(new.stops, 1)
    }

    func testTaskCancellationStopsAcquisition() async {
        let manager = Manager()
        manager.status = .authorizedWhenInUse
        let started = expectation(description: "started")
        let service = CurrentLocationService(servicesEnabled: { true }, makeManager: {
            started.fulfill()
            return manager
        })
        let task = Task { try await service.request() }
        await fulfillment(of: [started], timeout: 1)
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("Expected cancellation")
        } catch {
            XCTAssertTrue(error is CancellationError)
        }
        XCTAssertEqual(manager.stops, 1)
    }
}
