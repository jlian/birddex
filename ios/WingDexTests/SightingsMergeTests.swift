@testable import WingDex
import XCTest

final class SightingsMergeTests: XCTestCase {
    private func outing(_ id: String) -> Outing {
        Outing(
            id: id,
            userId: "user",
            startTime: "2026-09-28T16:01:00Z",
            endTime: "2026-09-28T17:01:00Z",
            locationName: "Montrose Point Bird Sanctuary, Chicago",
            notes: "",
            createdAt: "2026-09-28T16:01:00Z"
        )
    }

    private func observation(
        _ id: String,
        outingId: String,
        count: Int = 1,
        certainty: ObservationStatus = .confirmed
    ) -> BirdObservation {
        BirdObservation(
            id: id,
            outingId: outingId,
            speciesName: "Northern Cardinal (Cardinalis cardinalis)",
            count: count,
            certainty: certainty,
            notes: ""
        )
    }

    func testAddsUpRepeatObservationsFromTheSameOuting() {
        let trip = outing("outing-1")
        let merged = mergeSightingsByOuting([
            (observation: observation("obs-1", outingId: trip.id), outing: trip),
            (observation: observation("obs-2", outingId: trip.id), outing: trip),
        ])

        XCTAssertEqual(merged.count, 1)
        XCTAssertEqual(merged[0].observation.count, 2)
        XCTAssertEqual(merged[0].observation.id, "obs-1")
    }

    func testKeepsSeparateOutingsApart() {
        let first = outing("outing-1")
        let second = outing("outing-2")
        let merged = mergeSightingsByOuting([
            (observation: observation("obs-1", outingId: first.id), outing: first),
            (observation: observation("obs-2", outingId: second.id), outing: second),
        ])

        XCTAssertEqual(merged.map(\.outing.id), ["outing-1", "outing-2"])
        XCTAssertEqual(merged.map(\.observation.count), [1, 1])
    }

    func testDoesNotFoldPossibleIntoConfirmed() {
        let trip = outing("outing-1")
        let merged = mergeSightingsByOuting([
            (observation: observation("obs-1", outingId: trip.id), outing: trip),
            (
                observation: observation("obs-2", outingId: trip.id, certainty: .possible),
                outing: trip
            ),
        ])

        XCTAssertEqual(merged.count, 2)
        XCTAssertEqual(merged.map(\.observation.certainty), [.confirmed, .possible])
    }

    func testPreservesExistingCountsWhenAddingUp() {
        let trip = outing("outing-1")
        let merged = mergeSightingsByOuting([
            (observation: observation("obs-1", outingId: trip.id, count: 3), outing: trip),
            (observation: observation("obs-2", outingId: trip.id, count: 2), outing: trip),
        ])

        XCTAssertEqual(merged.count, 1)
        XCTAssertEqual(merged[0].observation.count, 5)
    }

    func testEmptyInputProducesNoRows() {
        XCTAssertTrue(mergeSightingsByOuting([]).isEmpty)
    }
}
