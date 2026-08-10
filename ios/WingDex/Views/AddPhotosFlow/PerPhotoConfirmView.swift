import SwiftUI
import os

private let log = Logger(subsystem: Config.bundleID, category: "PerPhotoConfirm")

/// Per-photo species confirmation view.
///
/// Toolbar layout:
/// - Top left: X (cancel wizard with confirmation)
/// - Top right: primary action icon (checkmark or forward)
/// - Bottom left: back chevron (if not first photo)
/// - Bottom right: secondary tools (crop, possible, skip)
struct PerPhotoConfirmView: View {
    @Bindable var viewModel: AddPhotosViewModel

    @State private var selectedSpecies = ""
    @State private var selectedConfidence: Double = 0
    @State private var isLoadingWikiImage = false
    @State private var galleryItems: [(url: URL, plumage: String?)] = []
    @State private var galleryTask: Task<Void, Never>?
    @State private var galleryIndex = 0
    @State private var decodedCroppedImage: UIImage?
    @State private var decodedThumbnail: UIImage?
    @State private var decodeTask: Task<Void, Never>?

    private var photo: ProcessedPhoto? { viewModel.currentPhoto }
    private var candidates: [IdentifiedCandidate] { viewModel.currentCandidates }
    private var photoIndex: Int { viewModel.currentPhotoIndex }
    private var totalPhotos: Int { viewModel.clusterPhotos.count }
    private var confidencePercent: Int { Int(selectedConfidence * 100) }
    private var displayName: String { getDisplayName(selectedSpecies) }
    private var scientificName: String? { getScientificName(selectedSpecies) }
    private var selectedPlumage: String? { candidates.first { $0.species == selectedSpecies }?.plumage }

    private func plumageIcon(_ p: String) -> String? {
        let l = p.lowercased()
        if l.contains("juvenile") || l.contains("immature") || l.contains("chick") { return "\u{1F423}" }
        if l.contains("female") { return "\u{2640}" }
        if l.contains("male") { return "\u{2642}" }
        return nil
    }
    private var hasCandidates: Bool { !candidates.isEmpty }

// MARK: - Body

