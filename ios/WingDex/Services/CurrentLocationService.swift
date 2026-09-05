import CoreLocation
import Foundation

enum CurrentLocationError: LocalizedError, Equatable {
    case servicesDisabled
    case denied
    case restricted
    case unavailable
    case timedOut

    var errorDescription: String? {
        switch self {
        case .servicesDisabled:
            "Location Services are off. Enable them in Settings or enter a location manually."
        case .denied:
            "Location access was denied. Allow access in Settings or enter a location manually."
        case .restricted:
            "Location access is restricted. You can enter a location manually."
        case .unavailable:
            "Couldn't determine your location. Try again or enter a location manually."
        case .timedOut:
            "Finding your location timed out. Try again or enter a location manually."
        }
    }
}

/// A foreground, tap-only request, separate from camera geotagging.
@MainActor
final class CurrentLocationService: NSObject, @preconcurrency CLLocationManagerDelegate {
    private let makeManager: () -> CLLocationManager
    private let servicesEnabled: () -> Bool
    private let timeout: Duration
    private var manager: CLLocationManager?
    private var continuation: CheckedContinuation<CLLocationCoordinate2D, Error>?
    private var timeoutTask: Task<Void, Never>?
    private var requestID: UUID?
    private var requestedLocation = false

    init(
        timeout: Duration = .seconds(15),
        servicesEnabled: @escaping () -> Bool = { CLLocationManager.locationServicesEnabled() },
        makeManager: @escaping () -> CLLocationManager = { CLLocationManager() }
    ) {
        self.timeout = timeout
        self.servicesEnabled = servicesEnabled
        self.makeManager = makeManager
        super.init()
    }

    /// Call only in response to an explicit current-location action.
    func request() async throws -> CLLocationCoordinate2D {
        try Task.checkCancellation()
        cancel()
        guard servicesEnabled() else { throw CurrentLocationError.servicesDisabled }
        let id = UUID()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                requestID = id
                // A fresh manager identifies callbacks from obsolete requests.
                let manager = makeManager()
                self.manager = manager
                manager.delegate = self
                manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
                timeoutTask = Task { [weak self, timeout] in
                    do {
                        try await Task.sleep(for: timeout)
                    } catch {
                        return
                    }
                    guard let self, self.requestID == id else { return }
                    self.finish(.failure(CurrentLocationError.timedOut))
                }
                if manager.authorizationStatus == .notDetermined {
                    manager.requestWhenInUseAuthorization()
                } else {
                    locationManagerDidChangeAuthorization(manager)
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                guard let self, self.requestID == id else { return }
                self.cancel()
            }
        }
    }

    func cancel() {
        finish(.failure(CancellationError()))
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard self.manager === manager, continuation != nil else { return }
        switch manager.authorizationStatus {
        case .notDetermined:
            // Initial delegate notification is not permission to prompt.
            break
        case .authorizedAlways, .authorizedWhenInUse:
            guard !requestedLocation else { return }
            requestedLocation = true
            manager.requestLocation()
        case .denied:
            finish(.failure(CurrentLocationError.denied))
        case .restricted:
            finish(.failure(CurrentLocationError.restricted))
        @unknown default:
            finish(.failure(CurrentLocationError.unavailable))
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard self.manager === manager, requestedLocation else { return }
        // Reduced accuracy is usable. Reject invalid/stale fixes, not coarse ones.
        guard let location = locations.last,
              CLLocationCoordinate2DIsValid(location.coordinate),
              location.horizontalAccuracy >= 0,
              abs(location.timestamp.timeIntervalSinceNow) <= 60
        else {
            finish(.failure(CurrentLocationError.unavailable))
            return
        }
        finish(.success(location.coordinate))
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        guard self.manager === manager else { return }
        let locationError = error as? CLError
        finish(.failure(locationError?.code == .denied
            ? CurrentLocationError.denied : CurrentLocationError.unavailable))
    }

    private func finish(_ result: Result<CLLocationCoordinate2D, Error>) {
        let continuation = continuation
        self.continuation = nil
        requestID = nil
        timeoutTask?.cancel()
        timeoutTask = nil
        manager?.delegate = nil
        manager?.stopUpdatingLocation()
        manager = nil
        requestedLocation = false
        continuation?.resume(with: result)
    }
}
