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
    @Environment(ToastCenter.self) private var toasts
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    @State private var editor: ProfileEditor?

    // Other state
    @State private var showingEBirdImport = false
    @State private var isExporting = false
    @State private var exportError: AppError?
    @State private var exportItem: ExportFileItem?
    @FocusState private var isNameFieldFocused: Bool
    @State private var editedName = ""
    @State private var celebration: LiferCelebration?
    @Namespace private var displayNameAccessibilityPair

    private var profile: ProfileEditor { editor! }

    private var showsAvatarOptions: Bool {
        #if DEBUG
        !ProcessInfo.processInfo.arguments.contains("--ui-test-hide-avatar-options")
        #else
        true
        #endif
    }

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

            logOutSection

            // Version info
            Section {
                let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
                let releaseURL = URL(string: "https://github.com/jlian/wingdex/releases/tag/ios-v\(version)")!
                HStack {
                    Spacer()
                    VStack(spacing: 6) {
                        HStack(spacing: 8) {
                            Link("WingDex™ \(version)", destination: releaseURL)
                            .accessibilityIdentifier("settings.versionLink")
                            Text("·")
                                .foregroundStyle(.tertiary)
                                .accessibilityHidden(true)
                            Link("By John Lian", destination: URL(string: "https://johnlian.net")!)
                                .accessibilityIdentifier("settings.authorLink")
                        }
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
            EBirdImportView(auth: auth) { response, newSpeciesNames in
                if response.imported.newSpecies > 0 {
                    celebration = LiferCelebration(
                        newSpeciesCount: response.imported.newSpecies,
                        speciesNames: newSpeciesNames,
                        messageOverride: response.userMessage
                    )
                } else {
                    toasts.show(response.userMessage)
                }
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
                displayNameRow

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
        .headerProminence(.increased)
        .onChange(of: profile.name, initial: true) { _, name in
            guard !isNameFieldFocused else { return }
            editedName = name
        }
        .onChange(of: isNameFieldFocused) { wasFocused, isFocused in
            if wasFocused && !isFocused { commitEditedName() }
        }
    }

    private var displayNameRow: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(spacing: 8))
        return layout {
            Text("Display Name")
                .font(.body)
                .accessibilityLabeledPair(
                    role: .label,
                    id: "displayName",
                    in: displayNameAccessibilityPair
                )
            displayNameField
                .multilineTextAlignment(dynamicTypeSize.isAccessibilitySize ? .leading : .trailing)
                .frame(maxWidth: .infinity)
                .accessibilityLabeledPair(
                    role: .content,
                    id: "displayName",
                    in: displayNameAccessibilityPair
                )
        }
    }

    private var displayNameField: some View {
        TextField("Display Name", text: $editedName)
            .textInputAutocapitalization(.words)
            .autocorrectionDisabled()
            .submitLabel(.done)
            .focused($isNameFieldFocused)
            .onSubmit { commitEditedName() }
            .accessibilityIdentifier("settings.displayName")
    }

    private func commitEditedName() {
        let trimmed = editedName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            editedName = profile.name
            return
        }
        // The field keeps whatever was typed, so mirror the stored value back into it.
        editedName = trimmed
        guard trimmed != profile.name else { return }
        profile.save(name: trimmed, image: profile.image)
    }

    // MARK: - Avatar

    @ViewBuilder
    private var avatarSection: some View {
        if !profile.name.isEmpty && showsAvatarOptions {
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
            .headerProminence(.increased)
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
        .headerProminence(.increased)
    }

    // MARK: - Security

    @ViewBuilder
    private var securitySection: some View {
        Section("Security") {
            NavigationLink("Manage Passkeys") {
                PasskeyManagementView()
            }
        }
        .headerProminence(.increased)
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
                .font(.headline)
                .foregroundStyle(Color.foregroundText)
        } footer: {
            Text("Improves identification using photo location and month. Outing name suggestions are looked up on WingDex servers, not sent to a third party.")
                .font(.footnote)
                .foregroundStyle(Color.mutedText)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("settings.birdIdFooter")
        }
            .headerProminence(.increased)
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
        .headerProminence(.increased)
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
        .headerProminence(.increased)
    }

    // MARK: - Log Out

    @ViewBuilder
    private var logOutSection: some View {
        Section {
            Button("Log Out", role: .destructive) {
                Task {
                    await auth.signOut()
                    toasts.show("Logged out")
                }
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
            toasts.show("Sightings CSV exported")
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
        .environment(ToastCenter())
}
#endif
