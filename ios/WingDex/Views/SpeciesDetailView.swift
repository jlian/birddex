import SwiftUI

struct SpeciesDetailView: View {
    let speciesName: String
    @Environment(AuthService.self) private var auth
    @Environment(DataStore.self) private var store
    @Environment(ToastCenter.self) private var toasts
    @State private var wikiExtract: String?
    @State private var fullImageUrl: String?
    @State private var imageCredit: WikimediaImageCredit?
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
        return WikiSummaryService.cached(for: wikiTitle)
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
                            Label("View Details", systemImage: "binoculars")
                        }
                        if let lat = item.outing.lat, let lon = item.outing.lon {
                            Button {
                                openInMaps(outing: item.outing, lat: lat, lon: lon)
                            } label: {
                                Label("View in Maps", systemImage: "map")
                            }
                        }
                    } preview: {
                        // Context-menu previews render outside the app's environment hierarchy.
                        NavigationStack {
                            OutingDetailView(outingId: item.outing.id)
                        }
                        .environment(auth)
                        .environment(store)
                        .environment(toasts)
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
        // The square gives portrait and landscape source photos equal treatment. The
        // GeometryReader still constrains scaled-to-fill images inside the List row.
        GeometryReader { geo in
            ZStack(alignment: .bottomLeading) {
                BirdHeroImage(
                    thumbnailUrl: entry?.thumbnailUrl,
                    fullImageUrl: displayedFullImageUrl,
                    width: geo.size.width,
                    height: geo.size.width
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
        .frame(width: geo.size.width, height: geo.size.width)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .aspectRatio(1, contentMode: .fit)
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
                        Text(credit.label)
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
        guard let summary = await WikiSummaryService.summary(for: wikiTitle) else { return }
        wikiExtract = summary.extract
        fullImageUrl = summary.imageUrl
    }

    /// Fetch the creator and license for the hero photo. The file page URL is derived
    /// from the image URL, so this is one request and no extra data in taxonomy.json.
    @MainActor
    private func fetchImageCredit() async {
        guard imageCredit == nil else { return }
        imageCredit = await WikimediaCreditService.credit(forImage: entry?.thumbnailUrl)
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
                .environment(AuthService())
                .environment(previewStore())
                .environment(ToastCenter())
        }
    }
    .preferredColorScheme(.light)
}

#Preview("Species Detail - Dark") {
    PreviewTabs(.wingdex) {
        NavigationStack {
            SpeciesDetailView(speciesName: PreviewData.sampleSpecies)
                .environment(AuthService())
                .environment(previewStore())
                .environment(ToastCenter())
        }
    }
    .preferredColorScheme(.dark)
}
#endif
