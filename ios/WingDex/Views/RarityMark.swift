import SwiftUI

/// The rarity mark: one small concentric glyph, three readings.
///
///   core dot only   off its range      place is a point
///   ring only       out of season      time is a cycle
///   dot in ring     both               wrong place AND wrong month
///
/// Composed rather than three separate icons, so the vocabulary is learnable in
/// one look and the rarest state is also the visually heaviest. Amber, not red:
/// red reads as an error, and orange is eBird's "this needs documenting" flag.
/// Colour never carries the meaning on its own; the form does, and every state
/// has a VoiceOver label.
///
/// All three occupy the SAME footprint so marks line up down a list and a row
/// does not change height when its verdict changes.
struct RarityMark: View {
    let state: RarityState
    /// Fires the ping once when this changes to a non-nil value. Only the
    /// concentric state animates, and only where the user just did something.
    var pingTrigger: AnyHashable?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var unit: CGFloat = 10

    @State private var ping = false

    private var ringWidth: CGFloat { max(1, unit * 0.15) }
    /// Sized so the standalone dot carries at least as much ink as the hollow
    /// ring: off range is the rarer verdict of the two and must not read lighter.
    private var coreDiameter: CGFloat { state == .both ? unit * 0.42 : unit * 0.7 }

    var body: some View {
        ZStack {
            if state == .outOfSeason || state == .both {
                Circle()
                    .strokeBorder(Color.rarityMark, lineWidth: ringWidth)
                    .frame(width: unit, height: unit)
            }
            if state == .offRange || state == .both {
                Circle()
                    .fill(Color.rarityMark)
                    .frame(width: coreDiameter, height: coreDiameter)
            }
            // The ping is a second ring leaving the core, so the concentric
            // form animates into the shape it already has rather than arriving
            // as unrelated motion.
            if ping {
                Circle()
                    .strokeBorder(Color.rarityMark, lineWidth: ringWidth)
                    .frame(width: unit, height: unit)
                    .scaleEffect(2.2)
                    .opacity(0)
                    .transition(.identity)
            }
        }
        .frame(width: unit, height: unit)
        .animation(.easeOut(duration: 0.7), value: ping)
        .accessibilityElement()
        .accessibilityLabel(state.accessibilityLabel ?? "")
        .accessibilityHidden(state == .none)
        .onChange(of: pingTrigger) { _, newValue in
            guard newValue != nil, state == .both, !reduceMotion else { return }
            ping = true
            Task {
                try? await Task.sleep(for: .milliseconds(700))
                ping = false
            }
        }
    }
}

extension RarityState {
    /// Short enough to sit on a row's subtitle line.
    var shortLabel: String? {
        switch self {
        case .none: nil
        case .outOfSeason: "Out of season"
        case .offRange: "Off range"
        case .both: "Rarely seen here"
        }
    }

    /// Spoken, so it has to stand alone without the glyph.
    var accessibilityLabel: String? {
        switch self {
        case .none: nil
        case .outOfSeason: "Out of season for this area"
        case .offRange: "Off its usual range"
        case .both: "Rarely recorded in this area"
        }
    }

    /// Said once, at the moment the user confirms it. Birders really do call a
    /// national-level rarity a mega, which is the register this wants: insider
    /// language rather than game language, and no score attached.
    var celebrationMessage: String? {
        switch self {
        case .none, .offRange, .outOfSeason: nil
        case .both: "Mega. Rarely recorded around here."
        }
    }
}

#Preview("States") {
    VStack(alignment: .leading, spacing: 20) {
        ForEach(RarityState.allCases, id: \.self) { state in
            HStack(spacing: 10) {
                RarityMark(state: state)
                Text(state.shortLabel ?? "no mark")
                    .font(.system(.body, design: .serif))
            }
        }
    }
    .padding(40)
    .background(Color.pageBg)
}

/// The mark at the size and weight it actually ships at, beside a serif species
/// name. Uses explicit states rather than the store because the asset loads
/// asynchronously and a preview snapshot is taken before that finishes.
#Preview("In a row") {
    let rows: [(String, String, RarityState)] = [
        ("American Robin", "Turdus migratorius", .none),
        ("Rufous Hummingbird", "Selasphorus rufus", .outOfSeason),
        ("Snow Bunting", "Plectrophenax nivalis", .offRange),
        ("Northern Cardinal", "Cardinalis cardinalis", .both),
    ]
    return VStack(alignment: .leading, spacing: 0) {
        ForEach(rows, id: \.0) { name, sci, state in
            HStack(spacing: 12) {
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color.warmBorder.opacity(0.3))
                    .frame(width: 48, height: 48)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 5) {
                        Text(name)
                            .font(.system(.body, design: .serif, weight: .semibold))
                            .foregroundStyle(Color.foregroundText)
                        RarityMark(state: state)
                    }
                    Text(sci)
                        .font(.caption).italic()
                        .foregroundStyle(Color.mutedText)
                }
                Spacer()
            }
            .frame(minHeight: 56)
            .padding(.horizontal)
        }
    }
    .background(Color.pageBg)
}
