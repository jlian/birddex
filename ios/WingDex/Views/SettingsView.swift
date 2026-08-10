import SwiftUI

/// Local profile state that is decoupled from the global AuthService observable.
/// This prevents mutations here from triggering MainTabView re-renders (which
/// would reset the sheet). Changes sync back to AuthService on dismiss.
@MainActor @Observable
final class ProfileEditor {
    var name: String
    var image: String
    private let auth: AuthService
    private let userId: String?
    private var pendingTask: Task<Void, Never>?

    /// Original social provider avatar, captured once for restore-on-deselect.
    let originalSocialImage: String

    init(auth: AuthService) {
        self.auth = auth
        self.userId = auth.userId
        self.name = auth.userName ?? ""
        self.image = auth.userImage ?? ""
        self.originalSocialImage = {
            let img = auth.userImage ?? ""
            return img.hasPrefix("data:image/svg+xml") ? "" : img
        }()
    }

    var saveError: AppError?

    func save(name: String, image: String) {
        pendingTask?.cancel()
        self.name = name
        self.image = image
        saveError = nil
        pendingTask = Task { @MainActor in
            do {
                try await auth.updateProfile(name: name, image: image)
            } catch {
                saveError = AppError.map(error, fallback: "Could not save your profile. Try again.")
            }
        }
    }

    /// Push final state back to auth so the rest of the app sees it.
    func syncToAuth() {
        guard auth.userId == userId else { return }
        auth.userName = name
        auth.userImage = image
    }

    func isEmojiSelected(_ emoji: String) -> Bool {
        guard image.hasPrefix("data:image/svg+xml") else { return false }
        return (image.removingPercentEncoding ?? image).contains(emoji)
    }
}

struct SettingsView: View {
    @Environment(AuthService.self) private var auth
    @Environment(DataStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var editor: ProfileEditor?

    // Other state
    @State private var isLoadingDemo = false
    @State private var demoError: AppError?
    @State private var showingDemoConfirmation = false
    @State private var showingEBirdImport = false
    @State private var isExporting = false
    @State private var exportError: AppError?
    @State private var exportItem: ExportFileItem?
    @FocusState private var isNameFieldFocused: Bool
    @State private var editedName = ""
    @State private var celebration: LiferCelebration?

    private var profile: ProfileEditor { editor! }

    var body: some View {
        NavigationStack {
            if editor != nil {
                formContent
            }
        }
        .onAppear {
            if editor == nil {
                editor = ProfileEditor(auth: auth)
            }
        }
        .onDisappear {
            editor?.syncToAuth()
        }
        .celebration($celebration)
    }

    private var formContent: some View {
        Form {
            accountSection
            avatarSection

            if let saveError = profile.saveError {
                Section {
                    Text(saveError.message)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }

            importExportSection
            securitySection
            birdIdSection
            privacySection
            dataManagementSection

            #if DEBUG
            developmentSection
            #endif

            logOutSection

            // Version info
            Section {
                let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
                HStack {
                    Spacer()
                    VStack(spacing: 2) {
                        Text("WingDex v\(version)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        #if DEBUG
                        Text("\(GitInfo.branch)@\(GitInfo.commit)")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                        #endif
                    }
                    Spacer()
                }
            }
            .listRowBackground(Color.clear)
        }
        .scrollContentBackground(.hidden)
        .background(Color.pageBg.ignoresSafeArea())
        .navigationTitle("Settings")
        .toolbarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Done", systemImage: "xmark") {
                    dismiss()
                }
            }
        }
        .sheet(isPresented: $showingEBirdImport) {
            EBirdImportView(auth: auth) { newSpeciesCount, newSpeciesNames in
                guard newSpeciesCount > 0 else { return }
                celebration = LiferCelebration(
                    newSpeciesCount: newSpeciesCount,
                    speciesNames: newSpeciesNames
                )
            }
        }
        .sheet(item: $exportItem) { item in
            ActivityView(item: item)
        }
    }

    // MARK: - Account

    @ViewBuilder
    private var accountSection: some View {
        Section("Account") {
            if !profile.name.isEmpty {
                LabeledContent("Display Name") {
                    TextField("Display Name", text: $editedName)
                        .multilineTextAlignment(.trailing)
                        .textInputAutocapitalization(.words)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .focused($isNameFieldFocused)
                        .onSubmit { commitEditedName() }
                        .accessibilityIdentifier("settings.displayName")
                }

                Button {
                    let newName = FunNames.generateBirdName()
                    let emoji = FunNames.emojiForBirdName(newName)
                    editedName = newName
                    profile.save(name: newName, image: FunNames.emojiAvatarDataUrl(emoji))
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "shuffle")
                        Text("Shuffle Name")
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            } else {
                Label("Guest Account", systemImage: "person.crop.circle.badge.questionmark")
                    .foregroundStyle(.secondary)
            }
        }
        .onChange(of: profile.name, initial: true) { _, name in
            guard !isNameFieldFocused else { return }
            editedName = name
        }
        .onChange(of: isNameFieldFocused) { wasFocused, isFocused in
            if wasFocused && !isFocused { commitEditedName() }
        }
    }

