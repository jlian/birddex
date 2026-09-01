@testable import WingDex
import XCTest

final class CelebrationTests: XCTestCase {
    func testSuccessNoticeDefaults() {
        let notice = TransientNotice.success("Saved")

        XCTAssertEqual(notice.message, "Saved")
        XCTAssertEqual(notice.symbol, "checkmark.circle.fill")
        XCTAssertEqual(notice.kind, .success)
    }

    func testErrorNoticeDefaults() {
        let notice = TransientNotice.error("Authentication failed")

        XCTAssertEqual(notice.message, "Authentication failed")
        XCTAssertEqual(notice.symbol, "exclamationmark.circle.fill")
        XCTAssertEqual(notice.kind, .error)
    }

    func testBannerMessageWithNamesListsUpToThree() {
        let message = LiferCelebration.bannerMessage(
            newSpeciesCount: 2,
            speciesNames: ["Northern Cardinal", "Blue Jay"]
        )
        XCTAssertEqual(message, "Northern Cardinal, Blue Jay added to your WingDex")
    }

    func testBannerMessageWithMoreThanThreeNamesAddsRemainder() {
        let message = LiferCelebration.bannerMessage(
            newSpeciesCount: 5,
            speciesNames: ["Northern Cardinal", "Blue Jay", "American Robin", "House Finch", "Song Sparrow"]
        )
        XCTAssertEqual(message, "Northern Cardinal, Blue Jay, American Robin +2 more added to your WingDex")
    }

    func testBannerMessageWithoutNamesFallsBackToCount() {
        let message = LiferCelebration.bannerMessage(newSpeciesCount: 3, speciesNames: [])
        XCTAssertEqual(message, "3 new species added to your WingDex")
    }

    func testBannerMessageIgnoresEmptyNames() {
        let message = LiferCelebration.bannerMessage(
            newSpeciesCount: 1,
            speciesNames: ["", "Blue Jay"]
        )
        XCTAssertEqual(message, "Blue Jay added to your WingDex")
    }
}
