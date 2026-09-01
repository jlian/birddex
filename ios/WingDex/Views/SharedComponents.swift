import SwiftUI
import MapKit
import UIKit

// MARK: - System Share Sheet

struct ExportFileItem: Identifiable {
    let id = UUID()
    let url: URL
    let cleanupDirectory: URL?

    init(url: URL, cleanupDirectory: URL? = nil) {
        self.url = url
        self.cleanupDirectory = cleanupDirectory
    }

    func cleanup() {
        guard let cleanupDirectory else { return }
        try? FileManager.default.removeItem(at: cleanupDirectory)
    }
}

struct ActivityView: UIViewControllerRepresentable {
    let item: ExportFileItem

    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: [item.url], applicationActivities: nil)
        controller.completionWithItemsHandler = { _, _, _, _ in item.cleanup() }
        return controller
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

struct OutingActionDestination: Identifiable, Hashable {
    let outing: Outing
    let beginsLocationEditing: Bool

    var id: String { "\(outing.id):\(beginsLocationEditing)" }
}

private struct OutingRowActionsModifier: ViewModifier {
    let outing: Outing
    @Binding var pendingDeletion: Outing?
    let onView: () -> Void
    let onEditLocation: () -> Void

    @Environment(AuthService.self) private var auth
    @Environment(DataStore.self) private var store
    @Environment(ToastCenter.self) private var toasts
    @State private var exportItem: ExportFileItem?
    @State private var isExporting = false
    @State private var operationError: String?

    private var observations: [BirdObservation] {
        store.confirmedObservations(outing.id)
    }

    func body(content: Content) -> some View {
        content
            .contextMenu {
                Button(action: onView) {
                    Label("View Details", systemImage: "binoculars")
                }
                Button(action: onEditLocation) {
                    Label("Edit Location", systemImage: "pencil")
                }
                .disabled(!store.hasLoadedAll)
                if auth.isRegisteredAccount {
                    Button {
                        Task { await exportOuting() }
                    } label: {
                        Label("Export eBird CSV", systemImage: "square.and.arrow.up")
                    }
                    .disabled(observations.isEmpty || isExporting)
                }
                ShareLink(item: SharePayload.outing(outing, observations: observations)) {
                    Label("Share Summary", systemImage: "text.bubble")
                }
                Button(role: .destructive) {
                    pendingDeletion = outing
                } label: {
                    Label("Delete Outing", systemImage: "trash")
                }
                .disabled(!store.hasLoadedAll)
            } preview: {
                // Context-menu previews render outside the app's environment hierarchy.
                NavigationStack {
                    OutingDetailView(outingId: outing.id)
                }
                .environment(auth)
                .environment(store)
                .environment(toasts)
            }
            .swipeActions(edge: .leading, allowsFullSwipe: false) {
                if auth.isRegisteredAccount {
                    Button {
                        Task { await exportOuting() }
                    } label: {
                        Label("Export", systemImage: "square.and.arrow.up")
                    }
                    .tint(.accentColor)
                    .disabled(observations.isEmpty || isExporting)
                }
            }
            .sheet(item: $exportItem) { item in
                ActivityView(item: item)
            }
            .alert("Could Not Complete Action", isPresented: operationErrorBinding) {
                Button("OK", role: .cancel) { operationError = nil }
            } message: {
                Text(operationError ?? "Something went wrong. Try again.")
            }
            .accessibilityAction(named: "View Details", onView)
    }

    @MainActor
    private func exportOuting() async {
        guard !observations.isEmpty else { return }
        isExporting = true
        defer { isExporting = false }
        do {
            let data = try await store.exportOutingCSV(outingId: outing.id)
            exportItem = try ExportFileFactory.outing(data: data, outing: outing)
            toasts.show("Outing exported in eBird Record CSV format")
        } catch {
            operationError = AppError.map(error, fallback: "Could not export outing. Try again.")?.message
        }
    }

    private var operationErrorBinding: Binding<Bool> {
        Binding(
            get: { operationError != nil },
            set: { if !$0 { operationError = nil } }
        )
    }
}

