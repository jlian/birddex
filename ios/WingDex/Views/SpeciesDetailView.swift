import SwiftUI

struct SpeciesDetailView: View {
    let speciesName: String
    @Environment(AuthService.self) private var auth
    /// The dex grouping key, when the caller has it (e.g. a grouped outing row).
    /// Two groups can share a display label, so resolving by key keeps this
    /// screen bound to the exact group the user tapped. Callers that only hold
    /// a name (the dex list) leave this nil and resolve by name.
    var speciesKey: String?
    /// Taxonomy for a species reached from a compound entry's parent list. Those
    /// species are usually not in the dex - that is why the sighting was filed as
    /// a hybrid or a slash - so the page falls back to this for the name, article
    /// and reference links it would otherwise read off `entry`.
    var reference: CompoundTaxonParent?
    @Environment(DataStore.self) private var store
    @Environment(ToastCenter.self) private var toasts
    @State private var wikiExtract: String?
    @State private var fullImageUrl: String?
    @State private var imageCredit: WikimediaImageCredit?
    @State private var contextMenuOuting: Outing?
    @State private var imageShareItem: ExportFileItem?
    @State private var imageOperationError: String?
    @State private var savedImageToPhotos = false
    @State private var editingNotes = false
    @State private var notesDraft = ""
    @State private var savingNotes = false
    @FocusState private var notesFocused: Bool

    private var entry: DexEntry? {
        if let speciesKey { return store.dexEntry(byKey: speciesKey) }
        if let reference {
            return store.dexEntry(byKey: dexGroupKey(speciesCode: reference.speciesCode,
                                                     speciesName: reference.commonName))
        }
        return store.dexEntry(for: speciesName)
    }
    private var sightings: [(observation: BirdObservation, outing: Outing)] {
        if let speciesKey { return store.sightings(byKey: speciesKey) }
        // A parent resolves through its eBird code, so read the sightings off the
        // entry that lookup found rather than off a name the dex may not be keyed by.
        if reference != nil { return entry.map { store.sightings(byKey: $0.id) } ?? [] }
        return store.sightings(for: speciesName)
    }
    private var displayName: String { entry?.commonName ?? reference?.commonName ?? getDisplayName(speciesName) }
    private var scientificName: String? {
        entry?.scientificName ?? reference?.scientificName ?? getScientificName(speciesName)
    }
    private var wikiTitle: String? { entry?.wikiTitle ?? reference?.wikiTitle }
    private var thumbnailUrl: String? { entry?.thumbnailUrl ?? reference?.thumbnailUrl }

    /// Several photos of the same bird on one outing are stored as separate observations, so
    /// the list shows one row per outing and certainty with the counts added up.
    private var mergedSightings: [(observation: BirdObservation, outing: Outing)] {
        mergeSightingsByOuting(sightings)
    }

    /// Read through to the cache so a preview-populated summary is available on the first
    /// render, before `.task` has a chance to run.
    private var cachedSummary: WikiSummary? {
        guard let wikiTitle else { return nil }
        return WikiSummaryService.cached(for: wikiTitle)
    }
    private var displayedExtract: String? { wikiExtract ?? cachedSummary?.extract }

