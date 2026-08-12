import SwiftUI

struct OutingsView: View {
    @Environment(AuthService.self) private var auth
    @Environment(DataStore.self) private var store
    @Environment(\.showSettings) private var showSettings
    @State private var searchText = ""
    @State private var sortField: OutingSortField = .date
    @State private var sortAscending = false
    @State private var actionDestination: OutingActionDestination?

    // MARK: - Sort Options

    enum OutingSortField: String, CaseIterable {
        case date, species, name
        var label: String {
            switch self {
            case .date: "Date"
            case .species: "Species Seen"
            case .name: "Name"
            }
        }
        var icon: String {
            switch self {
            case .date: "calendar"
            case .species: "bird"
            case .name: "textformat.abc"
            }
        }
    }

    // MARK: - Sorted Data

    private var sortedOutings: [Outing] {
        let sorted: [Outing]
        switch sortField {
        case .date:
            sorted = store.outings.sorted {
                store.sortDate(for: $0).compare(store.sortDate(for: $1))
                == (sortAscending ? .orderedAscending : .orderedDescending)
            }
        case .species:
            sorted = store.outings.sorted {
                let a = store.speciesCount(for: $0.id)
                let b = store.speciesCount(for: $1.id)
                return sortAscending ? a < b : a > b
            }
        case .name:
            sorted = store.outings.sorted {
                let cmp = $0.locationName.localizedCaseInsensitiveCompare($1.locationName)
                return sortAscending ? cmp == .orderedAscending : cmp == .orderedDescending
            }
        }

        if searchText.isEmpty { return sorted }
        return sorted.filter {
            $0.locationName.localizedCaseInsensitiveContains(searchText)
        }
    }

    // MARK: - Body

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                CachedDataNotice()
                rootContent
            }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .background(Color.pageBg.ignoresSafeArea())
                .navigationTitle("Outings")
                .toolbarTitleDisplayMode(.inlineLarge)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        // WHY HStack: see WingDexView - keeps sort + avatar tightly grouped.
                        HStack(spacing: 5) {
                            Menu {
                                Picker("Sort by", selection: $sortField) {
                                    ForEach(OutingSortField.allCases, id: \.self) { field in
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
                            // WHY: see WingDexView - re-add glass on sort only.
                            .glassEffect(.regular.interactive())

                            Button { showSettings() } label: {
                                AccountAvatarView(size: 40)
                            }
                            .accessibilityLabel(auth.isRegisteredAccount ? "Settings" : "Log in")
                            .accessibilityValue(
                                auth.identity == .anonymous && (!store.outings.isEmpty || !store.observations.isEmpty)
                                    ? "These sightings are only on this device"
                                    : ""
                            )
                        }
                        .padding(.trailing, -12)
                    }
                    // WHY: see WingDexView - independent glass per button.
                    .sharedBackgroundVisibility(.hidden)
                }
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
                    text: $searchText,
                    placement: .navigationBarDrawer(displayMode: .automatic),
                    prompt: "Search outings"
                )
                .navigationDestination(for: Outing.self) { outing in
                    OutingDetailView(outingId: outing.id)
                }
                .navigationDestination(item: $actionDestination) { destination in
                    OutingDetailView(
                        outingId: destination.outing.id,
                        beginsLocationEditing: destination.beginsLocationEditing
                    )
                }
        }
    }

    private var cachedLoadErrorBinding: Binding<Bool> {
        Binding(
            get: { store.error != nil && !store.outings.isEmpty },
            set: { if !$0 { store.error = nil } }
        )
    }

    // MARK: - Empty State

    @ViewBuilder
    private var rootContent: some View {
        if store.isLoading && store.outings.isEmpty {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let error = store.error, store.outings.isEmpty {
            ContentUnavailableView {
                Label("Could Not Load Outings", systemImage: "wifi.exclamationmark")
            } description: {
                Text(error.message)
            } actions: {
                Button("Retry") { Task { await store.loadAll() } }
                    .buttonStyle(.borderedProminent)
            }
        } else if store.outings.isEmpty {
            VStack(spacing: 24) {
                Spacer()
                ZStack {
                    Circle()
                        .fill(Color.accentColor.opacity(0.1))
                        .frame(width: 80, height: 80)
                    Image(systemName: "binoculars.fill")
                        .font(.system(size: 32))
                        .foregroundStyle(Color.accentColor)
                }
                VStack(spacing: 8) {
                    Text("No Outings Yet")
                        .font(.system(size: 22, weight: .semibold, design: .serif))
                        .foregroundStyle(Color.foregroundText)
                    Text("Upload photos to create your first outing.")
                        .font(.system(size: 15))
                        .foregroundStyle(Color.mutedText)
                        .multilineTextAlignment(.center)
                }
                Spacer()
            }
            // WHY: see WingDexView - prevents white bars on empty state.
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.horizontal, 24)
        } else {
            outingsList
        }
    }

    // MARK: - Outings List

    private var outingsList: some View {
        List(sortedOutings) { outing in
            NavigationLink(value: outing) {
                OutingRow(outing: outing, store: store)
            }
            .outingRowActions(
                outing: outing,
                onView: {
                    actionDestination = OutingActionDestination(
                        outing: outing,
                        beginsLocationEditing: false
                    )
                },
                onEditLocation: {
                    actionDestination = OutingActionDestination(
                        outing: outing,
                        beginsLocationEditing: true
                    )
                }
            )
        }
        .listStyle(.plain)
        .listSectionSeparator(.hidden, edges: .top)
        .scrollContentBackground(.hidden)
    }
}

#if DEBUG
#Preview("Outings - Populated") {
    PreviewTabs(.outings) { OutingsView() }
        .environment(AuthService())
        .environment(previewStore())
}

#Preview("Outings - Empty") {
    PreviewTabs(.outings) { OutingsView() }
        .environment(AuthService())
        .environment(previewStore(empty: true))
}
#endif
