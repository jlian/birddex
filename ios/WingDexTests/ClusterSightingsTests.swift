@testable import WingDex
import XCTest

/// An outing is only written once its cluster produced a sighting, so this decision is what
/// keeps a discarded or entirely skipped session from leaving an empty outing behind.
final class ClusterSightingsTests: XCTestCase {
    private func result(
        _ id: String,
        status: ObservationStatus,
        species: String = "Northern Cardinal (Cardinalis cardinalis)"
    ) -> PhotoResult {
        PhotoResult(photoId: id, species: species, confidence: 0.9, status: status, count: 1)
    }

    func testSkippingEveryPhotoEarnsNoOuting() {
        let results = [
            result("p1", status: .rejected),
            result("p2", status: .rejected),
        ]
        XCTAssertTrue(sightingResults(results).isEmpty)
    }

    func testPossibleCountsAsASighting() {
        let results = [result("p1", status: .possible)]
        XCTAssertEqual(sightingResults(results).count, 1)
    }

    func testPendingDoesNotCountAsASighting() {
        let results = [result("p1", status: .pending)]
        XCTAssertTrue(sightingResults(results).isEmpty)
    }

    func testKeepsConfirmedAndPossibleFromAMixedCluster() {
        let results = [
            result("p1", status: .confirmed),
            result("p2", status: .rejected),
            result("p3", status: .possible),
            result("p4", status: .pending),
        ]
        XCTAssertEqual(sightingResults(results).map(\.photoId), ["p1", "p3"])
    }

    func testAClusterWithNoPhotosEarnsNoOuting() {
        XCTAssertTrue(sightingResults([]).isEmpty)
    }
}
