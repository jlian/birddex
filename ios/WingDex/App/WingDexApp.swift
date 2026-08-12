import SwiftUI

// MARK: - App Entry Point

@main
struct WingDexApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var authService: AuthService
    @State private var dataStore: DataStore
    @State private var navigation = AppNavigationModel.shared

    init() {
        let auth = AuthService.shared
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

/// Root view that keeps the main interface available with or without an account.
struct ContentView: View {
    @Environment(AuthService.self) private var auth
    @Environment(DataStore.self) private var store
    @Environment(AppNavigationModel.self) private var navigation
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        MainTabView()
        .background(Color.pageBg.ignoresSafeArea())
        .onChange(of: auth.identity) { _, identity in
            if identity == .none {
                store.clearActiveAccount()
                if let accountID = auth.consumeDiscardedAccountID() {
                    store.clearCachedAccount(accountID: accountID)
                }
            }
        }
        .onChange(of: auth.userId) { _, accountID in
            guard auth.hasSession, let accountID else { return }
            store.activate(accountID: accountID)
            Task { await store.loadAll() }
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active, auth.hasSession else { return }
            Task { await auth.validateSession(force: false) }
        }
        .task {
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--ui-test-sign-out") {
                await auth.signOut()
            }
            if ProcessInfo.processInfo.arguments.contains("--auto-sign-in"),
               !auth.hasSession {
                try? await auth.ensureAnonymousSession()
            }
            #endif
            if let discardedAccountID = auth.consumeDiscardedAccountID() {
                store.clearCachedAccount(accountID: discardedAccountID)
            }
            if auth.hasSession, let accountID = auth.userId {
                store.activate(accountID: accountID)
                await auth.validateSession()
                await store.loadAll()
            }
        }
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
    @State private var showingAccount = false
    @State private var accountPromptReason: AccountPromptReason = .default
    @State private var addPhotosVM = AddPhotosViewModel()
    @State private var showingWizard = false
    @State private var initialDataLoaded = false
    @AppStorage("wingdex.signupPrompted") private var signupPrompted = false
    #if DEBUG
    @State private var uiTestDataSetupIdentifier = "ui-test.dataSetupPending"
    #endif

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
        #if DEBUG
        .accessibilityIdentifier(uiTestDataSetupIdentifier)
        #endif
        .onChange(of: addPhotosVM.currentStep) {
            if addPhotosVM.currentStep != .selectPhotos {
                showingWizard = true
            }
        }
        .fullScreenCover(isPresented: $showingWizard, onDismiss: {
            let shouldPrompt = auth.identity == .anonymous
                && addPhotosVM.savedOutingCount > 0
                && !signupPrompted
            addPhotosVM.cancelSession()
            addPhotosVM = AddPhotosViewModel()
            addPhotosVM.configure(
                auth: auth,
                dataStore: store
            )
            if IncomingShareStore.hasPendingShare {
                Task { await importIncomingShareIfAvailable() }
            }
            if shouldPrompt {
                signupPrompted = true
                accountPromptReason = .firstSave
                showingAccount = true
            }
        }) {
            NavigationStack {
                AddPhotosFlow(viewModel: addPhotosVM)
            }
        }
        .sheet(isPresented: $showingSettings) {
            SettingsView()
        }
        .onChange(of: auth.identity) { _, identity in
            if identity != .registered {
                showingSettings = false
            }
        }
        .fullScreenCover(isPresented: $showingAccount) {
            AccountAccessView(reason: accountPromptReason)
        }
        .task {
            navigation.setMainInterfaceReady(true)
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--ui-test-reset-signup-prompt") {
                signupPrompted = false
            }
            #endif
            async let taxonomyWarmup: Void = prewarmTaxonomyLookups()
            #if DEBUG
            let arguments = ProcessInfo.processInfo.arguments
            do {
                if arguments.contains("--ui-test-clear-data") {
                    try await store.clearAll()
                }
                uiTestDataSetupIdentifier = "ui-test.dataSetupComplete"
            } catch {
                uiTestDataSetupIdentifier = "ui-test.dataSetupFailed"
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
        .onChange(of: auth.userId) {
            initialDataLoaded = false
            addPhotosVM.configure(auth: auth, dataStore: store)
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
        .environment(\.showSettings) {
            if auth.isRegisteredAccount {
                showingSettings = true
            } else {
                accountPromptReason = .default
                showingAccount = true
            }
        }
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
        guard !initialDataLoaded else { return }
        if !auth.hasSession {
            initialDataLoaded = true
        } else {
            guard store.hasLoadedAll else { return }
            initialDataLoaded = true
        }
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

private enum AccountPromptReason {
    case `default`
    case firstSave
}

private struct AccountAccessView: View {
    @Environment(AuthService.self) private var auth
    @Environment(\.dismiss) private var dismiss
    let reason: AccountPromptReason

    var body: some View {
        NavigationStack {
            SignInView(showsKeepSightingsMessage: reason == .firstSave)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close", systemImage: "xmark") { dismiss() }
                    }
                    if auth.identity == .anonymous {
                        ToolbarItem(placement: .topBarTrailing) {
                            NavigationLink {
                                DataManagementView()
                            } label: {
                                Image(systemName: "trash")
                            }
                            .accessibilityLabel("Delete Data")
                        }
                    }
                }
        }
        .onChange(of: auth.isRegisteredAccount) { _, isRegistered in
            if isRegistered { dismiss() }
        }
    }
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
        avatar
            // Purely decorative: every call site sits inside a labelled control.
            .accessibilityHidden(true)
    }

    @ViewBuilder
    private var avatar: some View {
        if let info = emojiInfo, let image = renderedEmoji(info.emoji) {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
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

    private func renderedEmoji(_ emoji: String) -> UIImage? {
        let renderer = ImageRenderer(
            content: Text(emoji)
                .font(.system(size: size * 0.6))
                .frame(width: size, height: size)
        )
        renderer.scale = UIScreen.main.scale
        return renderer.uiImage
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

struct AccountAvatarView: View {
    @Environment(AuthService.self) private var auth
    @Environment(DataStore.self) private var store
    let size: CGFloat

    private var hasAnonymousData: Bool {
        auth.identity == .anonymous
            && (!store.outings.isEmpty || !store.observations.isEmpty)
    }

    var body: some View {
        AvatarView(imageURL: auth.avatarImage, name: auth.userName, size: size)
            .overlay(alignment: .bottomTrailing) {
                if hasAnonymousData {
                    Circle()
                        .fill(.yellow)
                        .frame(width: size * 0.25, height: size * 0.25)
                        .overlay(Circle().stroke(Color.pageBg, lineWidth: 2))
                        .offset(x: 1, y: 1)
                        .accessibilityHidden(true)
                }
            }
            .accessibilityHidden(true)
    }
}

#if DEBUG
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
