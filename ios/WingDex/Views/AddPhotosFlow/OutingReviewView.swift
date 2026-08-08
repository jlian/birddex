import CoreLocation
import SwiftUI
import os

private let log = Logger(subsystem: Config.bundleID, category: "OutingReview")

/// Outing review step in the Add Photos flow.
///
/// After photos are extracted and clustered, the user reviews each cluster
/// as a potential outing: verifying/editing the location name, date/time,
/// and deciding whether to add to an existing outing or create a new one.
///
/// Matches the web app's OutingReview.tsx component.
struct OutingReviewView: View {
    @Bindable var viewModel: AddPhotosViewModel
    @Environment(AuthService.self) private var auth
    @Environment(DataStore.self) private var store

    // MARK: - Local State

    @State private var locationName = ""
    @State private var isLoadingLocation = false
    @State private var suggestedLocation = ""

    /// Extracted ISO 3166-2 state/province code from geocoding.
    @State private var inferredStateProvince: String?
    @State private var inferredCountryCode: String?

    /// Manual date/time editing
    @State private var overriddenStartTime: Date?

    /// Explicit place search through the WingDex geocoding proxy.
    @State private var placeResults: [GeocodingResult] = []
    @State private var isSearchingPlace = false
    @State private var isEditingLocation = false
    @State private var locationSearchQuery = ""
    @FocusState private var isLocationFieldFocused: Bool
    @State private var overriddenCoords: CLLocationCoordinate2D?
    @State private var reverseGeocodingTask: Task<Void, Never>?
    @State private var placeSearchTask: Task<Void, Never>?

    /// Whether to add photos to an existing matching outing
    @State private var matchingOuting: Outing?
    @State private var useExistingOuting = false
    @State private var isCreatingOuting = false
    @State private var preparedOuting: Outing?

    /// Tracks whether the view has initiated geocoding for the current cluster.
    @State private var didInitialize = false

    // MARK: - Computed

    private var cluster: PhotoCluster? {
        guard viewModel.currentClusterIndex < viewModel.clusters.count else { return nil }
        return viewModel.clusters[viewModel.currentClusterIndex]
    }

    private var hasGps: Bool {
        cluster?.centerLat != nil && cluster?.centerLon != nil
    }

    /// Effective coordinates: manual override or cluster GPS.
    private var effectiveLat: Double? {
        overriddenCoords?.latitude ?? cluster?.centerLat
    }

    private var effectiveLon: Double? {
        overriddenCoords?.longitude ?? cluster?.centerLon
    }

    /// Effective start time: manual override or cluster start.
    private var effectiveStartTime: Date {
        overriddenStartTime ?? cluster?.startTime ?? Date()
    }

    /// Effective end time: preserves the cluster's duration.
    private var effectiveEndTime: Date {
        guard let c = cluster else { return Date() }
        let duration = c.endTime.timeIntervalSince(c.startTime)
        return effectiveStartTime.addingTimeInterval(duration)
    }

    // MARK: - Body

    var body: some View {
        Form {
            // Date/time
            Section {
                dateTimeSection
                gpsStatusSection
            } footer: {
                if hasGps {
                    Text("Coordinates are saved with your outing and photo metadata. Rounded coordinates may be sent to OpenStreetMap to suggest a location name.")
                }
            }

            // Existing outing match toggle
            if let existing = matchingOuting {
                existingOutingSection(existing)
            }

            // Location name with inline place search
            if !useExistingOuting {
                Section("Location") {
                    locationSection
                }
            }

            // Photo thumbnails grid
            Section("Photos (\(cluster?.photos.count ?? 0))") {
                photoGridSection
            }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
        .background(Color.pageBg.ignoresSafeArea())
        .navigationTitle(viewModel.clusters.count > 1
            ? "Outing \(viewModel.currentClusterIndex + 1) of \(viewModel.clusters.count)"
            : "Your Outing")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // Primary action top-right
            ToolbarItem(placement: .primaryAction) {
                Button {
                    handleConfirm()
                } label: {
                    Image(systemName: "chevron.right")
                }
                .accessibilityLabel("Continue")
                .buttonStyle(.borderedProminent)
                .disabled(isLoadingLocation || isCreatingOuting)
            }
        }
        .onAppear { initializeIfNeeded() }
        .onChange(of: viewModel.currentClusterIndex) {
            resetClusterState()
            initializeIfNeeded()
        }
        .onDisappear {
            reverseGeocodingTask?.cancel()
            placeSearchTask?.cancel()
        }
    }

    // MARK: - Date/Time Section