/// Hosts the outing delete confirmation above the list rather than on the row. An alert
/// anchored to a row is torn down with the swipe container before it can present, so the
/// confirmation appeared and vanished in the same frame.
private struct OutingDeletionConfirmationModifier: ViewModifier {
    @Binding var outing: Outing?

    @Environment(DataStore.self) private var store
    @Environment(ToastCenter.self) private var toasts
    @State private var operationError: String?

    func body(content: Content) -> some View {
        content
            .alert("Delete this outing?", isPresented: isPresented, presenting: outing) { target in
                Button("Cancel", role: .cancel) {}
                Button("Delete Outing", role: .destructive) {
                    Task { await delete(target) }
                }
            } message: { _ in
                Text("This will permanently delete this outing and all its observations.")
            }
            .alert("Could Not Complete Action", isPresented: operationErrorBinding) {
                Button("OK", role: .cancel) { operationError = nil }
            } message: {
                Text(operationError ?? "Something went wrong. Try again.")
            }
    }

    private var isPresented: Binding<Bool> {
        Binding(
            get: { outing != nil },
            set: { if !$0 { outing = nil } }
        )
    }

    @MainActor
    private func delete(_ target: Outing) async {
        do {
            try await store.deleteOuting(id: target.id)
            toasts.show("Outing deleted")
        } catch {
            operationError = AppError.map(error, fallback: "Could not delete outing. Try again.")?.message
        }
    }

    private var operationErrorBinding: Binding<Bool> {
        Binding(
            get: { operationError != nil },
            set: { if !$0 { operationError = nil } }
        )
    }
}

extension View {
    func outingRowActions(
        outing: Outing,
        pendingDeletion: Binding<Outing?>,
        onView: @escaping () -> Void,
        onEditLocation: @escaping () -> Void
    ) -> some View {
        modifier(OutingRowActionsModifier(
            outing: outing,
            pendingDeletion: pendingDeletion,
            onView: onView,
            onEditLocation: onEditLocation
        ))
    }

    func outingDeletionConfirmation(_ outing: Binding<Outing?>) -> some View {
        modifier(OutingDeletionConfirmationModifier(outing: outing))
    }
}

@MainActor
func presentActivitySheet(items: [Any], sourceView: UIView? = nil) {
    let activeScenes = UIApplication.shared.connectedScenes
        .compactMap({ $0 as? UIWindowScene })
        .filter { $0.activationState == .foregroundActive }
    guard let window = activeScenes.lazy.compactMap({ scene in
        scene.windows.first(where: { $0.isKeyWindow })
            ?? scene.windows.first(where: {
                !$0.isHidden && $0.alpha > 0 && $0.windowLevel == .normal
            })
    }).first,
        let root = window.rootViewController
    else { return }

    var presenter = root
    while let presented = presenter.presentedViewController {
        presenter = presented
    }
    let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
    if let popover = controller.popoverPresentationController {
        popover.sourceView = sourceView ?? presenter.view
        popover.sourceRect = sourceView?.bounds ?? CGRect(
            x: presenter.view.bounds.midX,
            y: presenter.view.bounds.midY,
            width: 1,
            height: 1
        )
    }
    presenter.present(controller, animated: true)
}

// MARK: - Bird Thumbnail

/// Center-cropped bird thumbnail. Uses an in-memory cache for smooth scrolling.
struct BirdThumbnail: View {
    let url: String?
    var size: CGFloat = 48
    var cornerRadius: CGFloat = 8
    @State private var uiImage: UIImage?

