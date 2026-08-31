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
        let grouped = groupByDexKey(confirmed).sorted {
            getDisplayName($0.label).localizedCaseInsensitiveCompare(getDisplayName($1.label)) == .orderedAscending
        }
        let totalBirds = confirmed.reduce(0) { $0 + $1.count }

        var lines = [
            outing.locationName,
            DateFormatting.formatDate(outing.startTime, style: .medium),
            "\(grouped.count) species, \(totalBirds) bird\(totalBirds == 1 ? "" : "s")",
        ]

        if !grouped.isEmpty {
            lines.append("")
            // Reduce each group's own observations. Two groups can share a label,
            // so searching back by label would print the first group's count
            // twice and drop the second; mapping the groups keeps them distinct.
            lines.append(contentsOf: grouped.map { group in
                let count = group.observations.reduce(0) { $0 + $1.count }
                return "\(count)x \(getDisplayName(group.label))"
            })
        }

        lines.append("")
        lines.append("Shared from WingDex")
        return lines.joined(separator: "\n")
    }
}