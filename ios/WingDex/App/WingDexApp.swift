import SwiftUI
import os

private let appLog = Logger(subsystem: Config.bundleID, category: "App")

enum SignupPromptStore {
    private static let prefix = "wingdex.signupPrompted."

    static func hasPrompted(userID: String, defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: prefix + userID)
    }

    static func markPrompted(userID: String, defaults: UserDefaults = .standard) {
        defaults.set(true, forKey: prefix + userID)
    }

    static func reset(defaults: UserDefaults = .standard) {
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(prefix) {
            defaults.removeObject(forKey: key)
        }
    }
}

// MARK: - App Entry Point

@main
struct WingDexApp: App {
    private static let incomingShareObserver: Void = {
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            nil,
            { _, _, _, _, _ in
                DispatchQueue.main.async {
                    AppNavigationModel.shared.handleIncomingShare()
                }
            },
            IncomingShareStore.changeNotificationName as CFString,
            nil,
            .deliverImmediately
        )
    }()

    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var authService: AuthService
    @State private var dataStore: DataStore
    @State private var navigation = AppNavigationModel.shared
    @State private var toasts = ToastCenter()

    init() {
        _ = Self.incomingShareObserver
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
                .environment(toasts)
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

    private var blocksForAccountMerge: Bool {
        auth.isRegisteredAccount
            && (auth.hasPendingAccountMergeForCurrentAccount || auth.accountMergeState != .none)
    }

    var body: some View {
        // Render the shell immediately, but do not activate restored account
        // cache until session validation says valid or offline.
        ZStack {
            MainTabView()
                .disabled(blocksForAccountMerge)
            if blocksForAccountMerge {
                AccountMergeRecoveryView()
            }
        }
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
            guard auth.hasSession, !blocksForAccountMerge, let accountID else { return }
            store.activate(accountID: accountID)
            Task { try? await store.ensureLoaded() }
        }
        .onChange(of: auth.accountMergeState) { _, state in
            guard state == .none,
                  auth.isRegisteredAccount,
                  let accountID = auth.userId
            else { return }
            store.activate(accountID: accountID)
            Task { try? await store.ensureLoaded() }
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active, auth.hasSession else { return }
            Task { await auth.validateSession(force: false) }
        }
        .task {
            #if DEBUG
            if (ProcessInfo.processInfo.arguments.contains("--ui-test-clear-pending-share")
                || ProcessInfo.processInfo.arguments.contains("--ui-test-reset-pending-share")),
               let pendingShare = try? IncomingShareStore.pendingShare() {
                try? IncomingShareStore.completePendingShare(id: pendingShare.id)
            }
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
                let validation = await auth.validateSession()
                if validation != .rejected,
                   auth.userId == accountID {
                          if auth.isRegisteredAccount,
                              !(await auth.resumePendingAccountMerge()) {
                        return
                    }
                    store.activate(accountID: accountID)
                    try? await store.ensureLoaded()
                }
            }
        }
    }
}

private struct AccountMergeRecoveryView: View {
    @Environment(AuthService.self) private var auth

    var body: some View {
        VStack(spacing: 18) {
            AppIconView()
                .frame(width: 64, height: 64)
            Text("Keeping your WingDex...")
                .font(.title2.bold())
            if auth.accountMergeState == .failed {
                Text("Your original sightings are safe. Retry to finish adding them to this account.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button("Retry") {
                    Task { await auth.resumePendingAccountMerge() }
                }
                .buttonStyle(.glassProminent)
                .buttonSizing(.flexible)
                Button("Sign out") {
                    Task { await auth.signOut() }
                }
                .buttonStyle(.glass)
                .buttonSizing(.flexible)
            } else {
                ProgressView()
            }
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.regularMaterial)
        .accessibilityIdentifier("accountMerge.recovery")
    }
}

// MARK: - Main Tab View