    var body: some View {
        Group {
            if let uiImage {
                Image(uiImage: uiImage)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size, height: size)
            } else {
                placeholder
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
        .task(id: url) { await loadImage() }
    }

    private func loadImage() async {
        guard let loaded = await ImageLoader.shared.image(for: url, targetPoints: size) else { return }
        // The loader deliberately outlives its caller, so a load for a previous `url` can
        // still land here and overwrite the current row's image.
        guard !Task.isCancelled else { return }
        uiImage = loaded
    }

    private var placeholder: some View {
        Rectangle()
            .fill(Color.warmBorder.opacity(0.2))
            .overlay {
                Image(systemName: "bird.fill")
                    .foregroundStyle(Color.mutedText.opacity(0.3))
            }
    }
}

// MARK: - Bird Hero Image

/// Full-bleed hero image with the web app's blur-up transition: the dex thumbnail shows
/// immediately (blurred, since it is upscaled) and the full-resolution image cross-fades
/// in once it finishes loading, so the hero is never blank.
///
/// Pass `fullImageUrl` equal to `thumbnailUrl` once it is known that no larger image
/// exists; the blur is then removed instead of lingering forever.
struct BirdHeroImage: View {
    let thumbnailUrl: String?
    let fullImageUrl: String?
    let width: CGFloat
    let height: CGFloat

    @State private var thumbnailImage: UIImage?
    @State private var fullImage: UIImage?

    /// Seeding from the cache in `init` (rather than in `.task`, which runs after the first
    /// render) is what lets a hero already loaded by a context-menu preview appear on frame
    /// one when the view is pushed, with no blur-up replay.
    @MainActor
    init(thumbnailUrl: String?, fullImageUrl: String?, width: CGFloat, height: CGFloat) {
        self.thumbnailUrl = thumbnailUrl
        self.fullImageUrl = fullImageUrl
        self.width = width
        self.height = height
        let target = max(width, height)
        _thumbnailImage = State(initialValue: ImageLoader.shared.cached(thumbnailUrl, targetPoints: target))
        _fullImage = State(initialValue: fullImageUrl == thumbnailUrl
            ? nil
            : ImageLoader.shared.cached(fullImageUrl, targetPoints: target))
    }

    private var awaitingFullRes: Bool { fullImageUrl == nil || fullImageUrl != thumbnailUrl }
    private var targetPoints: CGFloat { max(width, height) }

    var body: some View {
        ZStack {
            if let thumbnailImage {
                layer(thumbnailImage)
                    .blur(radius: awaitingFullRes ? 12 : 0, opaque: true)
            } else if fullImage == nil {
                placeholder
            }

            if let fullImage {
                layer(fullImage)
                    .transition(.opacity)
            }
        }
        .frame(width: width, height: height)
        .clipped()
        .task(id: thumbnailUrl) {
            if let loaded = await ImageLoader.shared.image(for: thumbnailUrl, targetPoints: targetPoints) {
                thumbnailImage = loaded
            }
        }
        .task(id: fullImageUrl) {
            guard awaitingFullRes, let fullImageUrl else { return }
            if let cached = ImageLoader.shared.cached(fullImageUrl, targetPoints: targetPoints) {
                fullImage = cached
                return
            }
            guard let loaded = await ImageLoader.shared.image(for: fullImageUrl, targetPoints: targetPoints) else { return }
            withAnimation(.easeInOut(duration: 0.45)) { fullImage = loaded }
        }
    }

    private func layer(_ image: UIImage) -> some View {
        Image(uiImage: image)
            .resizable()
            .scaledToFill()
            .frame(width: width, height: height, alignment: .center)
            .clipped()
    }

    private var placeholder: some View {
        Rectangle()
            .fill(Color.warmBorder.opacity(0.3))
            .overlay {
                Image(systemName: "bird.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(Color.mutedText.opacity(0.3))
            }
    }
}

@MainActor
private final class MapSnapshotCache {
    static let shared = MapSnapshotCache()
    private let images = NSCache<NSString, UIImage>()

    private init() {
        images.countLimit = 256
        images.totalCostLimit = 24 * 1_024 * 1_024
    }

    func image(for key: String) -> UIImage? {
        images.object(forKey: key as NSString)
    }

