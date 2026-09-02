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
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var authService: AuthService
    @State private var dataStore: DataStore
    @State private var navigation = AppNavigationModel.shared
    @State private var toasts = ToastCenter()

    init() {
        let auth = AuthService.shared
        let cache = try? AccountDataCache()
        #if DEBUG
        let uiTestDataMode = UITestDataService.Mode(arguments: ProcessInfo.processInfo.arguments)
        if uiTestDataMode != nil {
            auth.installUITestAnonymousIdentity()
        }
        #endif
        let store = DataStore(
            serviceFactory: { accountID in
                #if DEBUG
                if let uiTestDataMode {
                    return UITestDataService(mode: uiTestDataMode)
                }
                #endif
                return DataService(auth: auth, expectedAccountID: accountID)
            },
            cache: cache
        )
        if auth.hasSession, let accountID = auth.userId {
            store.activate(accountID: accountID)
        }
        _authService = State(initialValue: auth)
        _dataStore = State(initialValue: store)

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
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.scenePhase) private var scenePhase
    @State private var accountMergeRefreshInProgress = false
    @State private var accountMergeRefreshAccountID: String?
    @State private var accountMergeRefreshAttemptID: UUID?
    @State private var accountMergeRefreshFailed = false
    @State private var pendingRecoveredMergeResult: AccountMergeResult?
    @State private var pendingRecoveredMergeAccountID: String?

    private var blocksForAccountMerge: Bool {
        auth.isRegisteredAccount
            && (auth.hasPendingAccountMergeForCurrentAccount
                || auth.accountMergeState != .none
                || accountMergeRefreshInProgress
                || accountMergeRefreshFailed)
    }

    /// True only when sightings are actually moving between accounts. A plain interactive
    /// sign-in also runs the finalize probe and reaches `.finalizing`, and telling that user
    /// their WingDex is being kept is both alarming and untrue.
    private var isMergingAccounts: Bool {
        auth.hasPendingAccountMerge
            || auth.accountMergeState == .pending
            || pendingRecoveredMergeResult != nil
    }

    var body: some View {
        // The restored account cache is activated immediately at launch (see
        // init above) so cached data stays visible while validation runs;
        // `blocksForAccountMerge` disables the shell until validation and any
        // pending merge resolve.
        MainTabView()
            .disabled(blocksForAccountMerge)
            // An .overlay rather than a ZStack sibling so the fade's .animation stays
            // off MainTabView, which would otherwise animate its own layout on the swap.
            .overlay {
                ZStack {
                    if blocksForAccountMerge {
                        AccountMergeRecoveryView(
                            refreshFailed: accountMergeRefreshFailed,
                            isRetrying: accountMergeRefreshInProgress,
                            isMergingAccounts: isMergingAccounts
                        ) {
                            guard let accountID = auth.userId else { return }
                            Task { await recoverPendingAccountMerge(accountID: accountID) }
                        }
                        .transition(.asymmetric(
                            insertion: .opacity.animation(.smooth(duration: 0.4)),
                            removal: .opacity.animation(.smooth(duration: 0.3))
                        ))
                    }
                }
                .animation(.smooth, value: blocksForAccountMerge)
            }
            .background(Color.pageBg.ignoresSafeArea())
            .onChange(of: auth.identity) { _, identity in
                if identity == .none {
                    accountMergeRefreshInProgress = false
                    accountMergeRefreshAccountID = nil
                    accountMergeRefreshAttemptID = nil
                    accountMergeRefreshFailed = false
                    pendingRecoveredMergeResult = nil
                    pendingRecoveredMergeAccountID = nil
                    store.clearActiveAccount()
                    if let accountID = auth.consumeDiscardedAccountID() {
                        store.clearCachedAccount(accountID: accountID)
                    }
                }
            }
            .onChange(of: auth.userId) { _, accountID in
                if pendingRecoveredMergeAccountID != accountID {
                    pendingRecoveredMergeResult = nil
                    pendingRecoveredMergeAccountID = nil
                }
                if let refreshAccountID = accountMergeRefreshAccountID,
                   refreshAccountID != accountID {
                    clearAccountMergeRefresh(accountID: refreshAccountID)
                }
                guard auth.hasSession, !blocksForAccountMerge, let accountID else { return }
                store.activate(accountID: accountID)
                Task { try? await store.ensureLoaded() }
            }
            .onChange(of: auth.accountMergeState) { previousState, state in
                guard state == .none,
                      !accountMergeRefreshInProgress,
                      auth.isRegisteredAccount,
                      let accountID = auth.userId
                else { return }
                store.activate(accountID: accountID)
                if previousState == .finalizing {
                    if let result = auth.consumeCompletedAccountMergeResult() {
                        if !result.promoted {
                            rememberRecoveredMerge(result, accountID: accountID)
                        }
                    }
                    let refreshAttemptID = beginAccountMergeRefresh(accountID: accountID)
                    Task {
                        await store.loadAll()
                        guard ownsAccountMergeRefresh(
                            accountID: accountID,
                            attemptID: refreshAttemptID
                        ), auth.userId == accountID,
                           store.activeAccountID == accountID
                        else {
                            return
                        }
                        let refreshFailed = !store.hasLoadedAll || store.refreshFailed
                        if !refreshFailed {
                            showRecoveredMergeToast(accountID: accountID)
                        }
                        finishAccountMergeRefresh(
                            accountID: accountID,
                            attemptID: refreshAttemptID,
                            failed: refreshFailed
                        )
                    }
                } else {
                    Task { try? await store.ensureLoaded() }
                }
            }
            .onChange(of: scenePhase) { _, phase in
                guard phase == .active, auth.hasSession else { return }
                Task { await auth.validateSession(force: false) }
            }
            .task {
                #if DEBUG
                if UITestDataService.Mode(arguments: ProcessInfo.processInfo.arguments) != nil {
                    return
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
                        store.activate(accountID: accountID)
                        if auth.isRegisteredAccount {
                            if auth.hasPendingAccountMergeForCurrentAccount {
                                await recoverPendingAccountMerge(accountID: accountID)
                            } else {
                                async let initialLoad: Void = store.loadAll()
                                let outcome = await auth.resumePendingAccountMerge(reportsProgress: false)
                                guard auth.userId == accountID,
                                      store.activeAccountID == accountID
                                else { return }
                                if case .completed(let result) = outcome {
                                    _ = auth.consumeCompletedAccountMergeResult()
                                    if !result.promoted {
                                        rememberRecoveredMerge(result, accountID: accountID)
                                    }
                                    let refreshAttemptID = beginAccountMergeRefresh(accountID: accountID)
                                    await initialLoad
                                    guard ownsAccountMergeRefresh(
                                        accountID: accountID,
                                        attemptID: refreshAttemptID
                                    ) else { return }
                                    await store.loadAll()
                                    guard ownsAccountMergeRefresh(
                                        accountID: accountID,
                                        attemptID: refreshAttemptID
                                    ), auth.userId == accountID,
                                       store.activeAccountID == accountID
                                    else { return }
                                    let refreshFailed = !store.hasLoadedAll || store.refreshFailed
                                    if !refreshFailed {
                                        showRecoveredMergeToast(accountID: accountID)
                                    }
                                    finishAccountMergeRefresh(
                                        accountID: accountID,
                                        attemptID: refreshAttemptID,
                                        failed: refreshFailed
                                    )
                                } else {
                                    await initialLoad
                                }
                            }
                        } else {
                            try? await store.ensureLoaded()
                        }
                    }
                }
            }
    }

    private func rememberRecoveredMerge(_ result: AccountMergeResult, accountID: String) {
        pendingRecoveredMergeResult = result
        pendingRecoveredMergeAccountID = accountID
    }

    private func beginAccountMergeRefresh(accountID: String) -> UUID {
        let attemptID = UUID()
        accountMergeRefreshAccountID = accountID
        accountMergeRefreshAttemptID = attemptID
        accountMergeRefreshInProgress = true
        accountMergeRefreshFailed = false
        return attemptID
    }

    private func ownsAccountMergeRefresh(accountID: String, attemptID: UUID) -> Bool {
        accountMergeRefreshAccountID == accountID && accountMergeRefreshAttemptID == attemptID
    }

    private func finishAccountMergeRefresh(accountID: String, attemptID: UUID, failed: Bool) {
        guard ownsAccountMergeRefresh(accountID: accountID, attemptID: attemptID) else { return }
        accountMergeRefreshInProgress = false
        accountMergeRefreshFailed = failed
        if !failed {
            accountMergeRefreshAccountID = nil
            accountMergeRefreshAttemptID = nil
        }
    }

    private func clearAccountMergeRefresh(accountID: String) {
        guard accountMergeRefreshAccountID == accountID else { return }
        accountMergeRefreshInProgress = false
        accountMergeRefreshFailed = false
        accountMergeRefreshAccountID = nil
        accountMergeRefreshAttemptID = nil
    }

    private func showRecoveredMergeToast(accountID: String) {
        guard pendingRecoveredMergeAccountID == accountID,
              let result = pendingRecoveredMergeResult
        else { return }
        pendingRecoveredMergeResult = nil
        pendingRecoveredMergeAccountID = nil
        toasts.show(SignInView.successMessage(fallback: "Signed in", mergeResult: result))
    }

    private func recoverPendingAccountMerge(accountID: String) async {
        let refreshAttemptID = beginAccountMergeRefresh(accountID: accountID)
        let outcome = await auth.resumePendingAccountMerge(reportsProgress: false)
        guard auth.userId == accountID else {
            clearAccountMergeRefresh(accountID: accountID)
            return
        }
        if outcome != .failed {
            if case .completed(let result) = outcome {
                _ = auth.consumeCompletedAccountMergeResult()
                if !result.promoted {
                    rememberRecoveredMerge(result, accountID: accountID)
                }
            }
            store.activate(accountID: accountID)
            await store.loadAll()
            guard ownsAccountMergeRefresh(accountID: accountID, attemptID: refreshAttemptID),
                  auth.userId == accountID,
                  store.activeAccountID == accountID
            else { return }
            let refreshFailed = !store.hasLoadedAll || store.refreshFailed
            if !refreshFailed {
                showRecoveredMergeToast(accountID: accountID)
            }
            finishAccountMergeRefresh(
                accountID: accountID,
                attemptID: refreshAttemptID,
                failed: refreshFailed
            )
        } else {
            finishAccountMergeRefresh(
                accountID: accountID,
                attemptID: refreshAttemptID,
                failed: false
            )
        }
    }
}

