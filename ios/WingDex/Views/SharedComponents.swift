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
    let onView: () -> Void
    let onEditLocation: () -> Void

    @Environment(AuthService.self) private var auth
    @Environment(DataStore.self) private var store
    @State private var exportItem: ExportFileItem?
    @State private var isExporting = false
    @State private var confirmsDeletion = false
    @State private var operationError: String?

    private var observations: [BirdObservation] {
        store.confirmedObservations(outing.id)
    }

    func body(content: Content) -> some View {
        content
            .contextMenu {
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
                    confirmsDeletion = true
                } label: {
                    Label("Delete Outing", systemImage: "trash")
                }
                .disabled(!store.hasLoadedAll)
            } preview: {
                NavigationStack {
                    OutingDetailView(outingId: outing.id)
                }
                .environment(auth)
                .environment(store)
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
            .swipeActions(edge: .trailing) {
                Button(role: .destructive) {
                    confirmsDeletion = true
                } label: {
                    Label("Delete", systemImage: "trash")
                }
                .disabled(!store.hasLoadedAll)
            }
            .sheet(item: $exportItem) { item in
                ActivityView(item: item)
            }
            .alert("Delete this outing?", isPresented: $confirmsDeletion) {
                Button("Cancel", role: .cancel) {}
                Button("Delete Outing", role: .destructive) {
                    Task { await deleteOuting() }
                }
            } message: {
                Text("This will permanently delete this outing and all its observations.")
            }
            .alert("Could Not Complete Action", isPresented: operationErrorBinding) {
                Button("OK", role: .cancel) { operationError = nil }
            } message: {
                Text(operationError ?? "Something went wrong. Try again.")
            }
            .accessibilityAction(named: "View Outing", onView)
    }

    @MainActor
    private func exportOuting() async {
        guard !observations.isEmpty else { return }
        isExporting = true
        defer { isExporting = false }
        do {
            let data = try await store.exportOutingCSV(outingId: outing.id)
            exportItem = try ExportFileFactory.outing(data: data, outing: outing)
        } catch {
            operationError = AppError.map(error, fallback: "Could not export outing. Try again.")?.message
        }
    }

    @MainActor
    private func deleteOuting() async {
        do {
            try await store.deleteOuting(id: outing.id)
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
        onView: @escaping () -> Void,
        onEditLocation: @escaping () -> Void
    ) -> some View {
        modifier(OutingRowActionsModifier(
            outing: outing,
            onView: onView,
            onEditLocation: onEditLocation
        ))
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

/// Crop anchor for a `.scaledToFill()` bird photo. Tall sources are cropped from the top so
/// the head survives; wide ones are centered. Same rule as the web `wiki-bird-thumbnail.tsx`.
func birdFillAlignment(for image: UIImage) -> Alignment {
    image.size.height > image.size.width ? .top : .center
}

/// Orientation-aware bird thumbnail. Uses an in-memory cache for smooth scrolling.
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
                    .frame(width: size, height: size, alignment: birdFillAlignment(for: uiImage))
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

    /// Both layers render the same file, so resolving the anchor once keeps the cross-fade
    /// from shifting the framing mid-transition.
    private var fillAlignment: Alignment {
        guard let image = thumbnailImage ?? fullImage else { return .center }
        return birdFillAlignment(for: image)
    }

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
            .frame(width: width, height: height, alignment: fillAlignment)
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
    private let cache = NSCache<NSString, UIImage>()

    init() { cache.countLimit = 100 }

    func image(for key: String) -> UIImage? { cache.object(forKey: key as NSString) }
    func set(_ image: UIImage, for key: String) { cache.setObject(image, forKey: key as NSString) }
}

// MARK: - Bird Row

/// Reusable bird species row used in WingDex list, outing detail species, and home.
/// Matches web app's BirdRow/ListRow pattern: thumbnail, serif name, italic scientific name, metadata.
struct BirdRow: View {
    let speciesName: String
    var thumbnailUrl: String?
    var subtitle: String?
    var count: Int?

    var body: some View {
        HStack(spacing: 12) {
            BirdThumbnail(url: thumbnailUrl, size: 48)

            VStack(alignment: .leading, spacing: 2) {
                Text(getDisplayName(speciesName))
                    .font(.system(.body, design: .serif, weight: .semibold))
                    .foregroundStyle(Color.foregroundText)
                    .fixedSize(horizontal: false, vertical: true)

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
    let latitude: Double
    let longitude: Double
    let size: CGFloat
    @Environment(\.colorScheme) private var colorScheme
    @State private var image: UIImage?

    private var cacheKey: String {
        "\(latitude):\(longitude):\(Int(size)):\(colorScheme == .dark ? "dark" : "light")"
    }

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Rectangle()
                    .fill(Color.warmBorder.opacity(0.15))
            }
        }
        .frame(width: size, height: size)
        .task(id: cacheKey) {
            image = nil
            await snapshot(cacheKey: cacheKey)
        }
    }

    private func snapshot(cacheKey: String) async {
        if let cached = MapSnapshotCache.shared.image(for: cacheKey) {
            image = cached
            return
        }
        let options = MKMapSnapshotter.Options()
        options.region = MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: latitude, longitude: longitude),
            latitudinalMeters: 4000,
            longitudinalMeters: 4000
        )
        // Use 2x for snapshot; actual screen scale not needed for thumbnails
        options.size = CGSize(width: size * 2, height: size * 2)
        options.traitCollection = UITraitCollection(
            userInterfaceStyle: colorScheme == .dark ? .dark : .light
        )
        options.pointOfInterestFilter = .excludingAll
        options.showsBuildings = false

        do {
            let snapshotter = MKMapSnapshotter(options: options)
            let result = try await snapshotter.start()
            try Task.checkCancellation()
            MapSnapshotCache.shared.set(result.image, for: cacheKey)
            image = result.image
        } catch {
            // Leave placeholder
        }
    }
}

// MARK: - Previews

#if DEBUG
#Preview("BirdRow") {
    ScrollView {
        BirdRow(
            speciesName: "Northern Cardinal (Cardinalis cardinalis)",
            thumbnailUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/45/Cardinal_-_3679055844.jpg/320px-Cardinal_-_3679055844.jpg",
            subtitle: "3 outings · 5 seen · Jan 12, 2026"
        )
        .padding(.horizontal)
        BirdRow(
            speciesName: "Blue Jay (Cyanocitta cristata)",
            thumbnailUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/f/f4/Blue_jay_in_PP_%2830960%29.jpg/320px-Blue_jay_in_PP_%2830960%29.jpg",
            count: 3
        )
        .padding(.horizontal)
        BirdRow(
            speciesName: "Bald Eagle (Haliaeetus leucocephalus)",
            thumbnailUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/About_to_Launch_%2826075320352%29.jpg/320px-About_to_Launch_%2826075320352%29.jpg",
            subtitle: "2 outings · 2 seen · Jan 12, 2026"
        )
        .padding(.horizontal)
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
