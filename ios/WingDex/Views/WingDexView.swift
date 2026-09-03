import SwiftUI

struct WingDexView: View {
    @Environment(AuthService.self) private var auth
    @Environment(DataStore.self) private var store
    @Environment(AppNavigationModel.self) private var navigation
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.showSettings) private var showSettings
    @State private var sortField: DexSortField = .date
    @State private var sortAscending = false
    @State private var contextMenuSpecies: DexEntry?

    // MARK: - Sort Options

    enum DexSortField: String, CaseIterable {
        case date, count, name, family
        var label: String {
            switch self {
            case .date: "Date"
            case .count: "Count"
            case .name: "Name"
            case .family: "Family"
            }
        }
        var icon: String {
            switch self {
            case .date: "calendar"
            case .count: "number"
            case .name: "textformat.abc"
            case .family: "leaf"
            }
        }
    }

    // MARK: - Sorted Data

    private var sortedDex: [DexEntry] {
        let sorted: [DexEntry]
        switch sortField {
        case .date:
            sorted = store.dex.sorted {
                store.sortDate(for: $0).compare(store.sortDate(for: $1))
                == (sortAscending ? .orderedAscending : .orderedDescending)
            }
        case .count:
            sorted = store.dex.sorted {
                sortAscending ? $0.totalCount < $1.totalCount : $0.totalCount > $1.totalCount
            }
        case .name:
            sorted = store.dex.sorted {
                let cmp = ($0.commonName ?? getDisplayName($0.speciesName))
                    .localizedCaseInsensitiveCompare($1.commonName ?? getDisplayName($1.speciesName))
                return sortAscending ? cmp == .orderedAscending : cmp == .orderedDescending
            }
        case .family:
            sorted = store.dex.sorted {
                taxonomicSpeciesPrecedes(
                    $0.commonName ?? $0.speciesName,
                    $1.commonName ?? $1.speciesName,
                    ascending: sortAscending
                )
            }
        }

        if navigation.wingDexFilter.isEmpty { return sorted }
        let query = navigation.wingDexFilter.lowercased()
        return sorted.filter {
            [$0.commonName, $0.scientificName, $0.speciesName]
                .compactMap { $0 }
                .contains { $0.lowercased().contains(query) }
        }
    }

    // MARK: - Body

    var body: some View {
        @Bindable var navigation = navigation

        NavigationStack {
            VStack(spacing: 0) {
                CachedDataNotice()
                rootContent
            }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .background(Color.pageBg.ignoresSafeArea())
                .navigationTitle("WingDex")
                .toolbarTitleDisplayMode(.inlineLarge)
                .toolbar { toolbarContent }
                .refreshable {
                    await store.loadAll()
                }
                .alert("Could Not Refresh", isPresented: cachedLoadErrorBinding) {
                    Button("Retry") { Task { await store.loadAll() } }
                    Button("OK", role: .cancel) { store.error = nil }
                } message: {
                    Text(store.error?.message ?? "Something went wrong. Try again.")
                }
                .searchable(
                    text: $navigation.wingDexFilter,
                    placement: .navigationBarDrawer(displayMode: .automatic),
                    prompt: "Search species"
                )
                .navigationDestination(for: DexEntry.self) { entry in
                    SpeciesDetailView(speciesName: entry.speciesName, speciesKey: entry.id)
                }
                .navigationDestination(item: $contextMenuSpecies) { entry in
                    SpeciesDetailView(speciesName: entry.speciesName, speciesKey: entry.id)
                }
                .sensoryFeedback(.selection, trigger: sortField)
                .sensoryFeedback(.selection, trigger: sortAscending)
        }
    }

    private var cachedLoadErrorBinding: Binding<Bool> {
        Binding(
            get: { store.error != nil && !store.dex.isEmpty },
            set: { if !$0 { store.error = nil } }
        )
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            HStack(spacing: 5) {
                Menu {
                    Picker(
                        "Sort by",
                        selection: Binding(
                            get: { sortField },
                            set: { selectSortField($0) }
                        )
                    ) {
                        ForEach(DexSortField.allCases, id: \.self) { field in
                            Label(field.label, systemImage: field.icon)
                                .tag(field)
                        }
                    }

                    Divider()

                    Button {
                        sortAscending.toggle()
                    } label: {
                        Label(
                            sortAscending ? "Ascending" : "Descending",
                            systemImage: sortAscending ? "arrow.up" : "arrow.down"
                        )
                    }
                } label: {
                    Label("Sort", systemImage: "arrow.up.arrow.down")
                }
                .glassEffect(.regular.interactive())

                Button { showSettings() } label: {
                    AccountAvatarView(size: 40)
                }
                .accessibilityLabel(auth.isRegisteredAccount ? "Settings" : "Log in")
                .accessibilityValue(
                    auth.identity == .anonymous && store.hasAccountDataAtRisk
                        ? "These sightings are only on this device"
                        : ""
                )
            }
            .padding(.trailing, -12)
        }
        .sharedBackgroundVisibility(.hidden)
    }

    private func selectSortField(_ field: DexSortField) {
        if sortField == field {
            sortAscending.toggle()
            return
        }
        sortField = field
        sortAscending = field == .name || field == .family
    }

    // MARK: - Empty State

    @ViewBuilder
    private var rootContent: some View {
        if store.isLoading && store.dex.isEmpty {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let error = store.error, store.dex.isEmpty {
            ContentUnavailableView {
                Label("Could Not Load WingDex", systemImage: "wifi.exclamationmark")
            } description: {
                Text(error.message)
            } actions: {
                Button("Retry") { Task { await store.loadAll() } }
                    .buttonStyle(.borderedProminent)
            }
        } else if store.dex.isEmpty {
            VStack(spacing: 24) {
                Spacer()
                ZStack {
                    Circle()
                        .fill(Color.accentColor.opacity(0.1))
                        .frame(width: 80, height: 80)
                    Image("BirdLogo")
                        .renderingMode(.template)
                        .resizable()
                        .scaledToFit()
                        .frame(width: 40, height: 40)
                        .foregroundStyle(Color.accentColor)
                }
                VStack(spacing: 8) {
                    Text("No Species Yet")
                        .font(.title2)
                        .fontDesign(.serif)
                        .fontWeight(.semibold)
                        .foregroundStyle(Color.foregroundText)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("Species will appear here as you identify birds.")
                        .font(.body)
                        .foregroundStyle(Color.mutedText)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
            }
            // WHY .frame(maxWidth/maxHeight .infinity): without this, the empty-state
            // VStack only takes its intrinsic content size, leaving white bars on the sides
            // and bottom that don't match the pageBg set on the parent NavigationStack.
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.horizontal, 24)
        } else {
            speciesList
        }
    }

    // MARK: - Species List

    private var speciesList: some View {
        List(sortedDex) { entry in
            NavigationLink(value: entry) {
                BirdRow(
                    speciesName: entry.speciesName,
                    displayName: entry.commonName,
                    scientificName: entry.scientificName,
                    taxonCode: entry.taxonCode,
                    thumbnailUrl: entry.thumbnailUrl,
                    subtitle: "\(entry.totalOutings) outing\(entry.totalOutings == 1 ? "" : "s") \u{00B7} \(entry.totalCount) seen \u{00B7} \(DateFormatting.formatDate(entry.firstSeenDate, style: .medium))"
                )
            }
            .contextMenu {
                Button {
                    contextMenuSpecies = entry
                } label: {
                    Label("View Details", systemImage: "bird")
                }
                ShareLink(item: SharePayload.species(entry)) {
                    Label("Share", systemImage: "square.and.arrow.up")
                }
                if let url = getEbirdURL(forCode: entry.taxonCode) ?? getEbirdURL(for: entry.speciesName) {
                    Link(destination: url) {
                        Label("Open in eBird", systemImage: "globe")
                    }
                }
                if let url = getWikipediaURL(for: entry.wikiTitle) {
                    Link(destination: url) {
                        Label("Open in Wikipedia", systemImage: "book")
                    }
                }
            } preview: {
                // WHY NavigationStack + explicit environments: context menu previews render
                // in an isolated view hierarchy outside the parent NavigationStack. Without
                // wrapping in NavigationStack, navigation titles and toolbars are missing.
                // Child views must receive their observable dependencies again here.
                NavigationStack {
                    SpeciesDetailView(speciesName: entry.speciesName, speciesKey: entry.id)
                }
                .environment(auth)
                .environment(store)
                .environment(toasts)
            }
        }
        .listStyle(.plain)
        .listSectionSeparator(.hidden, edges: .top)
        .scrollContentBackground(.hidden)
    }
}

#if DEBUG
#Preview("WingDex - Populated") {
    PreviewTabs(.wingdex) { WingDexView() }
        .environment(AuthService())
        .environment(previewStore())
        .environment(AppNavigationModel())
}

#Preview("WingDex - Empty") {
    PreviewTabs(.wingdex) { WingDexView() }
        .environment(AuthService())
        .environment(previewStore(empty: true))
        .environment(AppNavigationModel())
}
#endif