    /// Derived from the dex thumbnail so the hero has its final URL on the first frame
    /// rather than waiting on the Wikipedia summary. Species served as originals have no
    /// larger rendering, so only species with no dex thumbnail need the fetched URL.
    private var displayedFullImageUrl: String? {
        heroImageUrl(fromThumbnail: thumbnailUrl)
            ?? thumbnailUrl
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

            if let borrowedFrom = entry?.borrowedFrom {
                Section {
                    Text("Shown for \(borrowedFrom), one of \(entry?.compound?.parents.count ?? 2) \(entry?.compound?.kind == "slash" ? "possible species" : "parents").")
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundStyle(Color.mutedText)
                }
                .listRowSeparator(.hidden)
            }

            // Wikipedia + links section
            if displayedExtract != nil || entry != nil || reference != nil {
                Section {
                    wikiSection
                }
                .listRowSeparator(.hidden)

                Section {
                    linksSection
                }
            }

            if let compound = entry?.compound {
                Section {
                    Text(compound.kind == "hybrid"
                         ? "Hybrid of \(joinedParentNames(compound.parents))."
                         : "Recorded when \(joinedParentNames(compound.parents)) could not be told apart.")
                        .font(.subheadline)
                        .foregroundStyle(Color.mutedText)

                    ForEach(compound.parents) { parent in
                        NavigationLink(value: parent) {
                            BirdRow(
                                speciesName: parent.commonName,
                                displayName: parent.commonName,
                                scientificName: parent.scientificName,
                                taxonCode: parent.speciesCode,
                                thumbnailUrl: parent.thumbnailUrl
                            )
                        }
                    }
                } header: {
                    Text(compound.kind == "hybrid" ? "Parents" : "Possible Species")
                }
            }

            // Sightings section
            if entry == nil && reference != nil {
                Section {
                    Text("Not in your dex yet.")
                        .font(.subheadline)
                        .foregroundStyle(Color.mutedText)
                }
                .listRowSeparator(.hidden)
            } else {
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
            }

            if let entry {
                Section {
                    notesSection(entry)
                } header: {
                    Text("Notes")
                        .font(.system(size: 16, weight: .semibold, design: .serif))
                        .foregroundStyle(Color.foregroundText)
                }
                .listRowSeparator(.hidden)
            }
            }
        }
        .listStyle(.plain)
        // WHY .scrollContentBackground(.hidden) + .background(): SwiftUI List has an
        // opaque system background that covers any ZStack-based background. We hide it
        // and apply our own pageBg so the warm beige shows through. This two-step
        // pattern is used on every plain List in the app.
        .scrollContentBackground(.hidden)
        .navigationTitle(displayName)
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
        .navigationDestination(for: CompoundTaxonParent.self) { parent in
            SpeciesDetailView(
                speciesName: parent.commonName,
                reference: parent
            )
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
                    thumbnailUrl: thumbnailUrl,
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
                    Text(displayName)
                        .font(.system(size: 26, weight: .semibold, design: .serif))
                        .foregroundStyle(.white.opacity(0.9))

                    if let sci = scientificName {
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
            if let photoPageURL {
                Link(destination: photoPageURL) {
                    Label("View Photo Page", systemImage: "info.circle")
                }
            }
        }
    }

    /// Wikimedia file page for the hero photo, carrying the creator and license.
    private var photoPageURL: URL? {
        (imageCredit?.pageUrl ?? wikimediaFilePageUrl(fromImage: thumbnailUrl))
            .flatMap(URL.init(string:))
    }

    // MARK: - Notes

    /// A growing `TextField(axis: .vertical)` rather than a `TextEditor`: the editor is
    /// itself a scroll view, and nesting one in this List is what makes the outing page's
    /// notes fight the surrounding scroll.
    @ViewBuilder
    private func notesSection(_ entry: DexEntry) -> some View {
        if editingNotes {
            TextField("What to look for, where you found it, anything worth remembering",
                      text: $notesDraft, axis: .vertical)
                .font(.subheadline)
                .lineLimit(3...12)
                .focused($notesFocused)
                .disabled(savingNotes)

            // .borderless per button, not on the HStack: with the automatic style a List
            // row is one tap target and a tap fires every button in it, so Cancel also saved.
            HStack {
                Button("Cancel") {
                    editingNotes = false
                    notesFocused = false
                }
                .buttonStyle(.borderless)
                .disabled(savingNotes)
                Spacer()
                Button("Save") { Task { await saveNotes(entry) } }
                    .buttonStyle(.borderless)
                    .fontWeight(.semibold)
                    .disabled(savingNotes)
            }
            .font(.subheadline)
        } else {
            // A Button, not a tap gesture on the Text: VoiceOver and Full Keyboard Access
            // get nothing from a gesture recognizer.
            Button {
                notesDraft = entry.notes
                editingNotes = true
                notesFocused = true
            } label: {
                let notes = entry.notes.trimmingCharacters(in: .whitespacesAndNewlines)
                Text(notes.isEmpty ? "Add notes" : notes)
                    .font(.subheadline)
                    .italic(!notes.isEmpty)
                    .foregroundStyle(notes.isEmpty ? Color.accentColor : Color.mutedText)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityHint("Edit notes for this species")
        }
    }

    @MainActor
    private func saveNotes(_ entry: DexEntry) async {
        savingNotes = true
        defer { savingNotes = false }
        do {
            try await store.updateDexNotes(entry: entry, notes: notesDraft)
            editingNotes = false
            notesFocused = false
            toasts.show("Notes saved")
        } catch {
            toasts.showError(AppError.map(error, fallback: "Could not save notes. Try again.")?.message
                             ?? "Could not save notes. Try again.")
        }
    }

    // MARK: - Wiki

    @ViewBuilder
    private var wikiSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let extract = displayedExtract {
                Text(extract)
                    .font(.system(size: 14))
                    .foregroundStyle(Color.foregroundText.opacity(0.8))
                    .lineSpacing(3)
            }

            creditsLine
        }
    }

    /// Photo and text attribution share one line: a credit under the hero sat 16pt inside
    /// the image's own overlay text and read as an orphan.
    @ViewBuilder
    private var creditsLine: some View {
        let creditsText = wikiTitle != nil && displayedExtract != nil

        if photoPageURL != nil || creditsText {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                if let photoPageURL {
                    Link(
                        imageCredit?.label ?? "Photo: Wikimedia Commons", destination: photoPageURL)
                    .foregroundStyle(Color.accentColor)
                    
                    if creditsText {
                        Text("\u{00B7}")
                    }
                }
                if creditsText {
                    Text("Text: Wikipedia / CC BY-SA 4.0")
                }
            }
            .font(.system(size: 11))
            .foregroundStyle(Color.mutedText)
        }
    }

    // MARK: - Links

    @ViewBuilder
    private var linksSection: some View {
        if let url = getWikipediaURL(for: wikiTitle) {
                Link(destination: url) {
                    Label("Wikipedia", systemImage: "book")
                }
        }

        if let url = getEbirdURL(forCode: entry?.taxonCode ?? reference?.speciesCode)
            ?? getEbirdURL(for: speciesName) {
            Link(destination: url) {
                Label("eBird", systemImage: "globe")
            }
        }

        if let url = reference?.birdlifeId.flatMap({ URL(string: "https://datazone.birdlife.org/species/factsheet/\($0)") })
            ?? getBirdlifeFactsheetURL(for: speciesName) {
            Link(destination: url) {
                Label("BirdLife", systemImage: "leaf")
            }
        }
    }

    private func joinedParentNames(_ parents: [CompoundTaxonParent]) -> String {
        let names = parents.map(\.commonName)
        guard names.count > 1 else { return names.first ?? "" }
        return names.dropLast().joined(separator: ", ") + " and " + (names.last ?? "")
    }

    // MARK: - Wikipedia Fetch

    @MainActor
    private func fetchWikipediaData() async {
        guard let wikiTitle else { return }
        guard let summary = await WikiSummaryService.summary(for: wikiTitle) else { return }
        wikiExtract = summary.extract
        fullImageUrl = summary.imageUrl
    }

    /// Fetch the creator and license for the hero photo. The file page URL is derived
    /// from the image URL, so this is one request and no extra data in taxonomy.json.
    @MainActor
    private func fetchImageCredit() async {
        guard imageCredit == nil else { return }
        imageCredit = await WikimediaCreditService.credit(forImage: thumbnailUrl)
    }

    private var heroImageURL: URL? {
        guard let value = displayedFullImageUrl ?? thumbnailUrl else { return nil }
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