    private func commitEditedName() {
        let trimmed = editedName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            editedName = profile.name
            return
        }
        guard trimmed != profile.name else { return }
        profile.save(name: trimmed, image: profile.image)
    }

    // MARK: - Avatar

    @ViewBuilder
    private var avatarSection: some View {
        if !profile.name.isEmpty {
            Section("Avatar") {
                ScrollView(.horizontal) {
                    HStack(spacing: 2) {
                        ForEach(FunNames.emojiOptions, id: \.self) { emoji in
                            let isSelected = profile.isEmojiSelected(emoji)
                            Button {
                                if isSelected {
                                    profile.save(name: profile.name, image: profile.originalSocialImage)
                                } else {
                                    profile.save(name: profile.name, image: FunNames.emojiAvatarDataUrl(emoji))
                                }
                            } label: {
                                Text(verbatim: emoji)
                                    .font(.title2)
                                    .frame(width: 44, height: 44)
                                    .background(isSelected ? Color.accentColor.opacity(0.15) : Color.clear)
                                    .clipShape(RoundedRectangle(cornerRadius: 8))
                                    .overlay(
                                        isSelected
                                            ? RoundedRectangle(cornerRadius: 8).stroke(Color.accentColor, lineWidth: 2)
                                            : nil
                                    )
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Use \(emoji) avatar")
                            .accessibilityAddTraits(isSelected ? .isSelected : [])
                        }
                    }
                }
                .scrollIndicators(.hidden)
                .animation(.none, value: profile.image)
            }
        }
    }

    // MARK: - Import & Export

    @ViewBuilder
    private var importExportSection: some View {
        Section("Import & Export") {
            Button {
                showingEBirdImport = true
            } label: {
                Label("Import eBird CSV", systemImage: "square.and.arrow.down")
            }

            Button {
                Task { await exportSightings() }
            } label: {
                if isExporting {
                    HStack {
                        ProgressView()
                            .controlSize(.mini)
                        Text("Exporting...")
                    }
                } else {
                    Label("Export Sightings CSV", systemImage: "square.and.arrow.up")
                }
            }
            .disabled(store.dex.isEmpty || isExporting)

            if let exportError {
                Text(exportError.message)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }

    // MARK: - Security

    @ViewBuilder
    private var securitySection: some View {
        Section("Security") {
            NavigationLink("Manage Passkeys") {
                PasskeyManagementView()
            }
        }
    }

    // MARK: - Bird Identification

    @ViewBuilder
    private var birdIdSection: some View {
        Section {
            Toggle(isOn: Binding(
                get: { UserDefaults.standard.object(forKey: "useGeoContext") as? Bool ?? true },
                set: { UserDefaults.standard.set($0, forKey: "useGeoContext") }
            )) {
                Text("Use Location and Time")
            }
        } header: {
            Text("Bird Identification")
        } footer: {
            Text("Improves identification using photo location and month. Rounded coordinates may be sent to Geoapify to suggest outing names.")
                .font(.footnote)
                .foregroundStyle(Color.mutedText)
        }
    }

    // MARK: - Legal

    @ViewBuilder
    private var privacySection: some View {
        Section("Legal") {
            Link(destination: URL(string: "\(Config.apiBaseURL.absoluteString)/privacy.html")!) {
                Label("Privacy Policy", systemImage: "hand.raised")
            }
            Link(destination: URL(string: "\(Config.apiBaseURL.absoluteString)/terms.html")!) {
                Label("Terms of Use", systemImage: "doc.text")
            }
        }
    }

    // MARK: - Data Management

    @ViewBuilder
    private var dataManagementSection: some View {
        Section("Data Management") {
            NavigationLink {
                DataManagementView()
            } label: {
                Label("Delete Data...", systemImage: "trash")
                    .foregroundStyle(.red)
            }
        }
    }

    // MARK: - Development (DEBUG only)

    #if DEBUG
    @ViewBuilder
    private var developmentSection: some View {
        Section("Development") {
            Button {
                showingDemoConfirmation = true
            } label: {
                if isLoadingDemo {
                    ProgressView()
                } else {
                    Label("Load Demo Data", systemImage: "sparkles")
                }
            }
            .disabled(isLoadingDemo)

            if let demoError {
                Text(demoError.message)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .alert(
            "Load Demo Data?",
            isPresented: $showingDemoConfirmation
        ) {
            Button("Cancel", role: .cancel) {}
            Button("Replace All Data", role: .destructive) {
                isLoadingDemo = true
                demoError = nil
                Task {
                    do {
                        try await store.loadDemoData()
                    } catch {
                        demoError = AppError.map(error, fallback: "Could not load demo data. Try again.")
                    }
                    isLoadingDemo = false
                }
            }
        } message: {
            Text("This will replace all your current outings, observations, and WingDex entries with demo data. This cannot be undone.")
        }
    }
    #endif

    // MARK: - Log Out

    @ViewBuilder
    private var logOutSection: some View {
        Section {
            Button("Log Out", role: .destructive) {
                auth.signOut()
            }
        }
    }

    // MARK: - Actions

    private func exportSightings() async {
        isExporting = true
        exportError = nil
        do {
            let service = DataService(auth: auth)
            let csvData = try await service.exportSightingsCSV()
            exportItem = try ExportFileFactory.sightings(data: csvData)
        } catch {
            exportError = AppError.map(error, fallback: "Could not export sightings. Try again.")
        }
        isExporting = false
    }
}

#if DEBUG
#Preview {
    SettingsView()
        .environment(AuthService())
        .environment(previewStore())
}
#endif
