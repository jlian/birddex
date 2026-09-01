import SwiftUI
import UIKit

struct HomeView: View {
    @Environment(AuthService.self) private var auth
    @Environment(DataStore.self) private var store
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.showAddPhotos) private var showAddPhotos
    @Environment(\.showWingDex) private var showWingDex
    @Environment(\.showOutings) private var showOutings
    @Environment(\.showSettings) private var showSettings
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var committedSpeciesEntry: DexEntry?
    @State private var actionDestination: OutingActionDestination?
    @State private var outingPendingDeletion: Outing?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                CachedDataNotice()
                rootContent
            }
                // WHY .frame + .background instead of ZStack: wrapping content in a ZStack
                // with Color.pageBg causes a white flash during push/pop transitions when
                // the nav bar collapses. Using .background() on the content directly avoids this.
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .background(Color.pageBg.ignoresSafeArea())
                .navigationTitle("Home")
                .toolbarTitleDisplayMode(.inlineLarge)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        // WHY HStack around a single button: the other tabs group the avatar
                        // with a sort button, and that custom container drops the toolbar
                        // button style's content insets. Without the same container here the
                        // avatar sits further from the trailing edge than on every other tab.
                        HStack(spacing: 5) {
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
                        // WHY negative padding: shifts the avatar closer to the trailing edge
                        // to match Apple Music's profile button position. Without this, the
                        // system toolbar inset leaves too much gap on the right.
                        .padding(.trailing, -12)
                    }
                    // WHY .sharedBackgroundVisibility(.hidden): removes the default liquid glass
                    // pill from behind the avatar button so it renders flat (like Apple Music's
                    // profile icon). HomeView has no sort button, so no explicit .glassEffect
                    // is needed here.
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
                .navigationDestination(for: DexEntry.self) { entry in
                    SpeciesDetailView(speciesName: entry.speciesName, speciesKey: entry.id)
                }
                .navigationDestination(for: Outing.self) { outing in
                    OutingDetailView(outingId: outing.id)
                }
                .navigationDestination(item: $actionDestination) { destination in
                    OutingDetailView(
                        outingId: destination.outing.id,
                        beginsLocationEditing: destination.beginsLocationEditing
                    )
                }
                .navigationDestination(item: $committedSpeciesEntry) { entry in
                    SpeciesDetailView(speciesName: entry.speciesName, speciesKey: entry.id)
                }
        }
    }

    private var cachedLoadErrorBinding: Binding<Bool> {
        Binding(
            get: { store.error != nil && !store.dex.isEmpty },
            set: { if !$0 { store.error = nil } }
        )
    }

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
            emptyState
        } else {
            dataView
        }
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: 24) {
            Spacer()

            // Bird icon in circular tinted background - matches web layout
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

            VStack(spacing: 12) {
                Text("Got bird pics?")
                    .font(.system(.largeTitle, design: .serif, weight: .semibold))
                    .foregroundStyle(Color.foregroundText)
                    .fixedSize(horizontal: false, vertical: true)

                Text("Upload your photos, ID the birds, and build your WingDex.")
                    .font(.body)
                    .foregroundStyle(Color.mutedText)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button {
                showAddPhotos()
            } label: {
                Label {
                    Text("Upload & Identify")
                        .font(.body.weight(.medium))
                        .fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: "camera.fill")
                        .font(.body)
                }
                .font(.body.weight(.medium))
                .frame(maxWidth: .infinity, minHeight: 44)
                .padding(.vertical, 10)
            }
            .buttonStyle(.glassProminent)
            .buttonSizing(.flexible)
            .tint(Color(red: 0.0, green: 0.28, blue: 0.14))
            .padding(.horizontal, 32)

            Spacer()
        }
        .padding(.horizontal, 24)
    }

    // MARK: - Data View

    private var dataView: some View {
        List {
            // Hero stats
            Section {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("\(store.dex.count)")
                        .font(.system(.largeTitle, design: .serif, weight: .semibold))
                        .foregroundStyle(Color.foregroundText)
                    Text("species observed")
                        .font(.system(.title3, design: .serif))
                        .italic()
                        .foregroundStyle(Color.mutedText)
                }
            }
            .listRowSeparator(.hidden)

            // Recent species - horizontal scroll with gradient cards
            let recentSpecies = store.recentSpecies()
            if !recentSpecies.isEmpty {
                Section {
                    Button {
                        showWingDex()
                    } label: {
                        HStack(spacing: 5) {
                            Text("Recent Species")
                                .font(.system(.title3, design: .serif, weight: .semibold))
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                        }
                        .foregroundStyle(Color.foregroundText)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .listRowSeparator(.hidden)
                    .buttonStyle(.plain)
                    .accessibilityLabel("Open WingDex")

                    GeometryReader { geo in
                        let spacing: CGFloat = 10
                        let padding: CGFloat = 16
                        let visibleCards: CGFloat = dynamicTypeSize.isAccessibilitySize ? 1.1 : 2.25
                        let cardSize = (geo.size.width - padding * 2 - spacing * 2) / visibleCards
                        SpeciesCarousel(
                            entries: recentSpecies,
                            auth: auth,
                            store: store,
                            toasts: toasts,
                            cardSize: cardSize,
                            menu: { speciesContextMenu(for: $0) },
                            accessibilityActions: { speciesAccessibilityActions(for: $0) },
                            onSelect: { committedSpeciesEntry = $0 }
                        )
                        .frame(height: cardSize)
                    }
                    .aspectRatio(dynamicTypeSize.isAccessibilitySize ? 1.1 : 2.25, contentMode: .fit)
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                }
            }

            // Recent outings
            let recentOutings = store.recentOutings()
            if !recentOutings.isEmpty {
                Section {
                    Button {
                        showOutings()
                    } label: {
                        HStack(spacing: 5) {
                            Text("Recent Outings")
                                .font(.system(.title3, design: .serif, weight: .semibold))
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                        }
                        .foregroundStyle(Color.foregroundText)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .listRowSeparator(.hidden)
                    .buttonStyle(.plain)
                    .accessibilityLabel("Open Outings")

                    ForEach(recentOutings) { outing in
                        NavigationLink(value: outing) {
                            OutingRow(outing: outing, store: store)
                        }
                        .outingRowActions(
                            outing: outing,
                            pendingDeletion: $outingPendingDeletion,
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
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .listSectionSeparator(.hidden, edges: .top)
        .outingDeletionConfirmation($outingPendingDeletion)
    }

    private func speciesContextMenu(for entry: DexEntry) -> UIMenu {
        var actions: [UIMenuElement] = []

        actions.append(UIAction(title: "View Details", image: UIImage(systemName: "bird")) { _ in
            committedSpeciesEntry = entry
        })

        actions.append(UIAction(title: "Share", image: UIImage(systemName: "square.and.arrow.up")) { _ in
            presentActivitySheet(items: [SharePayload.species(entry)])
        })

        if let url = getEbirdURL(forCode: entry.taxonCode) ?? getEbirdURL(for: entry.speciesName) {
            actions.append(UIAction(title: "Open in eBird", image: UIImage(systemName: "globe")) { _ in
                UIApplication.shared.open(url)
            })
        }

        if let url = getWikipediaURL(for: entry.wikiTitle) {
            actions.append(UIAction(title: "Open in Wikipedia", image: UIImage(systemName: "book")) { _ in
                UIApplication.shared.open(url)
            })
        }

        return UIMenu(children: actions)
    }

    private func speciesAccessibilityActions(
        for entry: DexEntry
    ) -> [ContextMenuAccessibilityAction] {
        var actions = [
            ContextMenuAccessibilityAction(name: "View Details") {
                committedSpeciesEntry = entry
            },
            ContextMenuAccessibilityAction(name: "Share") {
                presentActivitySheet(items: [SharePayload.species(entry)])
            },
        ]
        if let url = getEbirdURL(forCode: entry.taxonCode) ?? getEbirdURL(for: entry.speciesName) {
            actions.append(.init(name: "Open in eBird") { UIApplication.shared.open(url) })
        }
        if let url = getWikipediaURL(for: entry.wikiTitle) {
            actions.append(.init(name: "Open in Wikipedia") { UIApplication.shared.open(url) })
        }
        return actions
    }
}

#if DEBUG
#Preview("Home - Populated") {
    PreviewTabs(.home) { HomeView() }
        .environment(AuthService())
        .environment(previewStore())
}

#Preview("Home - Empty") {
    PreviewTabs(.home) { HomeView() }
        .environment(AuthService())
        .environment(previewStore(empty: true))
}

#endif