    func set(_ image: UIImage, for key: String) {
        let cost = image.cgImage.map { $0.bytesPerRow * $0.height } ?? 1
        images.setObject(image, forKey: key as NSString, cost: cost)
    }
}

// MARK: - Bird Row

/// Reusable bird species row used in WingDex list, outing detail species, and home.
/// Matches web app's BirdRow/ListRow pattern: thumbnail, serif name, italic scientific name, metadata.
struct BirdRow: View {
    let speciesName: String
    var thumbnailUrl: String?
    var subtitle: String?
    var count: Int?
    /// Supplied wherever the row belongs to one place and one date, which is
    /// what a rarity verdict needs. The row resolves its own mark from it, so
    /// no caller has to know the rules. Omitted on the WingDex grid on purpose:
    /// a life-list entry spans many places and months and has no single answer.
    var outing: Outing?

    private var rarity: RarityState {
        guard let outing else { return .none }
        return RarityStore.shared.state(species: speciesName, outing: outing)
    }

    var body: some View {
        HStack(spacing: 12) {
            BirdThumbnail(url: thumbnailUrl, size: 48)

            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Text(getDisplayName(speciesName))
                        .font(.system(.body, design: .serif, weight: .semibold))
                        .foregroundStyle(Color.foregroundText)
                        .fixedSize(horizontal: false, vertical: true)
                    if rarity != .none {
                        RarityMark(state: rarity)
                    }
                }

                if let sci = getScientificName(speciesName) {
                    Text(sci)
                        .font(.caption)
                        .italic()
                        .foregroundStyle(Color.mutedText)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(Color.mutedText)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let count, count > 1 {
                    Text("x\(count)")
                        .font(.caption)
                        .foregroundStyle(Color.mutedText)
                }
            }

            Spacer()
        }
        .contentShape(Rectangle())
        .padding(.vertical, 2)
        .frame(minHeight: 56)
    }
}

// MARK: - Species Card

/// Square image card for the Home recent-species carousel.
/// The UIKit carousel cell owns the accessibility behavior; this is the visual only.
struct SpeciesCard: View {
    let entry: DexEntry
    var size: CGFloat = 120

    var body: some View {
        BirdThumbnail(
            url: cardImageUrl(fromThumbnail: entry.thumbnailUrl) ?? entry.thumbnailUrl,
            size: size,
            cornerRadius: 0
        )
        .frame(width: size, height: size)
        .overlay {
            LinearGradient(
                colors: [.clear, .clear, .black.opacity(0.6)],
                startPoint: .top,
                endPoint: .bottom
            )
        }
        .overlay(alignment: .bottomLeading) {
            Text(getDisplayName(entry.speciesName))
                .font(.caption)
                .foregroundStyle(.white.opacity(0.9))
                .lineLimit(2)
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
        }
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityHidden(true)
    }
}

// MARK: - Maps Helper

/// Open an outing's location in Apple Maps.
func openInMaps(outing: Outing, lat: Double, lon: Double) {
    let location = CLLocation(latitude: lat, longitude: lon)
    let mapItem = MKMapItem(location: location, address: nil)
    mapItem.name = outing.locationName.isEmpty ? "Outing" : outing.locationName
    mapItem.openInMaps()
}

// MARK: - Outing Row

/// Reusable outing row with mini map (when coordinates available) or subtle pin icon.
/// Used in HomeView, OutingsView, and SpeciesDetailView sightings.
struct OutingRow: View {
    let outing: Outing
    let store: DataStore
    var observation: BirdObservation?

    /// Only a per-species row can carry a verdict. The location rows in Home and
    /// Outings cover many species at once and have no single answer.
    private var rarity: RarityState {
        guard let observation else { return .none }
        return RarityStore.shared.state(species: observation.speciesName, outing: outing)
    }

