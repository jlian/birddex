import SwiftUI
import MapKit

struct OutingDetailView: View {
    let outingId: String
    var beginsLocationEditing = false
    @Environment(AuthService.self) private var auth
    @Environment(DataStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var showDeleteConfirm = false
    @State private var editingNotes = false
    @State private var notesText = ""
    @State private var contextMenuSpecies: String?
    @State private var editingLocation = false
    @State private var locationText = ""
    @State private var showingAddSpecies = false
    @State private var speciesQuery = ""
    @State private var selectedSpecies: DataService.SpeciesSearchResult?
    @State private var speciesResults: [DataService.SpeciesSearchResult] = []
    @State private var speciesSearchTask: Task<Void, Never>?
    @State private var isSearchingSpecies = false
    @State private var isAddingSpecies = false
    @State private var exportItem: ExportFileItem?
    @State private var isExporting = false
    @State private var operationError: String?

    private var outing: Outing? { store.outing(id: outingId) }
    private var confirmed: [BirdObservation] { store.confirmedObservations(outingId) }
    private var possible: [BirdObservation] { store.possibleObservations(outingId) }

    var body: some View {
        VStack(spacing: 0) {
            CachedDataNotice()
            Group {
                if let outing {
                    outingContent(outing)
                } else {
                    ContentUnavailableView("Outing not found", systemImage: "exclamationmark.triangle")
                }
            }
        }
        .navigationTitle(outing?.locationName ?? "Outing")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let outing {
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: SharePayload.outing(outing, observations: confirmed)) {
                        Label("Share Outing", systemImage: "square.and.arrow.up")
                    }
                }
            }
        }
        // WHY: see SpeciesDetailView - hide system list background, apply our own.
        .scrollContentBackground(.hidden)
        .background(Color.pageBg.ignoresSafeArea())
        .alert("Delete this outing?", isPresented: $showDeleteConfirm) {
            Button("Cancel", role: .cancel) {}
            Button("Delete Outing", role: .destructive) {
                Task {
                    do {
                        try await store.deleteOuting(id: outingId)
                        dismiss()
                    } catch {
                        showError(error, fallback: "Could not delete outing. Try again.")
                    }
                }
            }
        } message: {
            Text("This will permanently delete this outing and all its observations.")
        }
        .sheet(item: $exportItem) { item in
            ActivityView(item: item)
        }
        .alert("Could Not Complete Action", isPresented: operationErrorBinding) {
            Button("OK", role: .cancel) { operationError = nil }
        } message: {
            Text(operationError ?? "Something went wrong. Try again.")
        }
        .onDisappear {
            speciesSearchTask?.cancel()
        }
        .onChange(of: outing?.id, initial: true) {
            guard beginsLocationEditing, let outing, !editingLocation else { return }
            locationText = outing.locationName
            editingLocation = true
        }
    }

    @ViewBuilder
    private func outingContent(_ outing: Outing) -> some View {
        List {
            // Header + stats
            Section {
                headerSection(outing)
                statsSection(outing)
                mapSection(outing)
            }
            .listRowSeparator(.hidden)

            // Confirmed species
            confirmedListSection

            // Possible species
            possibleListSection

            // Notes
            Section {
                notesSection(outing)
            }
            .listRowSeparator(.hidden)

            // Actions
            Section {
                if auth.isRegisteredAccount {
                    Button {
                        Task { await exportOuting(outing) }
                    } label: {
                        if isExporting {
                            HStack {
                                ProgressView()
                                    .controlSize(.mini)
                                Text("Exporting...")
                            }
                        } else {
                            Label("Export eBird CSV", systemImage: "square.and.arrow.up")
                                .foregroundStyle(Color.accentColor)
                        }
                    }
                    .disabled(confirmed.isEmpty || isExporting)
                }

                Button(role: .destructive) {
                    showDeleteConfirm = true
                } label: {
                    Label("Delete Outing", systemImage: "trash")
                        .foregroundStyle(.red)
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .navigationDestination(for: String.self) { speciesName in
            SpeciesDetailView(speciesName: speciesName)
        }
        .navigationDestination(item: $contextMenuSpecies) { speciesName in
            SpeciesDetailView(speciesName: speciesName)
        }
    }

    // MARK: - Header

    private func headerSection(_ outing: Outing) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if editingLocation {
                TextField("Location name", text: $locationText)
                    .textFieldStyle(.roundedBorder)

                if !locationSuggestions.isEmpty {
                    ForEach(locationSuggestions, id: \.self) { suggestion in
                        Button {
                            locationText = suggestion
                        } label: {
                            Text(suggestion)
                                .font(.subheadline)
                                .foregroundStyle(.primary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                        }
                        .tint(.primary)
                    }
                }

                HStack {
                    Button("Cancel") {
                        editingLocation = false
                        locationText = outing.locationName
                    }
                    Spacer()
                    Button("Save") {
                        Task { await saveLocation(outing) }
                    }
                    .fontWeight(.semibold)
                }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(outing.locationName.isEmpty ? "Outing" : outing.locationName)
                        .font(.system(.title2, design: .serif, weight: .bold))
                        .foregroundStyle(Color.foregroundText)

                    Button {
                        locationText = outing.locationName
                        editingLocation = true
                    } label: {
                        Image(systemName: "pencil")
                    }
                    .accessibilityLabel("Edit location name")
                }
            }

            HStack(spacing: 4) {
                Image(systemName: "calendar")
                Text(DateFormatting.formatDate(outing.startTime, style: .medium))
                Text("\u{00B7}")
                Image(systemName: "clock")
                Text("\(DateFormatting.formatTime(outing.startTime))")
                if let dur = DateFormatting.duration(from: outing.startTime, to: outing.endTime) {
                    Text("(\(dur))")
                }
            }
            .font(.system(size: 13))
            .foregroundStyle(Color.mutedText)
        }
    }

    // MARK: - Stats

    private func statsSection(_ outing: Outing) -> some View {
        HStack(spacing: 0) {
            statCard(
                value: "\(Set(confirmed.map(\.speciesName)).count)",
                label: "Species",
                icon: "bird.fill"
            )
            Divider().frame(height: 40)
            statCard(
                value: "\(confirmed.count)",
                label: "Confirmed",
                icon: "checkmark.circle.fill"
            )
            Divider().frame(height: 40)
            statCard(
                value: "\(confirmed.reduce(0) { $0 + $1.count })",
                label: "Total",
                icon: "number"
            )
        }
        .padding(.vertical, 8)
        .background(Color.cardBg)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.warmBorder, lineWidth: 0.5))
    }

    private func statCard(value: String, label: String, icon: String) -> some View {
        VStack(spacing: 4) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(Color.mutedText)
            Text(value)
                .font(.system(.title3, design: .serif, weight: .bold))
                .monospacedDigit()
                .foregroundStyle(Color.accentColor)
            Text(label)
                .font(.caption2)
                .foregroundStyle(Color.mutedText)
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Map

    @ViewBuilder
    private func mapSection(_ outing: Outing) -> some View {
        if let lat = outing.lat, let lon = outing.lon {
            let coordinate = CLLocationCoordinate2D(latitude: lat, longitude: lon)
            Button {
                openInMaps(for: outing, coordinate: coordinate)
            } label: {
                Map(initialPosition: .camera(.init(centerCoordinate: coordinate, distance: 3000))) {
                    Marker(outing.locationName, coordinate: coordinate)
                }
                .allowsHitTesting(false)
                .frame(height: 160)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay(alignment: .topTrailing) {
                    Image(systemName: "arrow.up.right.square.fill")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.white)
                        .padding(8)
                        .background(.black.opacity(0.45), in: Circle())
                        .padding(10)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open outing in Apple Maps")
        }
    }

    private func openInMaps(for outing: Outing, coordinate: CLLocationCoordinate2D) {
        let location = CLLocation(latitude: coordinate.latitude, longitude: coordinate.longitude)
        let mapItem = MKMapItem(location: location, address: nil)
        mapItem.name = outing.locationName.isEmpty ? "Outing" : outing.locationName
        mapItem.openInMaps(launchOptions: [
            MKLaunchOptionsMapCenterKey: NSValue(mkCoordinate: coordinate),
            MKLaunchOptionsMapSpanKey: NSValue(mkCoordinateSpan: MKCoordinateSpan(latitudeDelta: 0.05, longitudeDelta: 0.05)),
        ])
    }

    // MARK: - Confirmed

    @ViewBuilder
    private var confirmedListSection: some View {
        let grouped = Dictionary(grouping: confirmed, by: \.speciesName)
            .sorted { $0.key.localizedCaseInsensitiveCompare($1.key) == .orderedAscending }

        Section {
            speciesSectionTitle(
                title: "Species (\(Set(confirmed.map(\.speciesName)).count))",
                showsAddAction: true
            )
            .listRowSeparator(.hidden)

            if showingAddSpecies {
                addSpeciesForm
            }

            if confirmed.isEmpty {
                Text("No confirmed observations")
                    .font(.system(size: 14))
                    .foregroundStyle(Color.mutedText)
            } else {
                ForEach(grouped, id: \.key) { speciesName, obs in
                    let totalCount = obs.reduce(0) { $0 + $1.count }
                    let entry = store.dexEntry(for: speciesName)
                    NavigationLink(value: speciesName) {
                        BirdRow(
                            speciesName: speciesName,
                            thumbnailUrl: entry?.thumbnailUrl,
                            count: totalCount
                        )
                    }
                    .contextMenu {
                        Button {
                            contextMenuSpecies = speciesName
                        } label: {
                            Label("View Details", systemImage: "bird")
                        }
                        if let entry {
                            ShareLink(item: SharePayload.species(entry)) {
                                Label("Share", systemImage: "square.and.arrow.up")
                            }
                        }
                        if let url = getEbirdURL(for: speciesName) {
                            Link(destination: url) {
                                Label("Open in eBird", systemImage: "globe")
                            }
                        }
                        if let url = getWikipediaURL(for: entry?.wikiTitle) {
                            Link(destination: url) {
                                Label("Open in Wikipedia", systemImage: "book")
                            }
                        }
                    } preview: {
                        NavigationStack {
                            SpeciesDetailView(speciesName: speciesName)
                        }
                        .environment(store)
                    }
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            Task {
                                await removeSpecies(
                                    displayName: getDisplayName(speciesName),
                                    observationIds: obs.map(\.id)
                                )
                            }
                        } label: {
                            Label("Remove", systemImage: "trash")
                        }
                    }
                }
            }
        }
    }

    // MARK: - Possible

    @ViewBuilder
    private var possibleListSection: some View {
        if !possible.isEmpty {
            let grouped = Dictionary(grouping: possible, by: \.speciesName)
                .sorted { $0.key.localizedCaseInsensitiveCompare($1.key) == .orderedAscending }

            Section {
                speciesSectionTitle(title: "Possible (\(possible.count))")
                    .listRowSeparator(.hidden)

                ForEach(grouped, id: \.key) { speciesName, obs in
                    let totalCount = obs.reduce(0) { $0 + $1.count }
                    let entry = store.dexEntry(for: speciesName)
                    NavigationLink(value: speciesName) {
                        BirdRow(
                            speciesName: speciesName,
                            thumbnailUrl: entry?.thumbnailUrl,
                            count: totalCount
                        )
                    }
                    .contextMenu {
                        Button {
                            contextMenuSpecies = speciesName
                        } label: {
                            Label("View Details", systemImage: "bird")
                        }
                        if let entry {
                            ShareLink(item: SharePayload.species(entry)) {
                                Label("Share", systemImage: "square.and.arrow.up")
                            }
                        }
                        if let url = getEbirdURL(for: speciesName) {
                            Link(destination: url) {
                                Label("Open in eBird", systemImage: "globe")
                            }
                        }
                        if let url = getWikipediaURL(for: entry?.wikiTitle) {
                            Link(destination: url) {
                                Label("Open in Wikipedia", systemImage: "book")
                            }
                        }
                    } preview: {
                        NavigationStack {
                            SpeciesDetailView(speciesName: speciesName)
                        }
                        .environment(store)
                    }
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            Task {
                                await removeSpecies(
                                    displayName: getDisplayName(speciesName),
                                    observationIds: obs.map(\.id)
                                )
                            }
                        } label: {
                            Label("Remove", systemImage: "trash")
                        }
                    }
                }
            }
        }
    }

    private func speciesSectionTitle(title: String, showsAddAction: Bool = false) -> some View {
        HStack {
            Text(title)
                .font(.system(size: 16, weight: .semibold, design: .serif))
                .foregroundStyle(Color.foregroundText)
            Spacer()
            if showsAddAction {
                Button {
                    showingAddSpecies.toggle()
                    if !showingAddSpecies {
                        resetSpeciesForm()
                    }
                } label: {
                    Label(
                        showingAddSpecies ? "Cancel" : "Add Species",
                        systemImage: showingAddSpecies ? "xmark" : "plus"
                    )
                    .font(.subheadline)
                    .foregroundStyle(Color.accentColor)
                }
            }
        }
    }

    // MARK: - Notes

    private func notesSection(_ outing: Outing) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Notes")
                .font(.system(size: 16, weight: .semibold, design: .serif))
                .foregroundStyle(Color.foregroundText)

            if editingNotes {
                TextEditor(text: $notesText)
                    .frame(minHeight: 60)
                    .padding(8)
                    .background(Color.cardBg)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                HStack {
                    Button("Cancel") { editingNotes = false }
                    Spacer()
                    Button("Save") {
                        Task {
                            do {
                                try await store.updateOuting(id: outingId, fields: OutingUpdate(notes: notesText))
                                editingNotes = false
                            } catch {
                                showError(error, fallback: "Could not save notes. Try again.")
                            }
                        }
                    }
                    .fontWeight(.semibold)
                }
            } else {
                Text(outing.notes.isEmpty ? "No notes" : outing.notes)
                    .font(.system(size: 14))
                    .foregroundStyle(outing.notes.isEmpty ? Color.mutedText : Color.foregroundText)
                    .onTapGesture {
                        notesText = outing.notes
                        editingNotes = true
                    }
            }
        }
    }

    // MARK: - Add Species

    private var addSpeciesForm: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("Search species or enter a name", text: $speciesQuery)
                .textInputAutocapitalization(.words)
                .onChange(of: speciesQuery) { _, query in
                    if selectedSpecies?.common != query {
                        selectedSpecies = nil
                    }
                    scheduleSpeciesSearch(query)
                }

            if isSearchingSpecies {
                ProgressView()
                    .controlSize(.small)
            }

            ForEach(speciesResults) { result in
                Button {
                    speciesSearchTask?.cancel()
                    selectedSpecies = result
                    speciesQuery = result.common
                    speciesResults = []
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(result.common)
                            .font(.subheadline)
                            .foregroundStyle(.primary)
                        Text(result.scientific)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .tint(.primary)
            }

            Button {
                Task { await addSpecies() }
            } label: {
                if isAddingSpecies {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                } else {
                    Text("Add Species")
                        .font(.system(size: 16, weight: .medium))
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(speciesQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isAddingSpecies)
        }
        .padding(.vertical, 6)
    }

    private var locationSuggestions: [String] {
        let query = locationText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return [] }

        var seen = Set<String>()
        return store.outings
            .map { $0.locationName.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && seen.insert($0.lowercased()).inserted }
            .filter { $0.localizedCaseInsensitiveContains(query) && $0.caseInsensitiveCompare(locationText) != .orderedSame }
            .sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
            .prefix(8)
            .map { $0 }
    }

    private func saveLocation(_ outing: Outing) async {
        let trimmed = locationText.trimmingCharacters(in: .whitespacesAndNewlines)
        let currentName = outing.locationName.trimmingCharacters(in: .whitespacesAndNewlines)
        let resetName = outing.defaultLocationName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let newName = trimmed.isEmpty
            ? (resetName.isEmpty ? (currentName.isEmpty ? "Unknown Location" : currentName) : resetName)
            : trimmed
        let defaultName = outing.defaultLocationName ?? (currentName.isEmpty ? nil : currentName)

        do {
            try await store.updateOuting(
                id: outingId,
                fields: OutingUpdate(locationName: newName, defaultLocationName: defaultName)
            )
            editingLocation = false
        } catch {
            showError(error, fallback: "Could not save outing name. Try again.")
        }
    }

    private func scheduleSpeciesSearch(_ query: String) {
        speciesSearchTask?.cancel()
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, selectedSpecies == nil else {
            speciesResults = []
            isSearchingSpecies = false
            return
        }

        speciesSearchTask = Task {
            do {
                try await Task.sleep(for: .milliseconds(150))
                guard !Task.isCancelled else { return }
                isSearchingSpecies = true
                let results = try await store.searchSpecies(query: trimmed)
                guard !Task.isCancelled,
                      speciesQuery.trimmingCharacters(in: .whitespacesAndNewlines) == trimmed
                else { return }
                speciesResults = results
            } catch is CancellationError {
                isSearchingSpecies = false
                return
            } catch {
                speciesResults = []
            }
            isSearchingSpecies = false
        }
    }

    private func addSpecies() async {
        let trimmed = speciesQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let storedName: String
        let displayName: String
        if let selectedSpecies {
            storedName = "\(selectedSpecies.common) (\(selectedSpecies.scientific))"
            displayName = selectedSpecies.common
        } else {
            storedName = trimmed
            displayName = getDisplayName(trimmed)
        }

        isAddingSpecies = true
        let observation = BirdObservation(
            id: "obs_\(UUID().uuidString)",
            outingId: outingId,
            speciesName: storedName,
            count: 1,
            certainty: .confirmed,
            notes: "Manually added"
        )
        do {
            try await store.addObservation(observation)
            resetSpeciesForm()
            showingAddSpecies = false
        } catch {
            showError(error, fallback: "Could not add \(displayName). Try again.")
        }
        isAddingSpecies = false
    }

    private func resetSpeciesForm() {
        speciesSearchTask?.cancel()
        speciesQuery = ""
        selectedSpecies = nil
        speciesResults = []
        isSearchingSpecies = false
    }

    private func removeSpecies(displayName: String, observationIds: [String]) async {
        do {
            try await store.rejectObservations(ids: observationIds)
        } catch {
            showError(error, fallback: "Could not remove \(displayName). Try again.")
        }
    }

    private func exportOuting(_ outing: Outing) async {
        isExporting = true
        do {
            let csvData = try await store.exportOutingCSV(outingId: outing.id)
            exportItem = try ExportFileFactory.outing(data: csvData, outing: outing)
        } catch {
            showError(error, fallback: "Could not export outing. Try again.")
        }
        isExporting = false
    }

    private var operationErrorBinding: Binding<Bool> {
        Binding(
            get: { operationError != nil },
            set: { if !$0 { operationError = nil } }
        )
    }

    private func showError(_ error: Error, fallback: String) {
        guard let appError = AppError.map(error, fallback: fallback) else { return }
        operationError = appError.message
    }
}

#if DEBUG
#Preview("Outing Detail - Discovery Park") {
    PreviewTabs(.outings) {
        NavigationStack {
            OutingDetailView(outingId: PreviewData.sampleOutingId)
                .environment(previewStore())
        }
    }
}

#Preview("Outing Detail - Everglades") {
    PreviewTabs(.outings) {
        NavigationStack {
            OutingDetailView(outingId: PreviewData.richOutingId)
                .environment(previewStore())
        }
    }
}

#Preview("Outing Detail - Not Found") {
    PreviewTabs(.outings) {
        NavigationStack {
            OutingDetailView(outingId: "nonexistent")
                .environment(previewStore())
        }
    }
}
#endif
