import SwiftUI

/// Reference type because `NSCache` only stores class instances.
private final class WikiSummary: Sendable {
    let extract: String?
    let imageUrl: String?

    init(extract: String?, imageUrl: String?) {
        self.extract = extract
        self.imageUrl = imageUrl
    }
}

/// Wikipedia summaries are cached in memory because a context-menu preview and the view
/// it pops into are separate `SpeciesDetailView` instances with separate state. Without
/// this the pushed view refetches the summary, so it has no full-res URL on its first
/// render and replays the blur-up even though the image is already decoded.
@MainActor
private final class WikiSummaryCache {
    static let shared = WikiSummaryCache()
    private let cache = NSCache<NSString, WikiSummary>()

    init(countLimit: Int = 128) {
        cache.countLimit = countLimit
    }

    func summary(for title: String) -> WikiSummary? { cache.object(forKey: title as NSString) }
    func set(_ summary: WikiSummary, for title: String) { cache.setObject(summary, forKey: title as NSString) }
}

struct SpeciesDetailView: View {
    let speciesName: String
    @Environment(DataStore.self) private var store
    @State private var wikiExtract: String?
    @State private var fullImageUrl: String?
    @State private var imageCredit: (artist: String?, license: String?, pageUrl: String)?
    @State private var contextMenuOuting: Outing?
    @State private var imageShareItem: ExportFileItem?
    @State private var imageOperationError: String?
    @State private var savedImageToPhotos = false

    private var entry: DexEntry? { store.dexEntry(for: speciesName) }
    private var sightings: [(observation: BirdObservation, outing: Outing)] {
        store.sightings(for: speciesName)
    }

    /// Several photos of the same bird on one outing are stored as separate observations, so
    /// the list shows one row per outing and certainty with the counts added up.
    private var mergedSightings: [(observation: BirdObservation, outing: Outing)] {
        mergeSightingsByOuting(sightings)
    }

    /// Read through to the cache so a preview-populated summary is available on the first
    /// render, before `.task` has a chance to run.
    private var cachedSummary: WikiSummary? {
        guard let wikiTitle = entry?.wikiTitle else { return nil }
        return WikiSummaryCache.shared.summary(for: wikiTitle)
    }
    private var displayedExtract: String? { wikiExtract ?? cachedSummary?.extract }

    /// Derived from the dex thumbnail so the hero has its final URL on the first frame
    /// rather than waiting on the Wikipedia summary. Species served as originals have no
    /// larger rendering, so only species with no dex thumbnail need the fetched URL.
    private var displayedFullImageUrl: String? {
        heroImageUrl(fromThumbnail: entry?.thumbnailUrl)
            ?? entry?.thumbnailUrl
            ?? fullImageUrl
            ?? cachedSummary?.imageUrl
    }

