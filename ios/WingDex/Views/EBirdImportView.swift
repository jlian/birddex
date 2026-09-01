import SwiftUI
import UniformTypeIdentifiers
import os

private let log = Logger(subsystem: Config.bundleID, category: "EBirdImport")

/// eBird CSV import flow with timezone picker and export help.
struct EBirdImportView: View {
    let auth: AuthService
    /// Called after a successful import with the complete summary and new display names.
    var onImported: ((DataService.ImportResponse, [String]) -> Void)? = nil
    @Environment(DataStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    // MARK: - Timezone Presets

    private static let timezonePresets: [(value: String, region: String)] = [
        ("Pacific/Honolulu", "Hawaii"),
        ("America/Anchorage", "Alaska"),
        ("America/Los_Angeles", "Pacific"),
        ("America/Denver", "Mountain"),
        ("America/Chicago", "Central"),
        ("America/New_York", "Eastern"),
        ("America/Puerto_Rico", "Atlantic"),
        ("America/Sao_Paulo", "Brazil"),
        ("America/Argentina/Buenos_Aires", "Argentina"),
        ("America/Bogota", "Colombia"),
        ("America/Mexico_City", "Mexico"),
        ("Europe/London", "London"),
        ("Europe/Paris", "Central Europe"),
        ("Europe/Helsinki", "Eastern Europe"),
        ("Europe/Moscow", "Moscow"),
        ("Africa/Nairobi", "East Africa"),
        ("Africa/Lagos", "West Africa"),
        ("Africa/Johannesburg", "South Africa"),
        ("Asia/Dubai", "Gulf"),
        ("Asia/Kolkata", "India"),
        ("Asia/Bangkok", "Southeast Asia"),
        ("Asia/Shanghai", "China"),
        ("Asia/Taipei", "Taipei"),
        ("Asia/Tokyo", "Japan"),
        ("Asia/Seoul", "Korea"),
        ("Australia/Perth", "Western Australia"),
        ("Australia/Sydney", "Eastern Australia"),
        ("Pacific/Auckland", "New Zealand"),
    ]

    // MARK: - State

    @State private var selectedTimezone: String = {
        let current = TimeZone.current.identifier
        let knownIds = EBirdImportView.timezonePresets.map(\.value)
        return knownIds.contains(current) ? current : "observation-local"
    }()
    @State private var showFilePicker = false
    @State private var showHelp = false
    @State private var isImporting = false
    @State private var importError: AppError?

    private var timezoneOptions: [(value: String, label: String)] {
        let now = Date()
        return Self.timezonePresets.map { preset in
            let tz = TimeZone(identifier: preset.value) ?? .current
            let seconds = tz.secondsFromGMT(for: now)
            let hours = seconds / 3600
            let minutes = abs(seconds % 3600) / 60
            let offset = minutes > 0
                ? String(format: "UTC%+03d:%02d", hours, minutes)
                : String(format: "UTC%+d", hours)
            return (value: preset.value, label: "\(offset) - \(preset.region)")
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                // Timezone picker
                Section {
                    Picker("eBird Profile Timezone", selection: $selectedTimezone) {
                        ForEach(timezoneOptions, id: \.value) { option in
                            Text(option.label).tag(option.value)
                        }
                        Divider()
                        Text("None (times already local)").tag("observation-local")
                    }
                } header: {
                    Text("Timezone")
                } footer: {
                    Text("eBird records times in the timezone of the device that submitted the checklist - typically your phone's home timezone. If you only bird locally, choose \"None\". Otherwise, select your home timezone so WingDex can convert times to each observation's local time.")
                }

                // Help section
                Section {
                    DisclosureGroup("How to Export from eBird", isExpanded: $showHelp) {
                        VStack(alignment: .leading, spacing: 12) {
                            step(1, "Go to ebird.org/downloadMyData and sign in")
                            step(2, "Click Submit to request your data download")
                            step(3, "You will receive an email with a download link for your CSV file. Upload that file here.")
                            Text("WingDex will create outings grouped by date and location, with all your species as confirmed observations.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.top, 4)
                    }
                }

                // Import button
                Section {
                    Button {
                        showFilePicker = true
                    } label: {
                        Label("Choose CSV File", systemImage: "doc.badge.plus")
                    }
                    .disabled(isImporting)
                }

                // Import progress / error
                if isImporting {
                    Section {
                        HStack {
                            ProgressView()
                            Text("Importing...")
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                if let importError {
                    Section {
                        Text(importError.message)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }

            }
            .scrollContentBackground(.hidden)
            .background(Color.pageBg.ignoresSafeArea())
            .navigationTitle("Import eBird CSV")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .fileImporter(
                isPresented: $showFilePicker,
                allowedContentTypes: [UTType.commaSeparatedText, UTType.plainText],
                allowsMultipleSelection: false
            ) { result in
                Task { await handleFileSelection(result) }
            }
        }
    }

    // MARK: - Helpers

    @ViewBuilder
    private func step(_ number: Int, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text("\(number).")
                .fontWeight(.medium)
                .foregroundStyle(.primary)
            Text(text)
                .foregroundStyle(.secondary)
        }
        .font(.subheadline)
    }

    // MARK: - Import Logic

    private func handleFileSelection(_ result: Result<[URL], Error>) async {
        importError = nil

        switch result {
        case .failure(let error):
            importError = AppError.map(error, fallback: "Could not open the selected file.")
            return
        case .success(let urls):
            guard let fileURL = urls.first else { return }

            guard fileURL.startAccessingSecurityScopedResource() else {
                importError = .message("Cannot access the selected file.")
                return
            }
            defer { fileURL.stopAccessingSecurityScopedResource() }

            do {
                guard let accountID = store.activeAccountID, store.hasLoadedAll else {
                    throw AuthError.notAuthenticated
                }
                let csvData = try Data(contentsOf: fileURL)
                isImporting = true

                let service = DataService(auth: auth, expectedAccountID: accountID)
                let timezone = selectedTimezone == "observation-local" ? nil : selectedTimezone
                // Snapshot the dex keys, not the display names. A group's MIN
                // label can change when an import adds another spelling of an
                // existing coded species, so comparing names would report a new
                // species the server dex did not actually add. DexEntry.id is
                // the code-or-name key the server groups on.
                let priorSpecies = Set(store.dex.map(\.id))
                let imported = try await service.importEBirdCSV(csvData, profileTimezone: timezone)
                guard store.activeAccountID == accountID else { throw CancellationError() }

                await store.loadAll()
                guard store.activeAccountID == accountID else { throw CancellationError() }
                let newSpeciesNames = store.dex
                    .filter { !priorSpecies.contains($0.id) }
                    .map { $0.commonName ?? getDisplayName($0.speciesName) }

                log.info("Imported eBird data across \(imported.imported.outings) outings; skipped \(imported.skipped.rows) rows")
                onImported?(imported, newSpeciesNames)
                dismiss()
            } catch is CancellationError {
                isImporting = false
            } catch {
                importError = AppError.map(error, fallback: "Could not import this CSV. Check the file and try again.")
                isImporting = false
            }
        }
    }
}

#if DEBUG
#Preview {
    EBirdImportView(auth: AuthService())
        .environment(previewStore())
}
#endif