/// Three-tab main interface with detached "+" and avatar settings sheet.
struct MainTabView: View {
    @Environment(AuthService.self) private var auth
    @Environment(DataStore.self) private var store
    @Environment(AppNavigationModel.self) private var navigation
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.scenePhase) private var scenePhase
    @State private var showingSettings = false
    @State private var showingAccount = false
    @State private var addPhotosVM = AddPhotosViewModel()
    @State private var showingWizard = false
    @State private var initialDataLoaded = false
    #if DEBUG
    private let uiTestForcesSettings = ProcessInfo.processInfo.arguments.contains("--ui-test-open-settings")
    private let uiTestIgnoresPendingShare = ProcessInfo.processInfo.arguments.contains("--ui-test-clear-pending-share")
    @State private var uiTestDataSetupIdentifier = "ui-test.dataSetupPending"
    #else
    private let uiTestForcesSettings = false
    private let uiTestIgnoresPendingShare = false
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
                // Add is a real tab, not a modal trigger. Its own stack keeps
                // picker navigation scoped to the tab when it is reselected.
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
        .toastPresenter(toasts.notice)
        #if DEBUG
        .accessibilityIdentifier(uiTestDataSetupIdentifier)
        #endif
        .onChange(of: addPhotosVM.currentStep) {
            if addPhotosVM.currentStep != .selectPhotos {
                showingWizard = true
            }
        }
        .fullScreenCover(isPresented: $showingWizard, onDismiss: {
            let shouldResumePendingShare = addPhotosVM.resumesPendingShareAfterDismissal
            let shouldPrompt = auth.identity == .anonymous
                && addPhotosVM.savedOutingCount > 0
                && auth.userId.map { !SignupPromptStore.hasPrompted(userID: $0) } == true
            addPhotosVM.cancelSession()
            addPhotosVM = AddPhotosViewModel()
            addPhotosVM.configure(
                auth: auth,
                dataStore: store
            )
            if shouldResumePendingShare, IncomingShareStore.hasPendingShare {
                Task { await importIncomingShareIfAvailable() }
            }
            if shouldPrompt {
                if let userID = auth.userId { SignupPromptStore.markPrompted(userID: userID) }
                showingAccount = true
            }
        }) {
            NavigationStack {
                AddPhotosFlow(viewModel: addPhotosVM)
            }
        }
        .sheet(isPresented: $showingSettings) {
            SettingsView()
                .toastPresenter(toasts.notice)
        }
        .onChange(of: auth.identity) { _, identity in
            if identity != .registered && !uiTestForcesSettings {
                showingSettings = false
            }
        }
        .fullScreenCover(isPresented: $showingAccount) {
            AccountAccessView()
        }
        .task {
            navigation.setMainInterfaceReady(true)
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--ui-test-reset-signup-prompt") {
                SignupPromptStore.reset()
            }
            #endif
            async let taxonomyWarmup: Void = prewarmTaxonomyLookups()
            #if DEBUG
            let arguments = ProcessInfo.processInfo.arguments
            do {
                try await prepareUITestData(arguments: arguments)
                if arguments.contains("--ui-test-share-photo") {
                    try await stageUITestSharePhoto()
                    navigation.handleIncomingShare()
                }
                if arguments.contains("--ui-test-open-settings") {
                    showingSettings = true
                    await Task.yield()
                }
                uiTestDataSetupIdentifier = "ui-test.dataSetupComplete"
            } catch {
                uiTestDataSetupIdentifier = "ui-test.dataSetupFailed"
            }
            #endif
            await completeInitialLoadIfReady()
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--ui-test-delayed-share-photo") {
                Task { @MainActor in
                    try? await Task.sleep(for: .seconds(1))
                    try? await stageUITestSharePhoto()
                }
            }
            #endif
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
            guard !uiTestIgnoresPendingShare,
                  phase == .active,
                  IncomingShareStore.hasPendingShare
            else { return }
            Task { await importIncomingShareIfAvailable() }
        }
        .onDisappear {
            navigation.setMainInterfaceReady(false)
            addPhotosVM.cancelSession()
        }
        .task(id: navigation.incomingShareRequestID) {
            guard !uiTestIgnoresPendingShare else { return }
            await importIncomingShareIfAvailable()
        }
        .onReceive(NotificationCenter.default.publisher(for: IncomingShareStore.didStageNotification)) { _ in
            navigation.handleIncomingShare()
        }
        .environment(\.showAddPhotos) { navigation.route(to: .addPhotos()) }
        .environment(\.showSettings) {
            if auth.isRegisteredAccount {
                showingSettings = true
            } else {
                showingAccount = true
            }
        }
        .environment(\.showWingDex) { navigation.route(to: .wingdex()) }
        .environment(\.showHome) { navigation.route(to: .home) }
        .environment(\.showOutings) { navigation.route(to: .outings) }
    }

    #if DEBUG
    private func prepareUITestData(arguments: [String]) async throws {
        let needsAccount = arguments.contains("--ui-test-clear-data")
            || arguments.contains("--ui-test-seed-csv")
            || arguments.contains("--ui-test-open-settings")
        guard needsAccount else { return }

        var lastError: Error = AuthError.notAuthenticated
        for attempt in 1...3 {
            var stage = "anonymous session"
            do {
                if attempt == 1,
                   arguments.contains("--ui-test-transient-data-setup-failure") {
                    stage = "injected transient failure"
                    throw URLError(.timedOut)
                }
                try await auth.ensureAnonymousSession()
                guard let accountID = auth.userId else { throw AuthError.notAuthenticated }
                if store.activeAccountID != accountID { store.activate(accountID: accountID) }

                stage = "initial account load"
                try await store.ensureLoaded()

                if arguments.contains("--ui-test-clear-data")
                    || arguments.contains("--ui-test-seed-csv") {
                    stage = "account data clear"
                    try await store.clearAll()
                }

                if let seedFlag = arguments.firstIndex(of: "--ui-test-seed-csv"),
                   arguments.index(after: seedFlag) < arguments.endIndex {
                    stage = "seed outing write"
                    let service = DataService(auth: auth, expectedAccountID: accountID)
                    let outingID = "ui-test-seeded-outing-\(accountID)"
                    _ = try await service.createOuting(Outing(
                        id: outingID,
                        userId: accountID,
                        startTime: "2026-02-12T06:58:00-03:00",
                        endTime: "2026-02-12T07:58:00-03:00",
                        locationName: "Parque Ibirapuera, Sao Paulo",
                        notes: "UI test seed",
                        createdAt: "2026-02-12T06:58:00-03:00"
                    ))
                    stage = "seed observation write"
                    _ = try await service.createObservations([
                        BirdObservation(
                            id: "ui-test-chalk-browed-\(accountID)",
                            outingId: outingID,
                            speciesName: "Chalk-browed Mockingbird (Mimus saturninus)",
                            count: 1,
                            certainty: .confirmed,
                            notes: ""
                        ),
                        BirdObservation(
                            id: "ui-test-eared-dove-\(accountID)",
                            outingId: outingID,
                            speciesName: "Eared Dove (Zenaida auriculata)",
                            count: 1,
                            certainty: .confirmed,
                            notes: ""
                        ),
                    ])
                    stage = "seeded account reload"
                    await store.loadAll()
                    guard store.hasLoadedAll else { throw store.error ?? AuthError.notAuthenticated }
                }
                return
            } catch {
                lastError = error
                appLog.warning("UI test data setup failed during \(stage, privacy: .public), attempt \(attempt)")
                if attempt < 3 { try? await Task.sleep(for: .seconds(attempt)) }
            }
        }
        throw lastError
    }
    #endif

    private func importIncomingShareIfAvailable() async {
        guard !uiTestIgnoresPendingShare,
              IncomingShareStore.hasPendingShare
        else { return }
        navigation.route(to: .addPhotos())
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
        if !uiTestIgnoresPendingShare, IncomingShareStore.hasPendingShare {
            await importIncomingShareIfAvailable()
        }
    }

    #if DEBUG
    private func stageUITestSharePhoto() async throws {
        let size = CGSize(width: 320, height: 240)
        let image = UIGraphicsImageRenderer(size: size).image { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(origin: .zero, size: size))
            UIColor.systemYellow.setFill()
            context.cgContext.fillEllipse(in: CGRect(x: 110, y: 70, width: 100, height: 100))
        }
        guard let data = image.jpegData(compressionQuality: 0.9) else {
            throw IncomingShareError.stagingFailed
        }
        let source = FileManager.default.temporaryDirectory
            .appendingPathComponent("ui-test-share-\(UUID().uuidString).jpg")
        try data.write(to: source, options: Data.WritingOptions.atomic)
        defer { try? FileManager.default.removeItem(at: source) }
        try await IncomingShareStore.stage(fileURLs: [source])
    }

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

private struct AccountAccessView: View {
    @Environment(AuthService.self) private var auth
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            SignInView()
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close", systemImage: "xmark") { dismiss() }
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
    @Environment(\.displayScale) private var displayScale

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
        renderer.scale = displayScale
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