    var body: some View {
        VStack(spacing: 0) {
            CachedDataNotice()
            List {
            // Hero image section - no separators, full bleed
            Section {
                heroSection
                    .listRowInsets(EdgeInsets())
            }
            .listRowSeparator(.hidden)

            // Wikipedia + links section
            if displayedExtract != nil || entry != nil {
                Section {
                    wikiSection
                }
                .listRowSeparator(.hidden)

                Section {
                    linksSection
                }
            }

            // Sightings section
            Section {
                ForEach(mergedSightings, id: \.observation.id) { item in
                    NavigationLink(value: item.outing) {
                        OutingRow(outing: item.outing, store: store, observation: item.observation)
                    }
                    .contextMenu {
                        Button {
                            contextMenuOuting = item.outing
                        } label: {
                            Label("View Outing", systemImage: "binoculars")
                        }
                        if let lat = item.outing.lat, let lon = item.outing.lon {
                            Button {
                                openInMaps(outing: item.outing, lat: lat, lon: lon)
                            } label: {
                                Label("View in Maps", systemImage: "map")
                            }
                        }
                    } preview: {
                        NavigationStack {
                            OutingDetailView(outingId: item.outing.id)
                        }
                        .environment(store)
                    }
                }
            } header: {
                Text("Sightings (\(sightings.count))")
                    .font(.system(size: 16, weight: .semibold, design: .serif))
                    .foregroundStyle(Color.foregroundText)
            }

            if let notes = entry?.notes.trimmingCharacters(in: .whitespacesAndNewlines), !notes.isEmpty {
                Section {
                    Text(notes)
                        .font(.subheadline)
                        .italic()
                        .foregroundStyle(Color.mutedText)
                } header: {
                    Text("Notes")
                        .font(.system(size: 16, weight: .semibold, design: .serif))
                        .foregroundStyle(Color.foregroundText)
                }
            }
            }
        }
        .listStyle(.plain)
        // WHY .scrollContentBackground(.hidden) + .background(): SwiftUI List has an
        // opaque system background that covers any ZStack-based background. We hide it
        // and apply our own pageBg so the warm beige shows through. This two-step
        // pattern is used on every plain List in the app.
        .scrollContentBackground(.hidden)
        .navigationTitle(getDisplayName(speciesName))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let entry {
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: SharePayload.species(entry)) {
                        Label("Share Species", systemImage: "square.and.arrow.up")
                    }
                }
            }
        }
        .background(Color.pageBg.ignoresSafeArea())
        .navigationDestination(for: Outing.self) { outing in
            OutingDetailView(outingId: outing.id)
        }
        .navigationDestination(item: $contextMenuOuting) { outing in
            OutingDetailView(outingId: outing.id)
        }
        .sheet(item: $imageShareItem) { item in
            ActivityView(item: item)
        }
        .alert("Could Not Complete Action", isPresented: imageOperationErrorBinding) {
            Button("OK", role: .cancel) { imageOperationError = nil }
        } message: {
            Text(imageOperationError ?? "Something went wrong. Try again.")
        }
        .alert("Saved to Photos", isPresented: $savedImageToPhotos) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("The bird image was added to your photo library.")
        }
        .task { await fetchWikipediaData() }
        .task { await fetchImageCredit() }
    }

    // MARK: - Hero

    private var heroSection: some View {
        // WHY GeometryReader: the hero image uses .scaledToFill() and will overflow its
        // parent frame in a List row. GeometryReader constrains the width to the
        // actual available space so .clipped() works correctly on the hero image.
        GeometryReader { geo in
            ZStack(alignment: .bottomLeading) {
                BirdHeroImage(
                    thumbnailUrl: entry?.thumbnailUrl,
                    fullImageUrl: displayedFullImageUrl,
                    width: geo.size.width,
                    height: 280
                )

            // Gradient overlay
            LinearGradient(
                colors: [.clear, .clear, .black.opacity(0.6)],
                startPoint: .top,
                endPoint: .bottom
            )

            // Name + stats overlay
            VStack(alignment: .leading, spacing: 4) {
                Text(getDisplayName(speciesName))
                    .font(.system(size: 26, weight: .semibold, design: .serif))
                    .foregroundStyle(.white.opacity(0.9))

                if let sci = getScientificName(speciesName) {
                    Text(sci)
                        .font(.system(size: 14))
                        .italic()
                        .foregroundStyle(.white.opacity(0.75))
                }

                if let entry {
                    HStack(spacing: 4) {
                        Text("\(entry.totalCount) seen")
                            .fontWeight(.semibold)
                            .foregroundStyle(.white.opacity(0.9))
                        Text("\u{00B7}").foregroundStyle(.white.opacity(0.4))
                        Text("\(entry.totalOutings) outing\(entry.totalOutings == 1 ? "" : "s")")
                            .fontWeight(.semibold)
                            .foregroundStyle(.white.opacity(0.9))
                        Text("\u{00B7}").foregroundStyle(.white.opacity(0.4))
                        Text("First \(Text(DateFormatting.formatDate(entry.firstSeenDate, style: .medium)).fontWeight(.semibold).foregroundStyle(.white.opacity(0.9)))")
                            .foregroundStyle(.white.opacity(0.7))
                    }
                    .font(.system(size: 13))
                }
            }
            .padding()
        }
        .frame(width: geo.size.width, height: 280)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .frame(height: 280)
        .padding(.horizontal)
        .contextMenu {
            Button {
                Task { await shareHeroImage() }
            } label: {
                Label("Share Image", systemImage: "square.and.arrow.up")
            }
            Button {
                Task { await saveHeroImage() }
            } label: {
                Label("Save to Photos", systemImage: "square.and.arrow.down")
            }
        }
    }

    // MARK: - Wiki

    @ViewBuilder
    private var wikiSection: some View {
        if let extract = displayedExtract {
            VStack(alignment: .leading, spacing: 8) {
                Text(extract)
                    .font(.system(size: 14))
                    .foregroundStyle(Color.foregroundText.opacity(0.8))
                    .lineSpacing(3)

                if entry?.wikiTitle != nil {
                    Text("Text from \(Text("Wikipedia").foregroundStyle(Color.accentColor)) under \(Text("CC BY-SA 4.0").foregroundStyle(Color.accentColor)).")
                        .font(.system(size: 11))
                        .foregroundStyle(Color.mutedText)
                }

                // The hero is an individually licensed Commons photo, so it needs its own credit.
                if let credit = imageCredit, let url = URL(string: credit.pageUrl) {
                    Link(destination: url) {
                        Text("Photo \([credit.artist, credit.license].compactMap { $0 }.joined(separator: " / "))")
                            .font(.system(size: 11))
                            .foregroundStyle(Color.accentColor)
                    }
                }
            }
        }
    }

    // MARK: - Links

    @ViewBuilder
    private var linksSection: some View {
        if let url = getWikipediaURL(for: entry?.wikiTitle) {
                Link(destination: url) {
                    Label("Wikipedia", systemImage: "book")
                }
        }

        if let url = getEbirdURL(for: speciesName) {
            Link(destination: url) {
                Label("eBird", systemImage: "globe")
            }
        }

        if let url = getBirdlifeFactsheetURL(for: speciesName) {
            Link(destination: url) {
                Label("BirdLife", systemImage: "leaf")
            }
        }
    }

    // MARK: - Wikipedia Fetch

    @MainActor
    private func fetchWikipediaData() async {
        guard let wikiTitle = entry?.wikiTitle else { return }
        if let cached = WikiSummaryCache.shared.summary(for: wikiTitle) {
            wikiExtract = cached.extract
            fullImageUrl = cached.imageUrl
            return
        }
        let encoded = wikiTitle.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? wikiTitle
        guard let url = URL(string: "https://en.wikipedia.org/api/rest_v1/page/summary/\(encoded)") else {
            return
        }

        do {
            var request = URLRequest(url: url)
            request.setValue(WikimediaUserAgent.value, forHTTPHeaderField: "User-Agent")
            let (data, _) = try await URLSession.shared.data(for: request)
            guard let summary = await Self.parseSummary(data) else { return }
            WikiSummaryCache.shared.set(summary, for: wikiTitle)
            wikiExtract = summary.extract
            fullImageUrl = summary.imageUrl
        } catch {
            // Silently fail - the dex thumbnail is still shown. Not cached, so a later
            // visit retries.
        }
    }

    /// Fetch the creator and license for the hero photo. The file page URL is derived
    /// from the image URL, so this is one request and no extra data in taxonomy.json.
    @MainActor
    private func fetchImageCredit() async {
        guard imageCredit == nil,
              let pageUrl = wikimediaFilePageUrl(fromImage: entry?.thumbnailUrl),
              let separator = pageUrl.range(of: "/wiki/"),
              // The title came out of a URL path, so it is already percent-encoded.
              // Encoding it again turns %28 into %2528 and the API rejects the title.
              let apiUrl = URL(string: "\(pageUrl[..<separator.lowerBound])/w/api.php?action=query&titles=\(pageUrl[separator.upperBound...])&prop=imageinfo&iiprop=extmetadata&format=json")
        else { return }

        var request = URLRequest(url: apiUrl)
        request.setValue(WikimediaUserAgent.value, forHTTPHeaderField: "User-Agent")
        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let pages = (json["query"] as? [String: Any])?["pages"] as? [String: Any],
              let page = pages.values.first as? [String: Any],
              let info = (page["imageinfo"] as? [[String: Any]])?.first,
              let meta = info["extmetadata"] as? [String: Any]
        else { return }

        let read: (String) -> String? = { key in
            guard let value = (meta[key] as? [String: Any])?["value"] as? String else { return nil }
            let text = value
                .replacingOccurrences(of: "<[^>]*>", with: "", options: .regularExpression)
                .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : text
        }
        imageCredit = (artist: read("Artist"), license: read("LicenseShortName"), pageUrl: pageUrl)
    }

    /// Off the main actor: extracts run to several KB, and this parse lands on the detail
    /// push path where a hitch is visible.
    private nonisolated static func parseSummary(_ data: Data) async -> WikiSummary? {
        await Task.detached(priority: .utility) {
            guard let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                return nil
            }
            let original = json["originalimage"] as? [String: Any]
            return WikiSummary(
                extract: json["extract"] as? String,
                imageUrl: original?["source"] as? String
            )
        }.value
    }

    private var heroImageURL: URL? {
        guard let value = displayedFullImageUrl ?? entry?.thumbnailUrl else { return nil }
        return URL(string: value)
    }

    @MainActor
    private func shareHeroImage() async {
        guard let heroImageURL else { return }
        do {
            let data = try await ImageSharingService.downloadImage(from: heroImageURL)
            imageShareItem = try ImageSharingService.shareFile(data: data, sourceURL: heroImageURL)
        } catch {
            imageOperationError = AppError.map(error, fallback: "Could not share this image. Try again.")?.message
        }
    }

    @MainActor
    private func saveHeroImage() async {
        guard let heroImageURL else { return }
        do {
            let data = try await ImageSharingService.downloadImage(from: heroImageURL)
            try await ImageSharingService.saveToPhotos(data: data)
            savedImageToPhotos = true
        } catch {
            imageOperationError = AppError.map(error, fallback: "Could not save this image. Try again.")?.message
        }
    }

    private var imageOperationErrorBinding: Binding<Bool> {
        Binding(
            get: { imageOperationError != nil },
            set: { if !$0 { imageOperationError = nil } }
        )
    }
}

#if DEBUG
#Preview("Species Detail - Light") {
    PreviewTabs(.wingdex) {
        NavigationStack {
            SpeciesDetailView(speciesName: PreviewData.sampleSpecies)
                .environment(previewStore())
        }
    }
    .preferredColorScheme(.light)
}

#Preview("Species Detail - Dark") {
    PreviewTabs(.wingdex) {
        NavigationStack {
            SpeciesDetailView(speciesName: PreviewData.sampleSpecies)
                .environment(previewStore())
        }
    }
    .preferredColorScheme(.dark)
}
#endif
