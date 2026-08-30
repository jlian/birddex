@testable import WingDex
import Foundation
import UIKit
import XCTest

/// End-to-end accuracy on real bird photos.
///
/// BirdIdEngineTests proves the pipeline runs and the plumbing is wired. This
/// proves it is RIGHT: real JPEGs off disk, through the bundled Core ML model,
/// the Swift preprocessing and the ranker, checked against the species in the
/// file name.
///
/// A synthetic gradient cannot catch a transposed tensor, a mis-keyed
/// classifier row or a channel swap, because every one of those still returns a
/// confident bird. These photos would.
///
/// Reads from src/assets via #filePath, the same way the parity tests reach
/// ml/parity, so nothing extra ships in the app or the test bundle.
final class BirdIdAccuracyTests: XCTestCase {
    /// Photos whose subject is unambiguous, so a miss is a real regression
    /// rather than a genuinely hard call between two similar species.
    private static let expected: [(file: String, species: String)] = [
        ("Great_blue_heron_roosting_at_Carkeek_Park.jpg", "Great Blue Heron"),
        ("Mallard_drake_on_Union_Bay_Natural_Area.jpg", "Mallard"),
        ("Belted_kingfisher_above_Puget_Sound_Carkeek_Park.jpg", "Belted Kingfisher"),
        ("Stellers_Jay_eating_cherries_Seattle_backyard.jpg", "Steller's Jay"),
        ("Sanderling_foraging_Lake_Michigan_Chicago.jpg", "Sanderling"),
        ("Chukar_partridge_near_Haleakala_summit_Maui.jpg", "Chukar"),
        ("Dark-eyed_junco_in_foliage_Seattle_Arboretum.jpg", "Dark-eyed Junco"),
        ("Female_northern_cardinal_in_Chicago_park.jpg", "Northern Cardinal"),
    ]

    private static let imageDir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()   // WingDexTests
        .deletingLastPathComponent()   // ios
        .deletingLastPathComponent()   // repo root
        .appendingPathComponent("src/assets/images")

    func testIdentifiesRealBirdPhotosAndIncludesExpectedSpeciesInTopFive() async throws {
        var misses: [String] = []
        var missingFromTopFive: [String] = []
        var checked = 0

        for (file, species) in Self.expected {
            let url = Self.imageDir.appendingPathComponent(file)
            guard FileManager.default.fileExists(atPath: url.path) else { continue }
            checked += 1

            // No location: these are demo assets and the point here is the
            // vision path, not the geographic prior.
            let results = try await BirdIdEngine.shared.identify(
                imageData: try Data(contentsOf: url), location: nil, month: nil)
            let top = results.first
            if top?.commonName != species {
                misses.append("\(file): got \(top?.commonName ?? "nothing") "
                              + "(\(String(format: "%.3f", top?.confidence ?? 0))), want \(species)")
            }
            if !results.contains(where: { $0.commonName == species }) {
                missingFromTopFive.append("\(file): \(results.map(\.commonName).joined(separator: ", "))")
            }
        }

        try XCTSkipIf(checked == 0, "No demo images at \(Self.imageDir.path)")
        XCTAssertEqual(misses, [], "top-1 mismatches on \(checked) photos")
        XCTAssertEqual(missingFromTopFive, [], "expected species absent from the top 5")
    }

    func testOriginalBytesMatchFormerImportDerivativeTopOne() async throws {
        var mismatches: [String] = []
        var checked = 0

        for (file, _) in Self.expected {
            let url = Self.imageDir.appendingPathComponent(file)
            guard FileManager.default.fileExists(atPath: url.path) else { continue }
            let original = try Data(contentsOf: url)
            let image = try XCTUnwrap(UIImage(data: original))
            let formerDerivative = try XCTUnwrap(image.jpegData(compressionQuality: 0.7))
            checked += 1

            let originalTop = try await BirdIdEngine.shared.identify(
                imageData: original,
                location: nil,
                month: nil
            ).first?.commonName
            let derivativeTop = try await BirdIdEngine.shared.identify(
                imageData: formerDerivative,
                location: nil,
                month: nil
            ).first?.commonName
            if originalTop != derivativeTop {
                mismatches.append(
                    "\(file): original \(originalTop ?? "nothing"), derivative \(derivativeTop ?? "nothing")"
                )
            }
        }

        try XCTSkipIf(checked == 0, "No demo images at \(Self.imageDir.path)")
        XCTAssertEqual(mismatches, [], "removing the import re-encode changed top-1 results")
    }
}
