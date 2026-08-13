import SwiftUI

/// A lifer celebration: one or more species just added to the user's WingDex.
///
/// Mirrors the web app's confetti + lifer toast that fires when new species
/// are recorded (after an AddPhotos save or an eBird import).
struct LiferCelebration: Equatable, Identifiable {
    let id = UUID()
    var newSpeciesCount: Int
    /// Display names of the newly added species. May be empty when only a count is known.
    var speciesNames: [String]
    var messageOverride: String?

    var bannerMessage: String {
        messageOverride ?? Self.bannerMessage(newSpeciesCount: newSpeciesCount, speciesNames: speciesNames)
    }

    /// Build the banner text. Pure function so it can be unit tested.
    static func bannerMessage(newSpeciesCount: Int, speciesNames: [String]) -> String {
        let names = speciesNames.filter { !$0.isEmpty }
        guard !names.isEmpty else {
            return "\(newSpeciesCount) new species added to your WingDex"
        }
        let preview = names.prefix(3).joined(separator: ", ")
        let remainder = names.count - min(names.count, 3)
        let suffix = remainder > 0 ? " +\(remainder) more" : ""
        return "\(preview)\(suffix) added to your WingDex"
    }
}

struct TransientNotice: Equatable, Identifiable {
    let id = UUID()
    let message: String
    var symbol = "checkmark.circle.fill"
}

extension View {
    /// Present a lifer celebration (banner + confetti + success haptic) when the
    /// bound value becomes non-nil. Auto-dismisses after a few seconds. Respects
    /// Reduce Motion by skipping confetti and fading the banner in gently.
    func celebration(_ celebration: Binding<LiferCelebration?>) -> some View {
        modifier(CelebrationModifier(celebration: celebration))
    }

    func transientNotice(_ notice: Binding<TransientNotice?>) -> some View {
        modifier(TransientNoticeModifier(notice: notice))
    }
}

private struct TransientNoticeModifier: ViewModifier {
    @Binding var notice: TransientNotice?

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .top) {
                if let notice {
                    StatusBanner(message: notice.message, symbol: notice.symbol)
                        .padding(.horizontal)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .animation(.spring(response: 0.4, dampingFraction: 0.8), value: notice)
            .sensoryFeedback(.success, trigger: notice)
            .onChange(of: notice) { _, newValue in
                guard let newValue else { return }
                UIAccessibility.post(notification: .announcement, argument: newValue.message)
                Task {
                    try? await Task.sleep(for: .seconds(4))
                    if notice?.id == newValue.id { notice = nil }
                }
            }
    }
}

// MARK: - Modifier

private struct CelebrationModifier: ViewModifier {
    @Binding var celebration: LiferCelebration?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var confettiRunID: UUID?

    func body(content: Content) -> some View {
        content
            .overlay {
                if let run = confettiRunID, !reduceMotion {
                    ConfettiView()
                        .id(run)
                        .allowsHitTesting(false)
                        .ignoresSafeArea()
                }
            }
            .overlay(alignment: .top) {
                if let celebration {
                    StatusBanner(message: celebration.bannerMessage, symbol: "sparkles")
                        .padding(.horizontal)
                        .transition(
                            reduceMotion
                                ? .opacity
                                : .move(edge: .top).combined(with: .opacity)
                        )
                }
            }
            .animation(.spring(response: 0.4, dampingFraction: 0.8), value: celebration)
            .sensoryFeedback(trigger: celebration) { _, newValue in
                newValue != nil ? .success : nil
            }
            .onChange(of: celebration) { _, newValue in
                guard let newValue else { return }
                UIAccessibility.post(notification: .announcement, argument: newValue.bannerMessage)

                if !reduceMotion {
                    confettiRunID = newValue.id
                    Task {
                        try? await Task.sleep(for: .milliseconds(1400))
                        if confettiRunID == newValue.id {
                            confettiRunID = nil
                        }
                    }
                }

                Task {
                    try? await Task.sleep(for: .seconds(3))
                    if celebration?.id == newValue.id {
                        celebration = nil
                    }
                }
            }
    }
}

// MARK: - Banner

private struct StatusBanner: View {
    let message: String
    let symbol: String