    var body: some View {
        VStack(spacing: 0) {
            if hasCandidates {
                candidateView
            } else {
                noCandidatesView
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.pageBg.ignoresSafeArea())
        .navigationTitle("Photo \(photoIndex + 1) of \(totalPhotos)")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // Confirm action top-right (tinted green)
            ToolbarItem(placement: .primaryAction) {
                if hasCandidates {
                    Button {
                        confirmWith(status: .confirmed)
                    } label: {
                        Image(systemName: "checkmark")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(selectedSpecies.isEmpty)
                } else {
                    Button("Skip", role: .destructive) {
                        viewModel.skipCurrentPhoto()
                    }
                }
            }
            // Bottom bar: back (left) + overflow menu (right)
            ToolbarItemGroup(placement: .bottomBar) {
                if photoIndex > 0 {
                    Button {
                        viewModel.goBackToPreviousPhoto()
                    } label: {
                        Image(systemName: "chevron.left")
                    }
                }

                Spacer()

                if hasCandidates {
                    Menu {
                        Button {
                            viewModel.reidentifyCurrentPhoto()
                        } label: {
                            Label("Re-identify", systemImage: "sparkles")
                        }
                        Button {
                            confirmWith(status: .possible)
                        } label: {
                            Label("Mark as Possible", systemImage: "questionmark")
                        }
                        .disabled(selectedSpecies.isEmpty)
                        Button {
                            viewModel.requestManualCrop()
                        } label: {
                            Label("Re-crop", systemImage: "crop")
                        }
                        Button(role: .destructive) {
                            viewModel.skipCurrentPhoto()
                        } label: {
                            Label("Skip Photo", systemImage: "forward")
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                } else {
                    Button("Re-crop") {
                        viewModel.requestManualCrop()
                    }
                }
            }
        }
        .onAppear { initializeSelection() }
        .onChange(of: viewModel.currentPhotoIndex) { initializeSelection() }
        .onChange(of: viewModel.currentCandidates.count) { initializeSelection() }
        .onDisappear {
            decodeTask?.cancel()
            galleryTask?.cancel()
        }
    }

    // MARK: - No Candidates

    private var noCandidatesView: some View {
        VStack(spacing: 24) {
            Spacer()

            if let uiImage = decodedThumbnail {
                Image(uiImage: uiImage)
                    .resizable()
                    .scaledToFit()
                    .frame(maxHeight: 220)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .padding(.horizontal, 40)
            }

            Image(systemName: "questionmark.circle")
                .font(.system(size: 40))
                .foregroundStyle(.secondary)

            Text("No bird species identified")
                .font(.headline)

            Text("Try cropping to isolate the bird, or skip this photo.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)

            Spacer()
        }
    }

    // MARK: - Candidate View

    private var candidateView: some View {
        GeometryReader { geo in
            let contentWidth = geo.size.width - 32
            let photoSize = (contentWidth - 12) / 2

            VStack(spacing: 0) {
                Spacer(minLength: 0)

                VStack(spacing: 16) {
                    HStack(spacing: 12) {
                        VStack(spacing: 6) {
                            aiCroppedUserPhoto(size: photoSize)
                            Text("Cropped photo")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .frame(width: photoSize)

                        VStack(spacing: 6) {
                            wikiSquareThumbnail(size: photoSize)
                            Text(currentRefLabel)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .frame(width: photoSize)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 16)

                    speciesCard
                    Text("Photos from [Wikimedia Commons](https://commons.wikimedia.org), occurrence data from [iNaturalist](https://www.inaturalist.org).")
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                        .tint(.secondary)
                        .frame(maxWidth: .infinity)
                }

                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    // MARK: - AI-Cropped Square User Photo

    private func aiCroppedUserPhoto(size: CGFloat) -> some View {
        Group {
            if let img = decodedCroppedImage {
                Image(uiImage: img)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size, height: size)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            } else {
                fallbackPhoto(size: size)
            }
        }
        .contextMenu {
            Button {
                viewModel.reidentifyCurrentPhoto()
            } label: {
                Label("Re-identify", systemImage: "sparkles")
            }
        }
    }

    private func fallbackPhoto(size: CGFloat) -> some View {
        Group {
            if let uiImage = decodedThumbnail {
                Image(uiImage: uiImage)
                    .resizable()
                    .scaledToFill()
                    .frame(width: size, height: size)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            } else {
                RoundedRectangle(cornerRadius: 12)
                    .fill(.regularMaterial)
                    .frame(width: size, height: size)
                    .overlay {
                        Image(systemName: "photo")
                            .font(.title2)
                            .foregroundStyle(.tertiary)
                    }
            }
        }
    }

    // MARK: - Wiki Square Thumbnail (portrait-aware, swipeable gallery)

    /// Reorder gallery items so plumage-matching images come first.
    private func sortedByPlumage(_ items: [(url: URL, plumage: String?)]) -> [(url: URL, plumage: String?)] {
        guard let detected = selectedPlumage?.lowercased(), !detected.isEmpty else { return items }
        let detectedTags = Set(detected.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) })
        let matching = items.filter { item in
            guard let p = item.plumage?.lowercased() else { return false }
            let tags = p.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            return !detectedTags.isDisjoint(with: tags)
        }
        let rest = items.filter { item in
            guard let p = item.plumage?.lowercased() else { return true }
            let tags = p.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            return detectedTags.isDisjoint(with: tags)
        }
        return matching + rest
    }

    private var allWikiURLs: [URL] { galleryItems.map(\.url) }

    /// Label for the current gallery image, including plumage if available.
    private var currentRefLabel: String {
        let items = galleryItems
        guard !items.isEmpty else { return "Reference" }
        let idx = min(galleryIndex, items.count - 1)
        if idx >= 0, let plumage = items[idx].plumage {
            return "Reference (\(plumage))"
        }
        return "Reference"
    }

    private func wikiSquareThumbnail(size: CGFloat) -> some View {
        let urls = allWikiURLs
        let safeIndex = urls.isEmpty ? 0 : min(galleryIndex, urls.count - 1)

        return ZStack(alignment: .bottom) {
            if urls.isEmpty {
                if isLoadingWikiImage {
                    wikiPlaceholder(size: size)
                        .overlay { ProgressView() }
                } else {
                    wikiPlaceholder(size: size)
                }
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(spacing: 0) {
                        ForEach(Array(urls.enumerated()), id: \.offset) { i, url in
                            BirdThumbnail(url: url.absoluteString, size: size, cornerRadius: 12)
                                .frame(width: size, height: size)
                                .id(i)
                        }
                    }
                    .scrollTargetLayout()
                }
                .scrollTargetBehavior(.paging)
                .scrollPosition(id: Binding(
                    get: { safeIndex },
                    set: { if let v = $0 { galleryIndex = v } }
                ))
                .frame(width: size, height: size)
            }

            // Dot indicators
            if urls.count > 1 {
                HStack(spacing: 4) {
                    ForEach(0..<urls.count, id: \.self) { i in
                        Circle()
                            .fill(i == safeIndex ? Color.white : Color.white.opacity(0.4))
                            .frame(width: 6, height: 6)
                    }
                }
                .padding(.bottom, 6)
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private func wikiPlaceholder(size: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: 12)
            .fill(.regularMaterial)
            .frame(width: size, height: size)
            .overlay {
                Image(systemName: "bird")
                    .font(.title2)
                    .foregroundStyle(.tertiary)
            }
    }

    // MARK: - Species Card

    private var speciesCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        Text(displayName)
                            .font(.title3.weight(.semibold))
                            .accessibilityIdentifier("confirm.speciesName")
                        if let plumage = selectedPlumage, let icon = plumageIcon(plumage) {
                            Text(icon)
                                .font(.subheadline)
                                .accessibilityLabel(plumage)
                        }
                    }
                    if let sci = scientificName {
                        Text(sci)
                            .font(.subheadline.italic())
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                Text(BirdIdEngine.formatConfidence(selectedConfidence))
                    .font(.system(.title2, weight: .bold).monospacedDigit())
                    .foregroundStyle(confidenceColor)
                    .accessibilityIdentifier("confirm.confidence")
            }

            ProgressView(value: selectedConfidence)
                .tint(confidenceColor)

            if candidates.count > 1 {
                Divider()
                Text("All candidates")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
                ForEach(candidates, id: \.species) { candidate in
                    candidateRow(candidate)
                }
            }
        }
        .padding(16)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
        .padding(.horizontal, 16)
    }

    private func candidateRow(_ candidate: IdentifiedCandidate) -> some View {
        let isSelected = candidate.species == selectedSpecies
        return Button {
            selectAlternative(candidate)
        } label: {
            HStack {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.body)
                    .foregroundStyle(isSelected ? Color.accentColor : Color.secondary.opacity(0.4))
                Text(getDisplayName(candidate.species))
                    .font(.body)
                if let plumage = candidate.plumage, let icon = plumageIcon(plumage) {
                    Text(icon)
                        .font(.caption)
                        .accessibilityLabel(plumage)
                }
                Spacer()
                if let range = candidate.rangeStatus, range == "out-of-range" || range == "near-range" {
                    Image(systemName: range == "out-of-range" ? "location.slash" : "location")
                        .font(.system(size: 10))
                        .foregroundStyle(range == "out-of-range" ? .red : .orange)
                }
                Text(BirdIdEngine.formatConfidence(candidate.confidence))
                    .font(.body.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 10)
            .padding(.horizontal, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Helpers

    private var confidenceColor: Color {
        if confidencePercent >= 80 { return .green }
        if confidencePercent >= 50 { return .orange }
        return .red
    }

    private func initializeSelection() {
        if let top = candidates.first {
            selectedSpecies = top.species
            selectedConfidence = top.confidence
        } else { selectedSpecies = ""; selectedConfidence = 0 }
        decodeUserImages()
        fetchWikiImage()
    }

    private func selectAlternative(_ candidate: IdentifiedCandidate) {
        selectedSpecies = candidate.species
        selectedConfidence = candidate.confidence
        fetchWikiImage()
    }

    /// Decode user photo images off the main thread so the view body never calls UIImage(data:).
    /// Captures only Sendable values into the detached task.
    private func decodeUserImages() {
        decodeTask?.cancel()
        decodedCroppedImage = nil
        decodedThumbnail = nil
        guard let currentPhoto = photo else { return }
        let photoId = currentPhoto.id
        let croppedData = currentPhoto.croppedImage
        let thumbData = currentPhoto.thumbnail
        decodeTask = Task.detached(priority: .userInitiated) {
            let decoded = Self.decodeImages(
                croppedData: croppedData,
                thumbData: thumbData
            )
            guard !Task.isCancelled else { return }
            await MainActor.run {
                guard photo?.id == photoId else { return }
                decodedCroppedImage = decoded.cropped
                decodedThumbnail = decoded.thumb
            }
        }
    }

    /// Sendable wrapper for the decoded UIImages crossing the actor boundary.
    private struct DecodedImages: @unchecked Sendable {
        let cropped: UIImage?
        let thumb: UIImage?
    }

    private nonisolated static func decodeImages(
        croppedData: Data?,
        thumbData: Data
    ) -> DecodedImages {
        let cropped = croppedData.flatMap { UIImage(data: $0) }
        let thumb = UIImage(data: thumbData)
        return DecodedImages(cropped: cropped, thumb: thumb)
    }

    private func confirmWith(status: ObservationStatus) {
        viewModel.confirmCurrentPhoto(species: selectedSpecies, confidence: selectedConfidence, status: status, count: 1)
    }

    private func fetchWikiImage() {
        galleryTask?.cancel()
        galleryIndex = 0
        let species = selectedSpecies
        guard !species.isEmpty else { galleryItems = []; galleryIndex = 0; return }

        let displayName = getDisplayName(species)
        isLoadingWikiImage = true
        galleryItems = []

        // Single Wikimedia Commons search: returns thumbnails + descriptions in one call
        galleryTask = Task { await performCommonsGalleryFetch(displayName: displayName) }
    }

    private struct CommonsResponse: Codable {
        let query: Query?
        struct Query: Codable { let pages: [String: Page]? }
        struct Page: Codable {
            let title: String?
            let index: Int?
            let imageinfo: [ImageInfo]?
        }
        struct ImageInfo: Codable {
            let thumburl: String?
            let extmetadata: ExtMetadata?
        }
        struct ExtMetadata: Codable {
            let ImageDescription: MetaValue?
            let Assessments: MetaValue?
        }
        struct MetaValue: Codable { let value: String? }
    }

    private static let excludeRE = try! NSRegularExpression(
        pattern: "\\.(svg|gif)$|Status_|IUCN|range_map|distribution|map_of|map\\.png|stamp_of|MHNT|MWNH|_egg|_nest|museum|specimen|skeleton|taxiderm|wikimedia-logo|commons-logo|wikidata-logo|cscr-|question_book|edit-clear|crystal_clear|ambox|folder_hexagonal",
        options: .caseInsensitive
    )
    private static let captionExcludeRE = try! NSRegularExpression(
        pattern: "\\beggs?\\b|\\bnest\\b|\\bskeleton\\b|\\bspecimen\\b|\\btaxiderm",
        options: .caseInsensitive
    )

    /// Parse plumage from caption + filename text (matches web logic).
    private func parseGalleryPlumage(_ text: String) -> String? {
        let lower = text.lowercased().replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ")
        var tags: [String] = []
        if lower.contains("drake") { tags.append("male") }
        else if lower.contains("male") && !lower.contains("female") { tags.append("male") }
        if lower.contains("female") || lower.contains("hen") { tags.append("female") }
        if lower.range(of: "\\bjuvenile\\b|\\bchick\\b|\\bduckling\\b|\\bimmature\\b", options: .regularExpression) != nil {
            tags.append("juvenile")
        }
        return tags.isEmpty ? nil : tags.joined(separator: ", ")
    }

    private func performCommonsGalleryFetch(displayName: String) async {
        do {
            let query = "\"\(displayName)\"".addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? displayName
            let urlStr = "https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=\(query)&gsrnamespace=6&gsrlimit=12&prop=imageinfo&iiprop=extmetadata%7Curl&iiurlwidth=500&format=json&origin=*"
            guard let url = URL(string: urlStr) else {
                log.debug("Commons gallery: invalid URL: \(urlStr)")
                await MainActor.run { isLoadingWikiImage = false }
                return
            }
            var req = URLRequest(url: url)
            req.setValue("WingDex-iOS/1.0", forHTTPHeaderField: "User-Agent")
            let (data, _) = try await URLSession.shared.data(for: req)
            try Task.checkCancellation()

            let response = try JSONDecoder().decode(CommonsResponse.self, from: data)
            guard !Task.isCancelled else { return }
            let pageCount = response.query?.pages?.count ?? 0
            log.debug("Commons gallery: \(pageCount) pages for '\(displayName)'")

            // Score: featured > quality > relevance
            var scored: [(page: CommonsResponse.Page, score: Int, relevance: Int)] = []
            if let pages = response.query?.pages?.values {
                for page in pages {
                    let assessed = page.imageinfo?.first?.extmetadata?.Assessments?.value ?? ""
                    let s = assessed.contains("featured") ? 0 : assessed.contains("quality") ? 1 : 2
                    scored.append((page: page, score: s, relevance: page.index ?? 999))
                }
            }
            scored.sort { $0.score != $1.score ? $0.score < $1.score : $0.relevance < $1.relevance }

            var urls: [URL] = []
            var plumages: [String?] = []
            for entry in scored {
                let title = entry.page.title ?? ""
                let titleRange = NSRange(title.startIndex..., in: title)
                if Self.excludeRE.firstMatch(in: title, range: titleRange) != nil { continue }
                guard let thumbStr = entry.page.imageinfo?.first?.thumburl,
                      let thumbURL = URL(string: thumbStr) else { continue }
                let rawDesc = entry.page.imageinfo?.first?.extmetadata?.ImageDescription?.value ?? ""
                let desc = rawDesc.replacingOccurrences(of: "<[^>]*>", with: "", options: String.CompareOptions.regularExpression)
                let descRange = NSRange(desc.startIndex..., in: desc)
                if Self.captionExcludeRE.firstMatch(in: desc, range: descRange) != nil { continue }
                urls.append(thumbURL)
                plumages.append(parseGalleryPlumage([desc, title].joined(separator: " ")))
                if urls.count >= 6 { break }
            }
            guard !Task.isCancelled else { return }
            log.debug("Commons gallery: \(urls.count) URLs after filtering")
            let items = zip(urls, plumages).map { (url, plumage) in (url: url, plumage: plumage) }
            await MainActor.run {
                galleryItems = sortedByPlumage(items)
                isLoadingWikiImage = false
            }
        } catch is CancellationError { /* expected */ }
        catch {
            log.debug("Commons gallery fetch failed")
            await MainActor.run { isLoadingWikiImage = false }
        }
    }
}

// MARK: - Previews

#if DEBUG
#Preview("High Confidence") {
    NavigationStack {
        let vm = AddPhotosViewModel()
        PerPhotoConfirmView(viewModel: vm)
            .onAppear {
                vm.clusters = [PreviewData.sampleCluster(photoCount: 3)]
                vm.currentPhotoIndex = 1
                vm.photoResults = [PhotoResult(
                    photoId: "preview-0", species: "Bald Eagle (Haliaeetus leucocephalus)",
                    confidence: 0.95, status: .confirmed, count: 1
                )]
                vm.currentCandidates = [
                    IdentifiedCandidate(species: "Bald Eagle (Haliaeetus leucocephalus)", confidence: 0.92, wikiTitle: "Bald_eagle", plumage: nil, rangeStatus: nil),
                    IdentifiedCandidate(species: "Golden Eagle (Aquila chrysaetos)", confidence: 0.06, wikiTitle: "Golden_eagle", plumage: nil, rangeStatus: nil),
                ]
            }
    }
}

#Preview("Low Confidence") {
    NavigationStack {
        let vm = AddPhotosViewModel()
        PerPhotoConfirmView(viewModel: vm)
            .onAppear {
                vm.clusters = [PreviewData.sampleCluster(photoCount: 5)]
                vm.currentPhotoIndex = 2
                vm.currentCandidates = [
                    IdentifiedCandidate(species: "Northern Cardinal (Cardinalis cardinalis)", confidence: 0.55, wikiTitle: "Northern_cardinal", plumage: nil, rangeStatus: nil),
                    IdentifiedCandidate(species: "Vermilion Flycatcher (Pyrocephalus rubinus)", confidence: 0.30, wikiTitle: "Vermilion_flycatcher", plumage: nil, rangeStatus: nil),
                    IdentifiedCandidate(species: "Summer Tanager (Piranga rubra)", confidence: 0.10, wikiTitle: "Summer_tanager", plumage: nil, rangeStatus: nil),
                ]
            }
    }
}

#Preview("No Candidates") {
    NavigationStack {
        let vm = AddPhotosViewModel()
        PerPhotoConfirmView(viewModel: vm)
            .onAppear {
                vm.clusters = [PreviewData.sampleCluster(photoCount: 2, lat: nil, lon: nil)]
                vm.currentCandidates = []
            }
    }
}

#Preview("Canvas Selection") {
    let vm = AddPhotosViewModel()
    PerPhotoConfirmView(viewModel: vm)
        .frame(width: 390, height: 760)
        .background(Color.pageBg)
        .onAppear {
            vm.clusters = [PreviewData.sampleCluster(photoCount: 5)]
            vm.currentPhotoIndex = 2
            vm.currentCandidates = [
                IdentifiedCandidate(species: "Northern Cardinal (Cardinalis cardinalis)", confidence: 0.55, wikiTitle: "Northern_cardinal", plumage: nil, rangeStatus: nil),
                IdentifiedCandidate(species: "Vermilion Flycatcher (Pyrocephalus rubinus)", confidence: 0.30, wikiTitle: "Vermilion_flycatcher", plumage: nil, rangeStatus: nil),
                IdentifiedCandidate(species: "Summer Tanager (Piranga rubra)", confidence: 0.10, wikiTitle: "Summer_tanager", plumage: nil, rangeStatus: nil),
            ]
        }
}
#endif
