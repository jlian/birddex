import Foundation

enum SharePayload {
    static func species(_ entry: DexEntry) -> String {
        var lines = [getDisplayName(entry.speciesName)]
        if let scientificName = getScientificName(entry.speciesName) {
            lines.append(scientificName)
        }
        lines.append(
            "\(entry.totalCount) observed across \(entry.totalOutings) outing\(entry.totalOutings == 1 ? "" : "s")"
        )
        lines.append("First seen \(DateFormatting.formatDate(entry.firstSeenDate, style: .medium))")
        lines.append("Last seen \(DateFormatting.formatDate(entry.lastSeenDate, style: .medium))")
        lines.append("Shared from WingDex")
        return lines.joined(separator: "\n")
    }

    static func outing(_ outing: Outing, observations: [BirdObservation]) -> String {
        let confirmed = observations.filter { $0.certainty == .confirmed }
        // Group by the dex key so a bird recorded under two spellings shares one
        // line and the species count matches what the app shows elsewhere.
        let grouped = groupByDexKey(confirmed)
        let species = grouped.map(\.label).sorted {
            getDisplayName($0).localizedCaseInsensitiveCompare(getDisplayName($1)) == .orderedAscending
        }
        let totalBirds = confirmed.reduce(0) { $0 + $1.count }

        var lines = [
            outing.locationName,
            DateFormatting.formatDate(outing.startTime, style: .medium),
            "\(species.count) species, \(totalBirds) bird\(totalBirds == 1 ? "" : "s")",
        ]

        if !species.isEmpty {
            lines.append("")
            lines.append(contentsOf: species.map { speciesName in
                let count = grouped
                    .first { $0.label == speciesName }?
                    .observations.reduce(0) { $0 + $1.count } ?? 0
                return "\(count)x \(getDisplayName(speciesName))"
            })
        }

        lines.append("")
        lines.append("Shared from WingDex")
        return lines.joined(separator: "\n")
    }
}