    var body: some View {
        Label {
            Text(message)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Color.foregroundText)
                .multilineTextAlignment(.leading)
        } icon: {
            Image(systemName: symbol)
                .foregroundStyle(Color.accentColor)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(.regularMaterial, in: Capsule())
        .overlay(Capsule().stroke(Color.accentColor.opacity(0.3), lineWidth: 1))
        .shadow(color: .black.opacity(0.15), radius: 8, y: 4)
        .padding(.top, 8)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(message)
    }
}

// MARK: - Confetti

/// A short, lightweight confetti burst drawn with Canvas + TimelineView.
///
/// Particle positions use closed-form projectile motion so each frame can be
/// drawn purely from the elapsed time without mutable per-frame state.
private struct ConfettiView: View {
    @State private var particles = ConfettiParticle.makeBurst(count: 80)
    @State private var startDate = Date()
    private let duration: TimeInterval = 1.4

    var body: some View {
        TimelineView(.animation) { timeline in
            Canvas { context, size in
                let elapsed = timeline.date.timeIntervalSince(startDate)
                guard elapsed <= duration else { return }

                let fadeStart = duration * 0.6
                let globalFade = elapsed > fadeStart
                    ? 1 - (elapsed - fadeStart) / (duration - fadeStart)
                    : 1
                let frame = elapsed * 60
                let gravity = 0.25

                for particle in particles {
                    let x = particle.startXFraction * size.width + particle.velocityX * frame
                    let y = particle.startYFraction * size.height
                        + particle.velocityY * frame
                        + 0.5 * gravity * frame * frame
                    let angle = Angle.degrees(particle.rotation + particle.rotationSpeed * frame)

                    var layer = context
                    layer.opacity = globalFade
                    layer.translateBy(x: x, y: y)
                    layer.rotate(by: angle)
                    layer.fill(particle.path, with: .color(particle.color))
                }
            }
        }
    }
}

private struct ConfettiParticle {
    enum Shape { case circle, rect, star }

    let startXFraction: Double
    let startYFraction: Double
    let velocityX: Double
    let velocityY: Double
    let size: Double
    let color: Color
    let rotation: Double
    let rotationSpeed: Double
    let shape: Shape

    /// Path centered on the origin, ready to be translated/rotated by the drawing context.
    var path: Path {
        switch shape {
        case .circle:
            return Path(ellipseIn: CGRect(x: -size / 2, y: -size / 2, width: size, height: size))
        case .rect:
            return Path(CGRect(x: -size / 2, y: -size / 4, width: size, height: size / 2))
        case .star:
            return Self.starPath(outerRadius: size / 2, innerRadius: size / 4)
        }
    }

    static func makeBurst(count: Int) -> [ConfettiParticle] {
        let palette: [Color] = [.green, .blue, .orange, .red, .purple, .pink, .teal, .yellow]
        let shapes: [Shape] = [.circle, .rect, .star]
        return (0..<count).map { _ in
            ConfettiParticle(
                startXFraction: 0.5 + Double.random(in: -0.2...0.2),
                startYFraction: 0.4,
                velocityX: Double.random(in: -6...6),
                velocityY: Double.random(in: -18 ... -4),
                size: Double.random(in: 6...12),
                color: palette.randomElement() ?? .green,
                rotation: Double.random(in: 0...360),
                rotationSpeed: Double.random(in: -12...12),
                shape: shapes.randomElement() ?? .circle
            )
        }
    }

    static func starPath(outerRadius: Double, innerRadius: Double) -> Path {
        var path = Path()
        let points = 5
        for i in 0..<(points * 2) {
            let radius = i.isMultiple(of: 2) ? outerRadius : innerRadius
            let angle = Double(i) * .pi / Double(points) - .pi / 2
            let point = CGPoint(x: cos(angle) * radius, y: sin(angle) * radius)
            if i == 0 {
                path.move(to: point)
            } else {
                path.addLine(to: point)
            }
        }
        path.closeSubpath()
        return path
    }
}

// MARK: - Preview

#if DEBUG
#Preview {
    struct Harness: View {
        @State private var celebration: LiferCelebration?
        var body: some View {
            ZStack {
                Color.pageBg.ignoresSafeArea()
                Button("Celebrate") {
                    celebration = LiferCelebration(
                        newSpeciesCount: 3,
                        speciesNames: ["Northern Cardinal", "Blue Jay", "American Robin"]
                    )
                }
                .buttonStyle(.borderedProminent)
            }
            .celebration($celebration)
        }
    }
    return Harness()
}
#endif
