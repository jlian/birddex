import SwiftUI

// MARK: - App Entry Point

@main
struct WingDexApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var authService: AuthService
    @State private var dataStore: DataStore
    @State private var navigation = AppNavigationModel.shared

    init() {
        let auth = AuthService()
        let cache = try? AccountDataCache()
        _authService = State(initialValue: auth)
        _dataStore = State(initialValue: DataStore(
            serviceFactory: { accountID in
                DataService(auth: auth, expectedAccountID: accountID)
            },
            cache: cache
        ))

        // UIKit-rendered controls (menu popovers, pickers, alerts) don't inherit
        // the SwiftUI AccentColor asset. Set UIKit's global tint to match.
        UIView.appearance().tintColor = UIColor(named: "AccentColor")
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(authService)
                .environment(dataStore)
                .environment(navigation)
                .onOpenURL { url in
                    guard url.scheme == Config.oauthCallbackScheme,
                          url.host == "share-import"
                    else { return }
                    navigation.handleIncomingShare()
                }
        }
    }
}

// MARK: - Root Content View

/// Root view that shows either auth or the main tab interface.
struct ContentView: View {
    @Environment(AuthService.self) private var auth
    @Environment(DataStore.self) private var store
    @Environment(AppNavigationModel.self) private var navigation
    @Environment(\.scenePhase) private var scenePhase

    @State private var isValidating = true

    var body: some View {
        Group {
            if isValidating {
                SessionValidationView()
            } else if auth.isAuthenticated {
                MainTabView()
                    .transition(.opacity)
            } else {
                SignInView()
                    .transition(.opacity)
                    #if DEBUG
                    .task {
                        if ProcessInfo.processInfo.arguments.contains("--auto-sign-in"),
                           !auth.isAuthenticated {
                            try? await auth.signInAnonymously()
                        }
                    }
                    #endif
            }
        }
        .background(Color.pageBg.ignoresSafeArea())
        .animation(.easeInOut(duration: 0.25), value: auth.isAuthenticated)
        .onChange(of: auth.isAuthenticated) { _, isAuthenticated in
            if isAuthenticated, let accountID = auth.userId {
                store.activate(accountID: accountID)
            } else if !isAuthenticated {
                navigation.setMainInterfaceReady(false)
                store.clearActiveAccount()
                if let accountID = auth.consumeDiscardedAccountID() {
                    store.clearCachedAccount(accountID: accountID)
                }
            }
        }
        .onChange(of: auth.userId) { _, accountID in
            guard auth.isAuthenticated, let accountID else { return }
            store.activate(accountID: accountID)
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active, auth.isAuthenticated, !isValidating else { return }
            Task { await auth.validateSession(force: false) }
        }
        .task {
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--ui-test-sign-out") {
                auth.signOut()
            }
            #endif
            if let discardedAccountID = auth.consumeDiscardedAccountID() {
                store.clearCachedAccount(accountID: discardedAccountID)
            }
            if auth.isAuthenticated, let accountID = auth.userId {
                store.activate(accountID: accountID)
                isValidating = false
                await auth.validateSession()
            } else {
                isValidating = false
            }
        }
    }
}

private struct SessionValidationView: View {
    var body: some View {
        VStack(spacing: 12) {
            ProgressView()
                .controlSize(.large)
            Text("Checking your session...")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.pageBg.ignoresSafeArea())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Checking your session")
    }
}

// MARK: - Main Tab View

/// Three-tab main interface with detached "+" and avatar settings sheet.
struct MainTabView: View {
    @Environment(AuthService.self) private var auth
    @Environment(DataStore.self) private var store
    @Environment(AppNavigationModel.self) private var navigation
    @Environment(\.scenePhase) private var scenePhase
    @State private var showingSettings = false
    @State private var addPhotosVM = AddPhotosViewModel()
    @State private var showingWizard = false
    @State private var initialDataLoaded = false

