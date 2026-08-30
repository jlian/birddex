@testable import WingDex
import XCTest

@MainActor
final class TaxonomyOrderTests: XCTestCase {
    override func setUp() async throws {
        try await super.setUp()
        await prewarmTaxonomyLookups()
    }

    func testTaxonomyOrderUsesBundledSequence() {
        XCTAssertLessThan(getTaxonomicOrder("Common Ostrich"), getTaxonomicOrder("Emu"))
    }

    func testTaxonomyOrderStripsScientificNameAndIgnoresCase() {
        XCTAssertEqual(
            getTaxonomicOrder("common ostrich (Struthio camelus)"),
            getTaxonomicOrder("Common Ostrich")
        )
    }

    func testUnknownSpeciesSortAfterKnownSpecies() {
        XCTAssertEqual(getTaxonomicOrder("Imaginary Bird"), Int.max)
        XCTAssertLessThan(getTaxonomicOrder("Common Ostrich"), getTaxonomicOrder("Imaginary Bird"))
    }

    func testUnknownSpeciesRemainLastInBothDirections() {
        let species = ["Imaginary Bird", "Common Ostrich", "Emu", "Another Mystery"]

        XCTAssertEqual(
            species.sorted { taxonomicSpeciesPrecedes($0, $1, ascending: true) },
            ["Common Ostrich", "Emu", "Another Mystery", "Imaginary Bird"]
        )
        XCTAssertEqual(
            species.sorted { taxonomicSpeciesPrecedes($0, $1, ascending: false) },
            ["Emu", "Common Ostrich", "Another Mystery", "Imaginary Bird"]
        )
    }

    // MARK: - Wikipedia titles

    /// Asserted exactly, and on species whose article title differs from the common
    /// name, so reading a neighbouring taxonomy column cannot pass: the scientific
    /// name and the eBird code sit either side of this one and are also non-empty
    /// strings, so an index slip would compile and produce broken links silently.
    /// Mirrors the web taxonomy-order tests.
    func testWikiTitleReadsTheArticleTitleColumn() {
        XCTAssertEqual(getWikiTitle(forSpecies: "Northern Cardinal"), "Northern cardinal")
        XCTAssertEqual(getWikiTitle(forSpecies: "Rock Pigeon"), "Rock dove")
        XCTAssertEqual(getWikiTitle(forSpecies: "Chukar"), "Chukar partridge")
    }

    func testWikiTitleStripsScientificNameAndIgnoresCase() {
        XCTAssertEqual(getWikiTitle(forSpecies: "Rock Pigeon (Columba livia)"), "Rock dove")
        XCTAssertEqual(getWikiTitle(forSpecies: "rock pigeon"), "Rock dove")
    }

    func testWikiTitleIsNilForUnknownSpecies() {
        XCTAssertNil(getWikiTitle(forSpecies: "Fake Bird That Does Not Exist"))
    }

    /// The article title is what the URL is built from, so the two must agree.
    func testWikipediaURLUsesTheArticleTitle() {
        XCTAssertEqual(
            getWikipediaURL(forSpecies: "Rock Pigeon"),
            URL(string: "https://en.wikipedia.org/wiki/Rock%20dove")
        )
        XCTAssertNil(getWikipediaURL(forSpecies: "Fake Bird That Does Not Exist"))
    }
}