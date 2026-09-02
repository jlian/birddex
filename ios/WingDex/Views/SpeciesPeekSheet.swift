import SwiftUI

/// One candidate as the peek sheet needs it: the species, how sure the model is,
/// and the rarity verdict already resolved against this photo's place and month.
struct SpeciesPeekCandidate: Identifiable, Hashable {
    let species: String
    let confidence: Double
    let plumage: String?
    let rarity: RarityState

    var id: String { species }
}

/// "Wait, hold on, is this the bird?" - a read-only look at a candidate without
/// leaving the identification.
///
/// Pages horizontally across the whole candidate list, so comparing the top pick
/// against the runner-up is one gesture rather than two dismissals. The user's own
/// photo is pinned in the header: at the `.large` detent the confirm screen behind
/// is fully covered, and the comparison is the entire point of being here.
///
/// Nothing here changes the record until Confirm is pressed, so a curious page
/// through the candidates cannot quietly refile the photo.
struct SpeciesPeekSheet: View {
    let candidates: [SpeciesPeekCandidate]
    let startIndex: Int
    let userPhoto: UIImage?
    let onConfirm: (SpeciesPeekCandidate) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var index: Int
    @State private var galleries: [String: [GalleryItem]] = [:]
    @State private var heroIndices: [String: Int] = [:]
    @State private var extracts: [String: String] = [:]
    @State private var expandedExtract = false
    /// Whether the collapsed extract actually overflows, so "More" is only offered
    /// when there is more. Keyed by species: each page measures its own text.
    @State private var truncatedExtracts: [String: Bool] = [:]
    @State private var probeHeights: [String: (clamped: CGFloat, full: CGFloat)] = [:]
    /// Keyed by Commons file page so a paged-to photo never shows the previous
    /// photo's credit while its own is still loading.
    @State private var imageCredits: [String: WikimediaImageCredit] = [:]
    @State private var safariLink: SafariLink?
    /// Width available to the reference row, so the hero and the thumbnail strip are
    /// derived from the device rather than from a constant that overflows a 390pt phone.
    @State private var referenceRowWidth: CGFloat = 0
    /// Opens large: the user came here to read. Dragging to medium uncovers the
    /// confirm screen behind, which is why medium stays on offer.
    @State private var detent: PresentationDetent = .large

    init(
        candidates: [SpeciesPeekCandidate],
        startIndex: Int,
        userPhoto: UIImage?,
        onConfirm: @escaping (SpeciesPeekCandidate) -> Void
    ) {
        self.candidates = candidates
        self.startIndex = startIndex
        self.userPhoto = userPhoto
        self.onConfirm = onConfirm
        // Seeded here rather than in onAppear: the load task keys off the visible
        // species, and starting at 0 would fetch the wrong bird first.
        _index = State(initialValue: min(max(startIndex, 0), max(candidates.count - 1, 0)))
    }

