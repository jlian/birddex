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
    @State private var suggestedStateProvince: String?
    @State private var suggestedCountryCode: String?

    /// Extracted ISO 3166-2 state/province code from geocoding.
    @State private var inferredStateProvince: String?
    @State private var inferredCountryCode: String?

    /// Manual date/time editing
    @State private var overriddenStartTime: Date?

    /// Explicit place search through the WingDex geocoding proxy.
    @State private var placeResults: [GeocodingResult] = []
    @State private var isSearchingPlace = false
    @FocusState private var isLocationFieldFocused: Bool
    @State private var overriddenCoords: CLLocationCoordinate2D?
    @State private var reverseGeocodingTask: Task<Void, Never>?
    @State private var placeSearchTask: Task<Void, Never>?
    @State private var placeSearchGeneration = 0
    @State private var placeSearchFailed = false
    /// The query behind `placeResults`, so an empty result set can name what was searched.
    @State private var searchedQuery: String?
    @State private var isShowingPlaceResults = false
    /// Other named places around the photo coordinates, kept from the reverse lookup.
    @State private var nearbyPlaces: [GeocodingResult] = []

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
            }

            // Existing outing match toggle
            if let existing = matchingOuting {
                existingOutingSection(existing)
            }

            // Location name with inline place search
            Section {
                if useExistingOuting, let existing = matchingOuting {
                    LabeledContent("Inherited") {
                        Text(existing.locationName)
                    }
                    .accessibilityIdentifier("outing.inheritedLocationName")
                } else {
                    locationSection
                }
            } header: {
                Text("Location")
            } footer: {
                locationFooter
            }

            // Photo thumbnails grid
            Section {
                photoGridSection
            } header: {
                Text("Photos (\(cluster?.photos.count ?? 0))")
                    .font(.headline)
                    .foregroundStyle(Color.foregroundText)
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
        .onChange(of: locationName) {
            clearSearchResults()
        }
        .onChange(of: useExistingOuting) { _, usesExisting in
            guard !usesExisting, viewModel.useGeoContext else { return }
            startReverseGeocodeIfPossible()
        }
        .onDisappear {
            reverseGeocodingTask?.cancel()
            placeSearchTask?.cancel()
        }
    }

    /// One caption below the location controls: attribution, then what happens to coordinates.
    private var locationFooter: some View {
        Text("Location data by [Geoapify](https://www.geoapify.com/), [OpenStreetMap](https://www.openstreetmap.org/copyright), and [GeoNames](https://www.geonames.org/). Coordinates are saved with your outing and rounded for lookups.")
            .font(.footnote)
            .foregroundStyle(Color.mutedText)
            .tint(Color.accentColor)
            .accessibilityIdentifier("outing.locationAttribution")
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
        .foregroundStyle(.primary)
        .tint(.primary)
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
                        .foregroundStyle(Color.mutedText)
                }
            }
            .accessibilityIdentifier("outing.useExisting")
        }
    }

    // MARK: - Location Section (name field + submitted place search)

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
        } else {
            // The field is the outing name. Typing renames the outing; submitting
            // looks the name up so a matching place can also supply coordinates.
            HStack(spacing: 0) {
                TextField("Location name", text: $locationName)
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                    .focused($isLocationFieldFocused)
                    .onSubmit(submitPlaceSearch)
                    .accessibilityIdentifier("outing.locationName")

                if isLocationFieldFocused && !locationName.isEmpty {
                    Button {
                        locationName = ""
                        isLocationFieldFocused = true
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(Color.secondary)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Clear location name")
                    .accessibilityIdentifier("outing.locationClear")
                }

                Button(action: submitPlaceSearchOrShowNearby) {
                    Image(systemName: "magnifyingglass")
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .disabled(isSearchingPlace || (trimmedLocationName.isEmpty && nearbyPlaces.isEmpty))
                .accessibilityLabel(trimmedLocationName.isEmpty ? "Show places near your photos" : "Search for this place")
                .accessibilityIdentifier("outing.locationSearchSubmit")
            }
            .popover(
                isPresented: $isShowingPlaceResults,
                attachmentAnchor: .rect(.bounds),
                arrowEdge: .top
            ) {
                placeResultsDropdown
            }

            if !suggestedLocation.isEmpty && suggestedLocation != locationName {
                Button("Use GPS: \(suggestedLocation)") {
                    restoreSuggestedLocation()
                }
                .font(.subheadline)
            }
        }
    }

    // MARK: - Place Search Results

    /// Candidates on show: submitted search results, or the places around the photos.
    private var dropdownPlaces: [GeocodingResult] {
        searchedQuery == nil && placeResults.isEmpty ? nearbyPlaces : placeResults
    }

    private var isShowingNearby: Bool {
        searchedQuery == nil && placeResults.isEmpty && !nearbyPlaces.isEmpty
    }

    /// Anchored under the name field so results overlay the form instead of moving it.
    private var placeResultsDropdown: some View {
        Group {
            if isSearchingPlace {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if placeSearchFailed {
                VStack(spacing: 12) {
                    Text("Couldn't search for places.")
                        .foregroundStyle(Color.mutedText)
                    Button("Try Again", action: submitPlaceSearch)
                        .buttonStyle(.bordered)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if dropdownPlaces.isEmpty {
                Text("No places found for \"\(searchedQuery ?? trimmedLocationName)\".")
                    .foregroundStyle(Color.mutedText)
                    .multilineTextAlignment(.center)
                    .padding()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                // A plain List here would be repainted by the app's UICollectionViewListCell override.
                ScrollView {
                    VStack(spacing: 0) {
                        if isShowingNearby {
                            Text("Near your photos")
                                .font(.footnote)
                                .foregroundStyle(Color.mutedText)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 16)
                                .padding(.top, 10)
                                .padding(.bottom, 4)
                        }
                        ForEach(dropdownPlaces) { item in
                            Button {
                                selectPlace(item)
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.label)
                                        .foregroundStyle(Color.foregroundText)
                                    if let context = item.context {
                                        Text(context)
                                            .font(.subheadline)
                                            .foregroundStyle(Color.mutedText)
                                    }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 16)
                                .padding(.vertical, 10)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("outing.locationResult")

                            if item.id != dropdownPlaces.last?.id {
                                Divider().padding(.leading, 16)
                            }
                        }
                    }
                }
            }
        }
        .frame(width: 340, height: dropdownHeight)
        .background(Color.cardBg)
        .presentationCompactAdaptation(.popover)
    }

    private var dropdownHeight: CGFloat {
        guard !isSearchingPlace, !placeSearchFailed, !dropdownPlaces.isEmpty else { return 140 }
        return min(CGFloat(dropdownPlaces.count) * 68 + (isShowingNearby ? 28 : 0), 300)
    }

    /// The magnifier searches what you typed, or offers the places around your photos.
    private func submitPlaceSearchOrShowNearby() {
        if trimmedLocationName.isEmpty {
            showNearbyPlaces()
        } else {
            submitPlaceSearch()
        }
    }

    private func showNearbyPlaces() {
        guard !nearbyPlaces.isEmpty else { return }
        clearSearchResults()
        isShowingPlaceResults = true
    }

    private var trimmedLocationName: String {
        locationName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func dismissLocationSearch() {
        placeSearchTask?.cancel()
        isSearchingPlace = false
        isLocationFieldFocused = false
        isShowingPlaceResults = false
        clearSearchResults()
    }

    private func clearSearchResults() {
        placeResults = []
        placeSearchFailed = false
        searchedQuery = nil
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
        suggestedStateProvince = nil
        suggestedCountryCode = nil
        inferredStateProvince = nil
        inferredCountryCode = nil
        overriddenStartTime = nil
        overriddenCoords = nil
        placeResults = []
        searchedQuery = nil
        isSearchingPlace = false
        placeSearchFailed = false
        isShowingPlaceResults = false
        nearbyPlaces = []
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

        if viewModel.useGeoContext, matchingOuting == nil {
            startReverseGeocodeIfPossible()
        }
    }

    /// Also runs when the user declines the matched outing, since they then need a suggestion.
    private func startReverseGeocodeIfPossible() {
        guard reverseGeocodingTask == nil,
              let cluster, let lat = cluster.centerLat, let lon = cluster.centerLon
        else { return }
        let clusterID = cluster.id
        reverseGeocodingTask = Task {
            await reverseGeocode(clusterID: clusterID, latitude: lat, longitude: lon)
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
        if ProcessInfo.processInfo.arguments.contains("--ui-test-geocoding-delay") {
            do {
                try await Task.sleep(for: .seconds(10))
            } catch {
                return
            }
        }
        if ProcessInfo.processInfo.arguments.contains("--ui-test-geocoding-failure") {
            applyCoordinateFallback(latitude: roundedLat, longitude: roundedLon)
            return
        }
        #endif

        do {
            let lookup = try await GeocodingService(auth: auth).reverse(latitude: roundedLat, longitude: roundedLon)
            try Task.checkCancellation()
            guard cluster?.id == clusterID else { return }
            nearbyPlaces = lookup.nearby
            if let result = lookup.result {
                locationName = result.label
                suggestedLocation = result.label
                suggestedStateProvince = result.stateProvince
                suggestedCountryCode = result.countryCode
                inferredStateProvince = result.stateProvince
                inferredCountryCode = result.countryCode
            } else {
                applyCoordinateFallback(latitude: roundedLat, longitude: roundedLon)
            }
        } catch is CancellationError {
            return
        } catch {
            // The name field is editable and pre-filled with a usable fallback, so a
            // failed suggestion never blocks the user or needs its own error row.
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
        suggestedStateProvince = nil
        suggestedCountryCode = nil
        inferredStateProvince = nil
        inferredCountryCode = nil
    }

    private func submitPlaceSearch() {
        let query = trimmedLocationName
        guard !query.isEmpty, let clusterID = cluster?.id else { return }
        placeSearchTask?.cancel()
        placeSearchGeneration += 1
        let generation = placeSearchGeneration
        isSearchingPlace = true
        placeSearchFailed = false
        placeResults = []
        searchedQuery = nil
        isShowingPlaceResults = true
        placeSearchTask = Task {
            defer {
                // Only the current search may clear the loading state. A cancelled
                // predecessor shares this cluster, so guarding on clusterID alone
                // would let it hide progress for its live replacement.
                if placeSearchGeneration == generation {
                    isSearchingPlace = false
                }
            }
            do {
                let results = try await GeocodingService(auth: auth).search(query: query)
                try Task.checkCancellation()
                guard placeSearchGeneration == generation,
                      cluster?.id == clusterID,
                      trimmedLocationName == query else { return }
                placeResults = results
                searchedQuery = query
            } catch is CancellationError {
                return
            } catch {
                log.error("Place search failed")
                guard placeSearchGeneration == generation, cluster?.id == clusterID else { return }
                placeSearchFailed = true
            }
        }
    }

    private func selectPlace(_ result: GeocodingResult) {
        let coordinate = CLLocationCoordinate2D(latitude: result.latitude, longitude: result.longitude)
        if CLLocationCoordinate2DIsValid(coordinate) {
            overriddenCoords = coordinate
        }
        locationName = result.label
        inferredCountryCode = result.countryCode
        inferredStateProvince = result.stateProvince
        dismissLocationSearch()
    }

    private func restoreSuggestedLocation() {
        locationName = suggestedLocation
        inferredStateProvince = suggestedStateProvince
        inferredCountryCode = suggestedCountryCode
        overriddenCoords = nil
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

        let finalLocationName = trimmedLocationName.isEmpty ? "Unknown Location" : trimmedLocationName
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