    var body: some View {
        @Bindable var navigation = navigation

        TabView(selection: $navigation.selectedTab) {
            TabSection {
                Tab("Home", systemImage: "house", value: AppTab.home) {
                    HomeView()
                }
                Tab("WingDex", image: "BirdTab", value: AppTab.wingdex) {
                    WingDexView()
                }
                Tab("Outings", systemImage: "binoculars", value: AppTab.outings) {
                    OutingsView()
                }
            }

            Tab(value: AppTab.add, role: .search) {
                NavigationStack {
                    PhotoSelectionView(viewModel: addPhotosVM)
                        .navigationTitle("Add Photos")
                        .navigationBarTitleDisplayMode(.inline)
                        .onAppear {
                            addPhotosVM.configure(
                                auth: auth,
                                dataStore: store
                            )
                        }
                        // Opening this tab is the first sign the user intends to
                        // identify, and paying the model load here keeps it off
                        // launch for everyone who never does.
                        .task { try? await BirdIdEngine.shared.warmUp() }
                }
            } label: {
                Label("Add", systemImage: "camera.fill")
            }
        }
        .onChange(of: addPhotosVM.currentStep) {
            if addPhotosVM.currentStep != .selectPhotos {
                showingWizard = true
            }
        }
        .fullScreenCover(isPresented: $showingWizard, onDismiss: {
            addPhotosVM.cancelSession()
            addPhotosVM = AddPhotosViewModel()
            addPhotosVM.configure(
                auth: auth,
                dataStore: store
            )
            if IncomingShareStore.hasPendingShare {
                Task { await importIncomingShareIfAvailable() }
            }
        }) {
            NavigationStack {
                AddPhotosFlow(viewModel: addPhotosVM)
            }
        }
        .sheet(isPresented: $showingSettings) {
            SettingsView()
        }
        .task {
            navigation.setMainInterfaceReady(true)
            async let taxonomyWarmup: Void = prewarmTaxonomyLookups()
            await store.loadAll()
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--auto-demo-data"),
               store.dex.isEmpty {
                try? await store.loadDemoData()
            }
            #endif
            await completeInitialLoadIfReady()
            _ = await taxonomyWarmup
            #if DEBUG
            await startUITestIdentificationIfRequested()
            #endif
        }
        .onChange(of: store.hasLoadedAll) { _, hasLoadedAll in
            guard hasLoadedAll else { return }
            Task {
                await completeInitialLoadIfReady()
                await addPhotosVM.processSelectedPhotos()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active, initialDataLoaded, IncomingShareStore.hasPendingShare else { return }
            navigation.route(to: .addPhotos())
            Task { await importIncomingShareIfAvailable() }
        }
        .onDisappear {
            navigation.setMainInterfaceReady(false)
            addPhotosVM.cancelSession()
        }
        .task(id: navigation.incomingShareRequestID) {
            guard initialDataLoaded else { return }
            await importIncomingShareIfAvailable()
        }
        .environment(\.showAddPhotos) { navigation.route(to: .addPhotos()) }
        .environment(\.showSettings) { showingSettings = true }
        .environment(\.showWingDex) { navigation.route(to: .wingdex()) }
        .environment(\.showHome) { navigation.route(to: .home) }
        .environment(\.showOutings) { navigation.route(to: .outings) }
    }

    private func importIncomingShareIfAvailable() async {
        guard initialDataLoaded, IncomingShareStore.hasPendingShare else { return }
        addPhotosVM.configure(
            auth: auth,
            dataStore: store
        )
        await addPhotosVM.importIncomingShareIfAvailable()
    }

    private func completeInitialLoadIfReady() async {
        guard !initialDataLoaded, auth.isAuthenticated, store.hasLoadedAll else { return }
        initialDataLoaded = true
        if IncomingShareStore.hasPendingShare {
            navigation.route(to: .addPhotos())
            await importIncomingShareIfAvailable()
        }
    }

    #if DEBUG
    /// Feeds a bird photo straight into the add-photos flow so UI tests can exercise
    /// on-device identification. The system photo picker runs out of process and is
    /// invisible to the accessibility tree, so it cannot be driven from a test. The
    /// path is passed in rather than bundled so tests reuse the shared fixtures in
    /// src/assets/images without shipping them in the app.
    private func startUITestIdentificationIfRequested() async {
        let args = ProcessInfo.processInfo.arguments
        guard let flag = args.firstIndex(of: "--ui-test-photo"),
              args.index(after: flag) < args.endIndex,
              let image = UIImage(contentsOfFile: args[args.index(after: flag)])
        else { return }
        let latitude = launchArgument("--ui-test-lat", in: args).flatMap(Double.init)
        let longitude = launchArgument("--ui-test-lon", in: args).flatMap(Double.init)
        addPhotosVM.configure(
            auth: auth,
            dataStore: store
        )
        if args.contains("--ui-test-clear-last-location") {
            addPhotosVM.lastLocationName = ""
        }
        addPhotosVM.addCameraPhoto(image, lat: latitude, lon: longitude)
        await addPhotosVM.processSelectedPhotos()
    }

    private func launchArgument(_ name: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: name),
              arguments.index(after: index) < arguments.endIndex
        else { return nil }
        return arguments[arguments.index(after: index)]
    }
    #endif
}