    private var current: SpeciesPeekCandidate? {
        guard candidates.indices.contains(index) else { return candidates.first }
        return candidates[index]
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            TabView(selection: $index) {
                ForEach(Array(candidates.enumerated()), id: \.element.id) { position, candidate in
                    ScrollView { page(for: candidate) }
                        .tag(position)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: candidates.count > 1 ? .always : .never))
            .indexViewStyle(.page(backgroundDisplayMode: .interactive))
        }
        .background(Color.pageBg.ignoresSafeArea())
        .safeAreaInset(edge: .bottom) { confirmBar }
        .presentationDetents([.medium, .large], selection: $detent)
        .presentationDragIndicator(.visible)
        .fullScreenCover(item: $safariLink) { SafariView(link: $0) }
        .task(id: current?.species) { await load() }
        .task(id: currentHeroPageUrl) { await loadCredit() }
        .onChange(of: index) { expandedExtract = false }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 12) {
            if let userPhoto {
                Image(uiImage: userPhoto)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 40, height: 40)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    // The caption beside it already names this.
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text("Your photo")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                if candidates.count > 1 {
                    Text("Candidate \(index + 1) of \(candidates.count). Swipe to compare.")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            Spacer()
            Button("Done") { dismiss() }
                .buttonStyle(.glass)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    // MARK: - Page

    @ViewBuilder
    private func page(for candidate: SpeciesPeekCandidate) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            title(for: candidate)
            references(for: candidate)
            if candidate.rarity != .none, let verdict = candidate.rarity.accessibilityLabel {
                rarityNote(candidate.rarity, verdict: verdict)
            }
            extractText(for: candidate)
            links(for: candidate)
            credits(for: candidate)
        }
        .padding(.horizontal, 16)
        .padding(.top, 16)
        .padding(.bottom, 24)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The same single credits line the species detail page shows, so a bird credits its
    /// sources identically whether it is a candidate or already in the dex.
    @ViewBuilder
    private func credits(for candidate: SpeciesPeekCandidate) -> some View {
        let filePage = currentHero(for: candidate)?.descriptionUrl
        let credit = filePage.flatMap { imageCredits[$0.absoluteString] }
        let creditsText = extracts[candidate.species] != nil

        if filePage != nil || creditsText {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                // The gallery already knows the file page, so that link stands in while the
                // metadata loads and stays if the request fails: a displayed photo must never
                // be uncredited, and CC 4.0 3(a)(2) accepts the file page in place of an
                // inline creator and licence line.
                if let filePage {
                    Button {
                        safariLink = SafariLink(url: filePage)
                    } label: {
                        Text("Photo: \(credit?.label ?? "Wikimedia Commons")")
                            .foregroundStyle(Color.accentColor)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Photo credit and license on Wikimedia Commons")

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

    private func title(for candidate: SpeciesPeekCandidate) -> some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(getDisplayName(candidate.species))
                    .font(.system(size: 22, weight: .semibold, design: .serif))
                    .foregroundStyle(Color.foregroundText)
                if let sci = getScientificName(candidate.species) {
                    Text(sci)
                        .font(.subheadline.italic())
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            Text(BirdIdEngine.formatConfidence(candidate.confidence))
                .font(.system(.title2, design: .serif).weight(.semibold).monospacedDigit())
                .foregroundStyle(Color.confidence(candidate.confidence))
        }
    }

    private func rarityNote(_ state: RarityState, verdict: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            RarityMark(state: state)
                // The sentence beside it already says this; VoiceOver would
                // otherwise hear the verdict twice.
                .accessibilityHidden(true)
            Text(verdict)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Reference photos

    /// A square hero with the rest of the gallery stacked down its right edge.
    ///
    /// Deliberately NOT a horizontal pager: this view is already inside one, and a
    /// swipe that could mean either "next photo" or "next bird" resolves to whichever
    /// gesture recogniser wins. Vertical keeps the alternates one tap away without
    /// spending a row of height on them.
    ///
    /// Both widths come from the measured row, so the pair always fits the screen.
    /// The strip is a fixed four slots wide whatever the gallery returned, so paging
    /// between a bird with four photos and one with two does not resize the hero.
    @ViewBuilder
    private func references(for candidate: SpeciesPeekCandidate) -> some View {
        let items = galleries[candidate.species] ?? []
        let hero = currentHero(for: candidate)
        let spacing = Self.thumbSpacing
        // Four square thumbs plus their gaps span exactly the hero's height, and the
        // hero plus one thumb width plus one gap spans exactly the row.
        let thumb = max((referenceRowWidth - spacing * CGFloat(Self.thumbSlots)) / CGFloat(Self.thumbSlots + 1), 0)
        let heroSize = max(referenceRowWidth - spacing - thumb, 0)

        HStack(alignment: .top, spacing: spacing) {
            Group {
                if let hero {
                    BirdThumbnail(url: hero.url.absoluteString, size: heroSize, cornerRadius: 12)
                } else {
                    RoundedRectangle(cornerRadius: 12)
                        .fill(.regularMaterial)
                        .overlay {
                            Image(systemName: "bird")
                                .font(.title2)
                                .foregroundStyle(.tertiary)
                        }
                }
            }
            .frame(width: heroSize, height: heroSize)

            if items.count > 1 {
                let shown = Array(items.prefix(Self.thumbSlots).enumerated())
                VStack(spacing: spacing) {
                    ForEach(shown, id: \.element.url) { position, item in
                        Button {
                            heroIndices[candidate.species] = position
                        } label: {
                            BirdThumbnail(url: item.url.absoluteString, size: thumb, cornerRadius: 8)
                                .overlay {
                                    RoundedRectangle(cornerRadius: 8)
                                        .strokeBorder(
                                            position == heroIndex(for: candidate) ? Color.accentColor : .clear,
                                            lineWidth: 2
                                        )
                                }
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Reference photo \(position + 1)")
                        // Selection is carried only by the stroke, so VoiceOver has no
                        // way to tell which photo is the hero and the one being credited
                        // below.
                        .accessibilityAddTraits(
                            position == heroIndex(for: candidate) ? .isSelected : []
                        )
                    }
                }
                .frame(width: thumb, height: heroSize, alignment: .top)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { referenceRowWidth = $0 }
    }

    private static let thumbSlots = 4
    private static let thumbSpacing: CGFloat = 8

    private func currentHero(for candidate: SpeciesPeekCandidate) -> GalleryItem? {
        let items = galleries[candidate.species] ?? []
        let position = heroIndex(for: candidate)
        return items.indices.contains(position) ? items[position] : nil
    }

    private func heroIndex(for candidate: SpeciesPeekCandidate) -> Int {
        heroIndices[candidate.species] ?? 0
    }

    private var currentHeroPageUrl: String? {
        current.flatMap { currentHero(for: $0)?.descriptionUrl?.absoluteString }
    }

    /// Keyed off the visible photo rather than the species: tapping a thumbnail
    /// changes the credit without changing the bird.
    private func loadCredit() async {
        guard let page = currentHeroPageUrl, imageCredits[page] == nil else { return }
        imageCredits[page] = await WikimediaCreditService.credit(forFilePage: page)
    }

    // MARK: - Extract

    @ViewBuilder
    private func extractText(for candidate: SpeciesPeekCandidate) -> some View {
        if let extract = extracts[candidate.species] {
            VStack(alignment: .leading, spacing: 4) {
                Text(extract)
                    .font(.system(size: 14))
                    .foregroundStyle(Color.foregroundText.opacity(0.8))
                    .lineSpacing(3)
                    .lineLimit(expandedExtract ? nil : Self.collapsedLines)
                    .background(alignment: .top) { truncationProbe(extract, for: candidate.species) }
                if truncatedExtracts[candidate.species] == true {
                    Button(expandedExtract ? "Less" : "More") {
                        withAnimation(.easeInOut(duration: 0.2)) { expandedExtract.toggle() }
                    }
                    .font(.caption.weight(.medium))
                }
            }
        }
    }

    private static let collapsedLines = 4

    /// Two hidden copies of the same text, one clamped and one not. If the full copy is
    /// taller, the collapsed form is hiding something and "More" has a job to do.
    private func truncationProbe(_ extract: String, for species: String) -> some View {
        let styled = { (limit: Int?) in
            Text(extract)
                .font(.system(size: 14))
                .lineSpacing(3)
                .lineLimit(limit)
                .fixedSize(horizontal: false, vertical: true)
        }
        return VStack(spacing: 0) {
            styled(Self.collapsedLines)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { clamped in
                    probeHeights[species, default: (clamped: 0, full: 0)].clamped = clamped
                    recordTruncation(for: species)
                }
            styled(nil)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { full in
                    probeHeights[species, default: (clamped: 0, full: 0)].full = full
                    recordTruncation(for: species)
                }
        }
        .hidden()
        .accessibilityHidden(true)
    }

    private func recordTruncation(for species: String) {
        guard let heights = probeHeights[species], heights.clamped > 0, heights.full > 0 else { return }
        truncatedExtracts[species] = heights.full > heights.clamped + 1
    }

    // MARK: - Links

    private func links(for candidate: SpeciesPeekCandidate) -> some View {
        // A missing chip is omitted rather than disabled: not every species has a
        // BirdLife factsheet, and a dead control invites a tap that does nothing.
        HStack(spacing: 8) {
            if let url = getWikipediaURL(forSpecies: candidate.species) {
                chip("Wikipedia", icon: "book", url: url)
            }
            if let url = getEbirdURL(for: candidate.species) {
                chip("eBird", icon: "globe", url: url)
            }
            if let url = getBirdlifeFactsheetURL(for: candidate.species) {
                chip("BirdLife", icon: "leaf", url: url)
            }
        }
    }

    private func chip(_ title: String, icon: String, url: URL) -> some View {
        Button {
            safariLink = SafariLink(url: url)
        } label: {
            Label(title, systemImage: icon)
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
    }

    // MARK: - Confirm

    /// The wizard's confirm action, brought down to where the decision is actually
    /// made. Selecting a candidate and then hunting for the toolbar checkmark is two
    /// steps for one thought.
    @ViewBuilder
    private var confirmBar: some View {
        if let candidate = current {
            VStack(spacing: 0) {
                Divider()
                Button {
                    onConfirm(candidate)
                    dismiss()
                } label: {
                    Label("Confirm", systemImage: "checkmark.circle.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.glassProminent)
                .controlSize(.large)
                .padding(16)
                .accessibilityIdentifier("peek.confirm")
            }
            .background(.ultraThinMaterial)
        }
    }

    // MARK: - Loading

    /// Loads the visible candidate, then its neighbours. `CommonsGallery` and
    /// `WikiSummaryService` both cache, so a prefetched swipe lands on a full page.
    private func load() async {
        guard let candidate = current else { return }
        await loadOne(candidate)
        for neighbour in [index - 1, index + 1] where candidates.indices.contains(neighbour) {
            await loadOne(candidates[neighbour])
        }
    }

    private func loadOne(_ candidate: SpeciesPeekCandidate) async {
        if galleries[candidate.species] == nil {
            let leadThumb = getWikiThumbnailUrl(for: candidate.species)
            let items = await CommonsGallery.fetch(
                displayName: getDisplayName(candidate.species),
                leadImageUrl: cardImageUrl(fromThumbnail: leadThumb) ?? leadThumb,
                plumage: candidate.plumage
            )
            guard !Task.isCancelled else { return }
            galleries[candidate.species] = items
        }
        if extracts[candidate.species] == nil,
           let title = getWikiTitle(forSpecies: candidate.species),
           let summary = await WikiSummaryService.summary(for: title),
           let extract = summary.extract {
            guard !Task.isCancelled else { return }
            extracts[candidate.species] = extract
        }
    }
}

// MARK: - Previews

#if DEBUG
private let previewCandidates = [
    SpeciesPeekCandidate(species: "Northern Cardinal (Cardinalis cardinalis)",
                         confidence: 0.55, plumage: "male", rarity: .none),
    SpeciesPeekCandidate(species: "Vermilion Flycatcher (Pyrocephalus rubinus)",
                         confidence: 0.30, plumage: nil, rarity: .both),
    SpeciesPeekCandidate(species: "Summer Tanager (Piranga rubra)",
                         confidence: 0.10, plumage: nil, rarity: .outOfSeason),
]

#Preview("Top candidate") {
    primeTaxonomyLookupsForPreview()
    return SpeciesPeekSheet(
        candidates: previewCandidates,
        startIndex: 0,
        userPhoto: nil,
        onConfirm: { _ in }
    )
}

#Preview("Rare runner-up") {
    primeTaxonomyLookupsForPreview()
    return SpeciesPeekSheet(
        candidates: previewCandidates,
        startIndex: 1,
        userPhoto: nil,
        onConfirm: { _ in }
    )
}

#Preview("Single candidate, AX5") {
    primeTaxonomyLookupsForPreview()
    return SpeciesPeekSheet(
        candidates: [previewCandidates[0]],
        startIndex: 0,
        userPhoto: nil,
        onConfirm: { _ in }
    )
    .environment(\.dynamicTypeSize, .accessibility5)
}
#endif