    var body: some View {
        let confirmed = store.confirmedObservations(outing.id)
        let speciesNames = Array(Set(confirmed.map(\.speciesName))).sorted()

        HStack(alignment: .center, spacing: 12) {
            outingLeadingIcon

            VStack(alignment: .leading, spacing: 2) {
                Text(outing.locationName.isEmpty ? "Outing" : outing.locationName)
                    .font(.system(.body, design: .serif, weight: .semibold))
                    .foregroundStyle(Color.foregroundText)
                    .fixedSize(horizontal: false, vertical: true)

                if let observation {
                    HStack(spacing: 4) {
                        Text(DateFormatting.formatDate(outing.startTime, style: .medium))
                        if observation.count > 1 {
                            Text("\u{00B7}")
                            Text("x\(observation.count)")
                        }
                        Text("\u{00B7}")
                        Text(observation.certainty.rawValue.capitalized)
                            .foregroundStyle(observation.certainty == .possible ? .orange : Color.mutedText)
                        // Species detail is the one screen where the mark has
                        // room for its word, and the issue asks for a fuller
                        // label exactly here.
                        if let label = rarity.shortLabel {
                            Text("\u{00B7}")
                            RarityMark(state: rarity)
                            Text(label)
                                .foregroundStyle(Color.rarityMark)
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(Color.mutedText)
                } else {
                    Text("\(DateFormatting.formatDate(outing.startTime, style: .medium)) \u{00B7} \(speciesNames.count) species")
                        .font(.caption)
                        .foregroundStyle(Color.mutedText)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if observation == nil, !speciesNames.isEmpty {
                    Text(
                        speciesNames.prefix(2).map { getDisplayName($0) }.joined(separator: ", ")
                        + (speciesNames.count > 2 ? " +\(speciesNames.count - 2) more" : "")
                    )
                    .font(.caption)
                    .foregroundStyle(Color.mutedText)
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
        }
        .contentShape(Rectangle())
        .padding(.vertical, 2)
        .frame(minHeight: 56)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilitySummary)
    }

    private var accessibilitySummary: String {
        let location = outing.locationName.isEmpty ? "Outing" : outing.locationName
        let date = DateFormatting.formatDate(outing.startTime, style: .medium)
        if let observation {
            return "\(location), \(date), \(getDisplayName(observation.speciesName)), \(observation.certainty.rawValue)"
                + (rarity.accessibilityLabel.map { ", \($0)" } ?? "")
        }
        let speciesCount = store.confirmedObservations(outing.id)
            .map(\.speciesName)
            .reduce(into: Set<String>()) { $0.insert($1) }
            .count
        return "\(location), \(date), \(speciesCount) species"
    }

    @ViewBuilder
    private var outingLeadingIcon: some View {
        if let lat = outing.lat, let lon = outing.lon {
            MiniMapSnapshot(latitude: lat, longitude: lon, size: 48)
                .clipShape(RoundedRectangle(cornerRadius: 8))
        } else {
            Image(systemName: "mappin")
                .font(.body)
                .foregroundStyle(Color.mutedText)
                .frame(width: 48, height: 48)
                .background(Color.warmBorder.opacity(0.15))
                .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }
}

// MARK: - Mini Map

/// Static map snapshot image - no controls, no "Legal" text.
private struct MiniMapSnapshot: View {
    private struct LoadedSnapshot {
        let key: String
        let image: UIImage
    }

    let latitude: Double
    let longitude: Double
    let size: CGFloat
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.displayScale) private var displayScale
    @State private var loadedSnapshot: LoadedSnapshot?

    private var cacheKey: String {
        [
            String(latitude.bitPattern, radix: 16),
            String(longitude.bitPattern, radix: 16),
            String(Double(size).bitPattern, radix: 16),
            String(Double(displayScale).bitPattern, radix: 16),
            colorScheme == .dark ? "dark" : "light",
        ].joined(separator: ":")
    }

    var body: some View {
        let displayedImage = loadedSnapshot?.key == cacheKey
            ? loadedSnapshot?.image
            : MapSnapshotCache.shared.image(for: cacheKey)
        Group {
            if let displayedImage {
                Image(uiImage: displayedImage)
                    .resizable()
                    .scaledToFill()
            } else {
                Rectangle()
                    .fill(Color.warmBorder.opacity(0.15))
            }
        }
        .frame(width: size, height: size)
        .task(id: cacheKey) {
            if let cached = MapSnapshotCache.shared.image(for: cacheKey) {
                loadedSnapshot = LoadedSnapshot(key: cacheKey, image: cached)
                return
            }
            let options = MKMapSnapshotter.Options()
            options.region = MKCoordinateRegion(
                center: CLLocationCoordinate2D(latitude: latitude, longitude: longitude),
                latitudinalMeters: 4_000,
                longitudinalMeters: 4_000
            )
            options.size = CGSize(width: size, height: size)
            options.traitCollection = UITraitCollection(mutations: { traits in
                traits.userInterfaceStyle = colorScheme == .dark ? .dark : .light
                traits.displayScale = displayScale
            })
            options.pointOfInterestFilter = .excludingAll

            let snapshotter = MKMapSnapshotter(options: options)
            let snapshot: MKMapSnapshotter.Snapshot
            do {
                snapshot = try await withTaskCancellationHandler {
                    try Task.checkCancellation()
                    return try await snapshotter.start()
                } onCancel: {
                    snapshotter.cancel()
                }
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            MapSnapshotCache.shared.set(snapshot.image, for: cacheKey)
            loadedSnapshot = LoadedSnapshot(key: cacheKey, image: snapshot.image)
        }
    }
}

// MARK: - Previews

#if DEBUG
#Preview("BirdRow") {
    // Real verdicts from the bundled asset, not hardcoded states. Both lookups
    // are primed synchronously because a preview snapshot comes from the first
    // frame, before any `.task` resolves.
    primeTaxonomyLookupsForPreview()
    // The --ui-test-seed-csv rarity outing. These four species land on all four
    // verdicts here, and ml/distill/verify_rarity_blob.py asserts exactly that.
    let seattle = Outing(
        id: "preview", userId: "preview",
        startTime: "2026-01-18T08:30:00-08:00", endTime: "2026-01-18T10:30:00-08:00",
        locationName: "Carkeek Park, Seattle", lat: 47.61, lon: -122.33,
        notes: "", createdAt: "2026-01-18T08:30:00-08:00"
    )
    let commons = "https://upload.wikimedia.org/wikipedia/commons/thumb/"
    let birds = [
        ("American Robin (Turdus migratorius)",
         commons + "b/b8/Turdus-migratorius-002.jpg/320px-Turdus-migratorius-002.jpg"),
        ("Rufous Hummingbird (Selasphorus rufus)",
         commons + "5/5b/Rufous_Hummingbird.jpg/320px-Rufous_Hummingbird.jpg"),
        ("Tundra Swan (Cygnus columbianus)",
         commons + "6/6a/Cygnus_columbianus_-Richmond%2C_British_Columbia%2C_Canada-8.jpg/320px-Cygnus_columbianus_-Richmond%2C_British_Columbia%2C_Canada-8.jpg"),
        ("Northern Cardinal (Cardinalis cardinalis)",
         commons + "4/45/Cardinal_-_3679055844.jpg/320px-Cardinal_-_3679055844.jpg"),
    ]
    return ScrollView {
        ForEach(birds, id: \.0) { name, thumb in
            BirdRow(
                speciesName: name,
                thumbnailUrl: thumb,
                subtitle: "Jan 18, 2026",
                outing: seattle
            )
            .padding(.horizontal)
        }
    }
    .background(Color.pageBg)
}

#Preview("SpeciesCard") {
    let entries = PreviewData.dex.prefix(4)
    ScrollView(.horizontal) {
        HStack(spacing: 10) {
            ForEach(Array(entries)) { entry in
                SpeciesCard(entry: entry, size: 140)
            }
        }
        .padding()
    }
    .background(Color.pageBg)
}

#Preview("OutingRow - Light") {
    let store = previewStore()
    List(PreviewData.outings.prefix(5)) { outing in
        OutingRow(outing: outing, store: store)
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .background(Color.pageBg)
    .preferredColorScheme(.light)
}

#Preview("OutingRow - Dark") {
    let store = previewStore()
    List(PreviewData.outings.prefix(5)) { outing in
        OutingRow(outing: outing, store: store)
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .background(Color.pageBg)
    .preferredColorScheme(.dark)
}
#endif