    private var dateTimeSection: some View {
        // Native compact DatePicker - tappable inline, auto-applies on change
        DatePicker(
            "Date & Time",
            selection: Binding(
                get: { overriddenStartTime ?? cluster?.startTime ?? Date() },
                set: { overriddenStartTime = $0 }
            ),
            displayedComponents: [.date, .hourAndMinute]
        )
    }

    // MARK: - GPS Status

    private var gpsStatusSection: some View {
        HStack {
            if hasGps {
                Label {
                    HStack(spacing: 4) {
                        Text("GPS detected")
                        if let lat = cluster?.centerLat, let lon = cluster?.centerLon {
                            Text("(\(lat, specifier: "%.4f"), \(lon, specifier: "%.4f"))")
                                .foregroundStyle(.secondary)
                        }
                    }
                } icon: {
                    Image(systemName: "location.fill")
                        .foregroundStyle(.green)
                }
                .font(.subheadline)
            } else {
                Label("No GPS data in photos", systemImage: "location.slash")
                    .font(.subheadline)
                    .foregroundStyle(.orange)
            }
        }
    }

    // MARK: - Existing Outing Match

    private func existingOutingSection(_ outing: Outing) -> some View {
        Section {
            Toggle(isOn: $useExistingOuting) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Add to existing outing?")
                    Text("\(outing.locationName) - \(DateFormatting.formatDate(outing.startTime))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    // MARK: - Location Section (unified display + search)

    @ViewBuilder
    private var locationSection: some View {
        if isLoadingLocation {
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text("Identifying location from GPS...")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        } else if isEditingLocation {
            // Inline search field replaces the static display
            TextField("Search for a place...", text: $locationSearchQuery)
                .textFieldStyle(.plain)
                .autocorrectionDisabled()
                .accessibilityIdentifier("outing.locationSearch")
                .focused($isLocationFieldFocused)
                .onSubmit {
                    submitPlaceSearch()
                }
                .onAppear {
                    locationSearchQuery = ""
                }
                .task {
                    try? await Task.sleep(for: .milliseconds(300))
                    isLocationFieldFocused = true
                }

            Button {
                submitPlaceSearch()
            } label: {
                if isSearchingPlace {
                    ProgressView()
                } else {
                    Label("Search locations", systemImage: "magnifyingglass")
                }
            }
            .disabled(locationSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSearchingPlace)
            .accessibilityIdentifier("outing.locationSearchSubmit")

            ForEach(placeResults) { item in
                Button {
                    selectPlace(item)
                } label: {
                    Text(item.label)
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .tint(.primary)
                .accessibilityIdentifier("outing.locationResult")
            }

            if !locationSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Button("Use entered name without searching") {
                    useEnteredLocationName()
                }
                .font(.subheadline)
            }

            if !suggestedLocation.isEmpty && suggestedLocation != locationName
                && suggestedLocation != locationSearchQuery {
                Button("Use GPS: \(suggestedLocation)") {
                    locationName = suggestedLocation
                    dismissLocationSearch()
                }
                .font(.subheadline)
            }
        } else {
            // Static display with pencil to edit
            HStack {
                Text(locationName.isEmpty ? "Tap to set location" : locationName)
                    .foregroundStyle(locationName.isEmpty ? .secondary : .primary)
                    .accessibilityIdentifier("outing.locationName")
                Spacer()
                Button {
                    isEditingLocation = true
                } label: {
                    Image(systemName: "pencil")
                        .foregroundStyle(.secondary)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture {
                isEditingLocation = true
            }

            if !suggestedLocation.isEmpty && suggestedLocation != locationName {
                Button("Use GPS: \(suggestedLocation)") {
                    locationName = suggestedLocation
                }
                .font(.subheadline)
            }
        }

        Link("Location data © OpenStreetMap contributors", destination: URL(string: "https://www.openstreetmap.org/copyright")!)
            .font(.caption)
            .accessibilityIdentifier("outing.locationAttribution")
    }

    private func dismissLocationSearch() {
        placeSearchTask?.cancel()
        isSearchingPlace = false
        isEditingLocation = false
        locationSearchQuery = ""
        placeResults = []
    }

    // MARK: - Photo Grid (horizontal scroll with context menus)

    private var photoGridSection: some View {
        PhotoReviewCarousel(
            photos: cluster?.photos ?? [],
            onRemove: removePhoto
        )
        .frame(height: 150)
    }

    /// Remove a photo from the current cluster.
    private func removePhoto(_ photo: ProcessedPhoto) {
        viewModel.removePhotoFromCurrentCluster(id: photo.id)
        if viewModel.currentStep == .outingReview {
            resetClusterState()
        }
    }

    // MARK: - Actions

    /// Reset per-cluster state so each cluster re-initializes correctly.
    private func resetClusterState() {
        reverseGeocodingTask?.cancel()
        placeSearchTask?.cancel()
        reverseGeocodingTask = nil
        placeSearchTask = nil
        didInitialize = false
        locationName = ""
        suggestedLocation = ""
        inferredStateProvince = nil
        inferredCountryCode = nil
        overriddenStartTime = nil
        overriddenCoords = nil
        isEditingLocation = false
        locationSearchQuery = ""
        placeResults = []
        isSearchingPlace = false
        matchingOuting = nil
        useExistingOuting = false
        isLoadingLocation = false
        isCreatingOuting = false
        preparedOuting = nil
    }

    /// Initialize location lookup and matching outing detection.
    private func initializeIfNeeded() {
        guard !didInitialize else { return }
        didInitialize = true

        // Pre-fill location name from last outing default
        locationName = viewModel.lastLocationName

        // Find matching existing outing
        if let c = cluster {
            matchingOuting = findMatchingOuting(cluster: c, outings: store.outings)
            useExistingOuting = matchingOuting != nil
        }

        if viewModel.useGeoContext, matchingOuting == nil,
           let cluster, let lat = cluster.centerLat, let lon = cluster.centerLon {
            let clusterID = cluster.id
            reverseGeocodingTask = Task {
                await reverseGeocode(clusterID: clusterID, latitude: lat, longitude: lon)
            }
        }
    }

    private func reverseGeocode(clusterID: UUID, latitude: Double, longitude: Double) async {
        let roundedLat = (latitude * 1000).rounded() / 1000
        let roundedLon = (longitude * 1000).rounded() / 1000
        isLoadingLocation = true
        defer {
            if cluster?.id == clusterID {
                isLoadingLocation = false
            }
        }

        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-test-geocoding-failure") {
            applyCoordinateFallback(latitude: roundedLat, longitude: roundedLon)
            return
        }
        #endif

        do {
            let result = try await GeocodingService(auth: auth).reverse(latitude: roundedLat, longitude: roundedLon)
            try Task.checkCancellation()
            guard cluster?.id == clusterID else { return }
            if let result {
                locationName = result.label
                suggestedLocation = result.label
                inferredStateProvince = result.stateProvince
                inferredCountryCode = result.countryCode
            } else {
                applyCoordinateFallback(latitude: roundedLat, longitude: roundedLon)
            }
        } catch is CancellationError {
            return
        } catch {
            log.error("Reverse geocoding failed")
            guard cluster?.id == clusterID else { return }
            applyCoordinateFallback(latitude: roundedLat, longitude: roundedLon)
        }
    }

    private func applyCoordinateFallback(latitude: Double, longitude: Double) {
        let fallback = viewModel.lastLocationName.isEmpty
            ? "\(latitude)deg, \(longitude)deg"
            : viewModel.lastLocationName
        locationName = fallback
        suggestedLocation = fallback
        inferredStateProvince = nil
        inferredCountryCode = nil
    }

    private func submitPlaceSearch() {
        let query = locationSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty, let clusterID = cluster?.id else { return }
        placeSearchTask?.cancel()
        isSearchingPlace = true
        placeResults = []
        placeSearchTask = Task {
            defer {
                if cluster?.id == clusterID {
                    isSearchingPlace = false
                }
            }
            do {
                let results = try await GeocodingService(auth: auth).search(query: query)
                try Task.checkCancellation()
                guard cluster?.id == clusterID,
                      locationSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines) == query else { return }
                placeResults = results
            } catch is CancellationError {
                return
            } catch {
                log.error("Place search failed")
                guard cluster?.id == clusterID else { return }
                viewModel.error = AppError.map(error, fallback: "Could not search locations. Try again.")
            }
        }
    }

    private func selectPlace(_ result: GeocodingResult) {
        let coordinate = CLLocationCoordinate2D(latitude: result.latitude, longitude: result.longitude)
        if CLLocationCoordinate2DIsValid(coordinate) {
            overriddenCoords = coordinate
        }
        locationName = result.label
        suggestedLocation = result.label
        inferredCountryCode = result.countryCode
        inferredStateProvince = result.stateProvince
        dismissLocationSearch()
    }

    private func useEnteredLocationName() {
        let name = locationSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        locationName = name
        overriddenCoords = nil
        inferredCountryCode = nil
        inferredStateProvince = nil
        dismissLocationSearch()
    }

    /// Confirm the outing and proceed to species identification.
    private func handleConfirm() {
        guard !isCreatingOuting else { return }
        if useExistingOuting, let existing = matchingOuting {
            // Merge into existing outing
            viewModel.outingConfirmed(outingId: existing.id, locationName: existing.locationName)
            return
        }

        // Create new outing
        let formatter = ISO8601DateFormatter()

        let finalLocationName = locationName.isEmpty ? "Unknown Location" : locationName
        let outing = preparedOuting ?? Outing(
            id: "outing_\(UUID().uuidString)",
            userId: "",
            startTime: formatter.string(from: effectiveStartTime),
            endTime: formatter.string(from: effectiveEndTime),
            locationName: finalLocationName,
            defaultLocationName: finalLocationName,
            lat: effectiveLat,
            lon: effectiveLon,
            stateProvince: inferredStateProvince,
            countryCode: inferredCountryCode,
            notes: "",
            createdAt: formatter.string(from: Date())
        )
        preparedOuting = outing
        isCreatingOuting = true

        Task {
            defer { isCreatingOuting = false }
            do {
                let saved = try await viewModel.createOuting(outing)
                preparedOuting = nil
                viewModel.outingConfirmed(outingId: saved.id, locationName: finalLocationName)
            } catch is CancellationError {
                return
            } catch {
                log.error("Failed to create outing")
                viewModel.error = AppError.map(error, fallback: "Could not create this outing. Try again.")
            }
        }
    }

    /// Find an existing outing that matches this cluster by time and location.
    /// Matches the web's `findMatchingOuting` algorithm from clustering.ts.
    private func findMatchingOuting(cluster: PhotoCluster, outings: [Outing]) -> Outing? {
        let timeThreshold: TimeInterval = 2 * 60 * 60 // 2 hours
        let tightTimeThreshold: TimeInterval = 30 * 60 // 30 minutes
        let maxDistanceKm = 3.0
        let relaxedDistanceKm = 50.0

        for outing in outings {
            let outingStart = DateFormatting.sortDate(outing.startTime).timeIntervalSince1970
            let outingEnd = DateFormatting.sortDate(outing.endTime).timeIntervalSince1970
            let clusterStart = cluster.startTime.timeIntervalSince1970
            let clusterEnd = cluster.endTime.timeIntervalSince1970

            // Check time overlap: cluster within +/-2 hours of outing window
            let timeOverlap = clusterStart <= outingEnd + timeThreshold
                && clusterEnd >= outingStart - timeThreshold
            guard timeOverlap else { continue }

            // If both have GPS, check distance
            if let cLat = cluster.centerLat, let cLon = cluster.centerLon,
               let oLat = outing.lat, let oLon = outing.lon
            {
                let dist = PhotoService.haversineDistance(lat1: cLat, lon1: cLon, lat2: oLat, lon2: oLon)

                // Tight time match (<=30 min): allow up to 50 km
                // Loose time match (<=2 hr): allow up to 3 km
                let clusterMid = (clusterStart + clusterEnd) / 2
                let outingMid = (outingStart + outingEnd) / 2
                let timeDelta = abs(clusterMid - outingMid)
                let threshold = timeDelta <= tightTimeThreshold ? relaxedDistanceKm : maxDistanceKm

                if dist > threshold { continue }
            }

            return outing
        }
        return nil
    }
}

// MARK: - Preview

#if DEBUG
#Preview("With GPS") {
    NavigationStack {
        let vm = AddPhotosViewModel()
        OutingReviewView(viewModel: vm)
            .environment(AuthService())
            .environment(previewStore())
            .onAppear {
                vm.clusters = [PreviewData.sampleCluster(photoCount: 5, lat: 47.6587, lon: -122.4050)]
            }
    }
}

#Preview("No GPS") {
    NavigationStack {
        let vm = AddPhotosViewModel()
        OutingReviewView(viewModel: vm)
            .environment(AuthService())
            .environment(previewStore())
            .onAppear {
                vm.clusters = [PreviewData.sampleCluster(photoCount: 2, lat: nil, lon: nil)]
            }
    }
}

#Preview("Multi-Cluster") {
    NavigationStack {
        let vm = AddPhotosViewModel()
        OutingReviewView(viewModel: vm)
            .environment(AuthService())
            .environment(previewStore())
            .onAppear {
                vm.clusters = [
                    PreviewData.sampleCluster(photoCount: 3, lat: 47.6587, lon: -122.4050),
                    PreviewData.sampleCluster(photoCount: 2, lat: 40.6155, lon: -73.8227),
                ]
            }
    }
}

#Preview("Existing Outing Match") {
    NavigationStack {
        let vm = AddPhotosViewModel()
        // Use a store with existing outings so the matcher can find a match
        let store = previewStore()
        OutingReviewView(viewModel: vm)
            .environment(AuthService())
            .environment(store)
            .onAppear {
                // Cluster at Discovery Park with time overlapping outing-001
                vm.clusters = [PreviewData.sampleCluster(photoCount: 4, lat: 47.6587, lon: -122.4050)]
            }
    }
}
#endif