// MARK: - Avatar View

/// Renders a user avatar - emoji (from SVG data URL), remote image, or fallback initial.
struct AvatarView: View {
    let imageURL: String?
    let name: String?
    let size: CGFloat

    private var emojiInfo: (emoji: String, color: Color)? {
        guard let url = imageURL,
              url.hasPrefix("data:image/svg+xml") else { return nil }
        let decoded = url.removingPercentEncoding ?? url
        let emojiMap: [(String, Color)] = [
            ("🐦", Color(red: 0.88, green: 0.95, blue: 1.0)),
            ("🦉", Color(red: 1.0, green: 0.95, blue: 0.88)),
            ("🦜", Color(red: 0.88, green: 1.0, blue: 0.93)),
            ("🐧", Color(red: 0.93, green: 0.94, blue: 0.96)),
            ("🦆", Color(red: 0.88, green: 0.98, blue: 0.96)),
            ("🦩", Color(red: 1.0, green: 0.91, blue: 0.95)),
            ("🦅", Color(red: 1.0, green: 0.95, blue: 0.90)),
            ("🐤", Color(red: 1.0, green: 0.98, blue: 0.88)),
        ]
        for (emoji, color) in emojiMap {
            if decoded.contains(emoji) { return (emoji, color) }
        }
        return nil
    }

    var body: some View {
        if let info = emojiInfo {
            Text(info.emoji)
                .font(.system(size: size * 0.6))
                .minimumScaleFactor(0.5)
                .frame(width: size, height: size)
                .background(info.color)
                .clipShape(Circle())
        } else if let image = imageURL, !image.isEmpty,
                  let url = URL(string: image) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let img):
                    img.resizable()
                        .scaledToFill()
                        .frame(width: size, height: size)
                        .clipShape(Circle())
                default:
                    fallbackView
                }
            }
        } else {
            fallbackView
        }
    }

    private var fallbackView: some View {
        Image(systemName: "person.fill")
            .font(.system(size: size * 0.42, weight: .medium))
            .foregroundStyle(Color.foregroundText)
            .frame(width: size, height: size)
            .background(Color.cardBg)
            .clipShape(Circle())
    }
}

#if DEBUG
#Preview("App - Session Validation") {
    SessionValidationView()
}

#Preview("App - Authenticated") {
    ContentView()
        .environment(AuthService())
        .environment(previewStore())
    .environment(AppNavigationModel())
}

#Preview("App - Signed Out") {
    ContentView()
        .environment(AuthService())
        .environment(previewStore(empty: true))
        .environment(AppNavigationModel())
}
#endif
