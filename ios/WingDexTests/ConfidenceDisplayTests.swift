@testable import WingDex
import XCTest

/// Confidence display.
///
/// The PR review asked whether the 0% splits were real. They are not: across
/// 400 labelled held-out photos no candidate was ever exactly zero, but 91% of
/// the 2nd-to-5th candidates fell below 0.5% and rounded to a flat "0%". The
/// median second candidate is 0.035%.
final class ConfidenceDisplayTests: XCTestCase {
    func testNeverRendersARealValueAsZeroPercent() {
        for p in [0.0000001, 0.00035, 0.001, 0.004, 0.00499] {
            XCTAssertEqual(BirdIdEngine.formatConfidence(p), "<0.5%", "for \(p)")
        }
    }

    func testSwitchesToPercentageExactlyWhereRoundingStopsGivingZero() {
        XCTAssertEqual(BirdIdEngine.formatConfidence(0.0049), "<0.5%")
        XCTAssertEqual(BirdIdEngine.formatConfidence(0.005), "1%")
    }

    func testRoundsNormallyAboveTheBound() {
        XCTAssertEqual(BirdIdEngine.formatConfidence(0.5), "50%")
        XCTAssertEqual(BirdIdEngine.formatConfidence(0.9963), "100%")
        XCTAssertEqual(BirdIdEngine.formatConfidence(1), "100%")
    }

    func testRejectsNaNAndNegatives() {
        XCTAssertEqual(BirdIdEngine.formatConfidence(.nan), "-")
        XCTAssertEqual(BirdIdEngine.formatConfidence(-1), "-")
    }

    /// Raised from 0.7 after measuring against Imagenette dogs: 0.8 rejects 76%
    /// of dog photos against 70% at 0.7, for 2 points of bird coverage.
    func testPromptThresholdMatchesWeb() {
        XCTAssertEqual(BirdIdEngine.confidencePromptThreshold, 0.8)
    }
}
