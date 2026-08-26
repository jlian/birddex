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
    /// Previews only. RenderPreview captures a single frame, so the only way to
    /// see the ping is to pin its phase and render a few.
    var previewPhase: CGFloat?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var unit: CGFloat = 10

    @State private var pinging = false
    @State private var phase: CGFloat = 0

    private var ringWidth: CGFloat { max(1, unit * 0.15) }
    /// Sized so the standalone dot carries at least as much ink as the hollow
    /// ring: off range is the rarer verdict of the two and must not read lighter.
    private var coreDiameter: CGFloat { state == .both ? unit * 0.42 : unit * 0.7 }

    private var shownPhase: CGFloat { previewPhase ?? phase }
    private var showsPing: Bool { previewPhase != nil || pinging }

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
            // A second ring leaving the mark, so the concentric form animates
            // outward from the shape it already has. It is mounted at phase 0,
            // where it sits exactly on the static ring and is fully opaque, and
            // the phase is animated afterwards; inserting it already expanded
            // and transparent would leave nothing to interpolate from and the
            // ping would never be seen.
            if showsPing {
                Circle()
                    .strokeBorder(Color.rarityMark, lineWidth: ringWidth)
                    .frame(width: unit, height: unit)
                    .scaleEffect(1 + shownPhase * 1.4)
                    .opacity(Double(1 - shownPhase))
            }
        }
        .frame(width: unit, height: unit)
        .accessibilityElement()
        .accessibilityLabel(state.accessibilityLabel ?? "")
        .accessibilityHidden(state == .none)
        .onChange(of: pingTrigger) { _, newValue in
            guard newValue != nil, state == .both, !reduceMotion else { return }
            pinging = true
            phase = 0
            Task {
                // Let the ring mount at phase 0 before animating, or SwiftUI
                // batches both into one frame and there is no visible start.
                await Task.yield()
                withAnimation(.easeOut(duration: 0.7)) { phase = 1 }
                try? await Task.sleep(for: .milliseconds(750))
                pinging = false
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
        // Both halves, because VoiceOver users cannot see that the glyph is a
        // dot inside a ring and would otherwise lose the seasonal reason.
        case .both: "Off its usual range and out of season for this area"
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
/// The ping, frozen at four points. RenderPreview captures one frame, so this
/// is the only way to check the motion without a simulator video.
#Preview("Ping phases") {
    HStack(spacing: 28) {
        ForEach([0.0, 0.33, 0.66, 1.0], id: \.self) { p in
            RarityMark(state: .both, previewPhase: CGFloat(p))
        }
    }
    .padding(40)
    .background(Color.pageBg)
}

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