private struct AccountMergeRecoveryView: View {
    @Environment(AuthService.self) private var auth
    let refreshFailed: Bool
    let isRetrying: Bool
    let isMergingAccounts: Bool
    let onRetry: () -> Void

    private var hasFailed: Bool {
        !isRetrying && (auth.accountMergeState == .failed || refreshFailed)
    }

    var body: some View {
        Group {
            if hasFailed {
                ZStack {
                    Rectangle()
                        .fill(.ultraThinMaterial)
                        .ignoresSafeArea()
                    failureCard
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                AppLoadingOverlay(
                    status: isMergingAccounts ? "Moving your sightings to this account" : "Signing you in"
                )
            }
        }
        .animation(.smooth, value: hasFailed)
        .accessibilityIdentifier("accountMerge.recovery")
    }

    private var failureCard: some View {
        VStack(spacing: 16) {
            ContentUnavailableView {
                Label(isMergingAccounts ? "Sightings not moved yet" : "Couldn't finish signing in",
                      systemImage: "exclamationmark.triangle")
            } description: {
                Text(accountMergeRecoveryMessage(
                    refreshFailed: refreshFailed,
                    isMergingAccounts: isMergingAccounts
                ))
            }

            VStack(spacing: 10) {
                Button("Retry", action: onRetry)
                    .buttonStyle(.glassProminent)
                    .buttonSizing(.flexible)
                Button("Sign out") {
                    Task { await auth.signOut() }
                }
                .buttonStyle(.glass)
                .buttonSizing(.flexible)
            }
        }
        .padding(28)
        .frame(maxWidth: 360)
    }
}

func accountMergeRecoveryMessage(refreshFailed: Bool, isMergingAccounts: Bool) -> String {
    guard isMergingAccounts else {
        return refreshFailed
            ? "WingDex couldn't reload your account. Retry to refresh it."
            : "WingDex couldn't finish signing you in. Retry to continue."
    }
    return refreshFailed
        ? "Your sightings were added, but WingDex couldn't reload them. Retry to refresh this account."
        : "Your original sightings are safe. Retry to finish adding them to this account."
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
    @State private var incomingShareImportInFlight = false
    @State private var incomingShareImportRequested = false
    @State private var incomingShareImportDeferred = false
    @State private var incomingShareImportTask: Task<Void, Never>?
    @State private var incomingShareImportTaskID: UUID?
    #if DEBUG
    private let uiTestForcesSettings = ProcessInfo.processInfo.arguments.contains("--ui-test-open-settings")
    private let uiTestIgnoresPendingShare = ProcessInfo.processInfo.arguments.contains("--ui-test-ignore-shares")
    private let uiTestObservesShareQueue = ProcessInfo.processInfo.arguments.contains("--ui-test-observe-share-queue")
    @State private var uiTestDataSetupIdentifier = "ui-test.dataSetupPending"
    @State private var uiTestGeocodingCancellationAcknowledged = false
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
        .accessibilityValue(
            uiTestGeocodingCancellationAcknowledged
                ? "geocodingCancellationAcknowledged"
                : ""
        )
        #endif
        .onChange(of: addPhotosVM.currentStep) {
            if addPhotosVM.currentStep != .selectPhotos {
                showingWizard = true
            }
        }
        .fullScreenCover(isPresented: $showingWizard, onDismiss: {
            let shouldContinueShareQueue = addPhotosVM.continuesShareQueueAfterDismissal
            let explicitlyStoppedShareQueue = addPhotosVM.stoppedShareQueueAfterDismissal
            let shouldPrompt = auth.identity == .anonymous
                && addPhotosVM.savedOutingCount > 0
                && auth.userId.map { !SignupPromptStore.hasPrompted(userID: $0) } == true
            incomingShareImportTask?.cancel()
            incomingShareImportTask = nil
            incomingShareImportTaskID = nil
            addPhotosVM.cancelSession()
            addPhotosVM = AddPhotosViewModel()
            addPhotosVM.configure(
                auth: auth,
                dataStore: store
            )
            if explicitlyStoppedShareQueue {
                incomingShareImportDeferred = false
            } else if shouldPrompt {
                incomingShareImportDeferred = shouldContinueShareQueue || incomingShareImportDeferred
            } else if shouldContinueShareQueue || incomingShareImportDeferred {
                incomingShareImportDeferred = false
                scheduleIncomingShareImport()
            }
            if shouldPrompt {
                if let userID = auth.userId { SignupPromptStore.markPrompted(userID: userID) }
                showingAccount = true
            }
        }) {
            NavigationStack {
                AddPhotosFlow(
                    viewModel: addPhotosVM,
                    onReverseGeocodingCancellationAcknowledged: acknowledgeReverseGeocodingCancellation
                )
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
        .onChange(of: showingAccount) { _, isShowing in
            if !isShowing, incomingShareImportDeferred {
                incomingShareImportDeferred = false
                scheduleIncomingShareImport()
            }
        }
        .task {
            navigation.setMainInterfaceReady(true)
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--ui-test-reset-signup-prompt") {
                SignupPromptStore.reset()
            }
            #endif
            async let taxonomyWarmup: Void = prewarmTaxonomyLookups()
            // Rows resolve their mark synchronously, so pay the 2 MiB read here
            // rather than on the first scroll.
            RarityStore.shared.warmUp()
            #if DEBUG
            let arguments = ProcessInfo.processInfo.arguments
            do {
                if arguments.contains("--ui-test-reset-share-store") {
                    try await IncomingShareStore.resetForUITests()
                }
                try await prepareUITestData(arguments: arguments)
                if arguments.contains("--ui-test-stage-share") {
                    try await stageUITestSharePhoto()
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
            scheduleIncomingShareImport()
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--ui-test-stage-share-after-launch") {
                Task { @MainActor in
                    try? await Task.sleep(for: .seconds(1))
                    try? await stageUITestSharePhoto()
                    navigation.handleIncomingShare()
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
            Task { await addPhotosVM.processSelectedPhotos() }
        }
        .onChange(of: auth.userId) {
            addPhotosVM.configure(auth: auth, dataStore: store)
        }
        .onChange(of: scenePhase) { _, phase in
            guard !uiTestIgnoresPendingShare,
                  phase == .active
            else { return }
            scheduleIncomingShareImport()
        }
        .onDisappear {
            navigation.setMainInterfaceReady(false)
            incomingShareImportTask?.cancel()
            incomingShareImportTask = nil
            incomingShareImportTaskID = nil
            addPhotosVM.cancelSession()
        }
        .onChange(of: navigation.incomingShareRequestID) {
            scheduleIncomingShareImport()
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

    private func acknowledgeReverseGeocodingCancellation() {
        #if DEBUG
        guard ProcessInfo.processInfo.arguments.contains("--ui-test-geocoding-delay") else { return }
        uiTestGeocodingCancellationAcknowledged = true
        #endif
    }

    #if DEBUG
    private func prepareUITestData(arguments: [String]) async throws {
        let fixtureMode = UITestDataService.Mode(arguments: arguments)
        let needsAccount = arguments.contains("--ui-test-clear-data")
            || arguments.contains("--ui-test-seed-csv")
            || arguments.contains("--ui-test-open-settings")
            || fixtureMode != nil
        guard needsAccount else { return }

        if fixtureMode != nil {
            store.activate(accountID: "ui-test-account")
            try await store.ensureLoaded()
            return
        }

        var lastError: Error = AuthError.notAuthenticated
        for attempt in 1...3 {
            var stage = "anonymous session"
            do {
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
                    // Coordinates matter: rarity is keyed by cell and month, so an
                    // outing without them renders no rarity mark at all. This
                    // fixture had none, which quietly made every seeded screen
                    // untestable for that feature.
                    _ = try await service.createOuting(Outing(
                        id: outingID,
                        userId: accountID,
                        startTime: "2026-02-12T06:58:00-03:00",
                        endTime: "2026-02-12T07:58:00-03:00",
                        locationName: "Parque Ibirapuera, Sao Paulo",
                        lat: -23.5875,
                        lon: -46.6575,
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

                    // A second outing whose four species land on all four rarity
                    // verdicts, so every state is reachable from one launch. The
                    // expectations are locked by ml/distill/verify_rarity_blob.py
                    // against the shipped asset; change one and that check fails.
                    stage = "seed rarity outing write"
                    let rarityOutingID = "ui-test-seeded-rarity-outing-\(accountID)"
                    _ = try await service.createOuting(Outing(
                        id: rarityOutingID,
                        userId: accountID,
                        startTime: "2026-01-18T08:30:00-08:00",
                        endTime: "2026-01-18T10:30:00-08:00",
                        locationName: "Carkeek Park, Seattle",
                        lat: 47.61,
                        lon: -122.33,
                        notes: "UI test seed, rarity states",
                        createdAt: "2026-01-18T08:30:00-08:00"
                    ))
                    stage = "seed rarity observation write"
                    let rarities: [(String, String)] = [
                        ("robin", "American Robin (Turdus migratorius)"),
                        ("rufous", "Rufous Hummingbird (Selasphorus rufus)"),
                        ("tundra-swan", "Tundra Swan (Cygnus columbianus)"),
                        ("cardinal", "Northern Cardinal (Cardinalis cardinalis)"),
                    ]
                    _ = try await service.createObservations(rarities.map { slug, name in
                        BirdObservation(
                            id: "ui-test-\(slug)-\(accountID)",
                            outingId: rarityOutingID,
                            speciesName: name,
                            count: 1,
                            certainty: .confirmed,
                            notes: ""
                        )
                    })
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

    private func requestIncomingShareImport() async -> Bool {
        guard !uiTestIgnoresPendingShare else { return false }
        guard !incomingShareImportInFlight else {
            incomingShareImportRequested = true
            return false
        }
        incomingShareImportInFlight = true
        defer { incomingShareImportInFlight = false }
        var queueRemainedEmpty = true
        repeat {
            incomingShareImportRequested = false
            addPhotosVM.configure(
                auth: auth,
                dataStore: store
            )
            let result = await addPhotosVM.importIncomingShareIfAvailable()
            guard !Task.isCancelled else { return false }
            queueRemainedEmpty = queueRemainedEmpty && result == .empty
            if result == .accepted {
                navigation.route(to: .addPhotos())
            } else if result == .failed {
                navigation.route(to: .addPhotos())
                showingWizard = true
            } else if result == .busy {
                incomingShareImportDeferred = true
            }
        } while incomingShareImportRequested
        return queueRemainedEmpty
    }

    private func scheduleIncomingShareImport() {
        #if DEBUG
        if uiTestObservesShareQueue {
            uiTestDataSetupIdentifier = "ui-test.shareQueuePending"
        }
        #endif
        if showingAccount {
            incomingShareImportDeferred = true
            return
        }
        if incomingShareImportTask != nil {
            incomingShareImportRequested = true
            return
        }
        let requestID = UUID()
        incomingShareImportTaskID = requestID
        incomingShareImportTask = Task {
            let queueIsEmpty = await requestIncomingShareImport()
            #if DEBUG
            if uiTestObservesShareQueue && queueIsEmpty && !Task.isCancelled {
                uiTestDataSetupIdentifier = "ui-test.shareQueueChecked"
            }
            #endif
            if incomingShareImportTaskID == requestID {
                incomingShareImportTask = nil
                incomingShareImportTaskID = nil
            }
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
        .environment(ToastCenter())
}

#Preview("App - Signed Out") {
    ContentView()
        .environment(AuthService())
        .environment(previewStore(empty: true))
        .environment(AppNavigationModel())
        .environment(ToastCenter())
}
#endif
