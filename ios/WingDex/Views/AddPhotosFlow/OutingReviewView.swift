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
    var onReverseGeocodingCancellationAcknowledged: () -> Void = {}
    @Environment(AuthService.self) private var auth
    @Environment(DataStore.self) private var store

    // MARK: - Local State

    @State private var locationName = ""
    @State private var isLoadingLocation = false
    @State private var locationLookupState: LocationLookupState = .ok
    @State private var suggestedLocation = ""
    @State private var suggestedStateProvince: String?
    @State private var suggestedCountryCode: String?
    @State private var suggestedCoords: CLLocationCoordinate2D?
    @State private var suggestedSource: LocationSource = .gps
    @State private var overriddenSource: LocationSource = .search
    @State private var currentLocationService = CurrentLocationService()
    @State private var currentLocationTask: Task<Void, Never>?
    @State private var isLocating = false
    @State private var currentLocationError: String?
    @State private var locationRequestGeneration = 0

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
    /// Other named places around the source coordinates, kept from the reverse lookup.
    @State private var nearbyPlaces: [GeocodingResult] = []

    /// Whether to add photos to an existing matching outing
    @State private var matchingOuting: Outing?
    @State private var useExistingOuting = false

    /// Tracks whether the view has initiated geocoding for the current cluster.
    @State private var didInitialize = false

    private enum LocationLookupState {
        case ok
        case empty
        case error
    }

    private enum LocationSource {
        case gps
        case current
        case search
    }

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
                    .font(.headline)
                    .foregroundStyle(Color.foregroundText)
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
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("outing.photosHeader")
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
                .accessibilityIdentifier("outing.continue")
                .buttonStyle(.borderedProminent)
                .disabled(isLoadingLocation)
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
            if usesExisting {
                cancelLocationWork()
                dismissLocationSearch()
                return
            }
            guard !usesExisting, viewModel.useGeoContext else { return }
            startReverseGeocodeIfPossible()
        }
        .onDisappear {
            cancelLocationWork()
            dismissLocationSearch()
        }
    }

    /// Static provider attribution for reverse lookup and explicit place search.
    private var locationFooter: some View {
        Text("Powered by [Geoapify](https://www.geoapify.com/) and [OpenStreetMap](https://www.openstreetmap.org/copyright)")
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
            if overriddenCoords == nil && hasGps {
                Label {
                    HStack(spacing: 4) {
                        Text("GPS detected")
                            .accessibilityIdentifier("outing.gpsStatus")
                        if let lat = effectiveLat, let lon = effectiveLon {
                            Text("(\(lat, specifier: "%.4f"), \(lon, specifier: "%.4f"))")
                                .foregroundStyle(Color.foregroundText)
                                .accessibilityIdentifier("outing.gpsCoordinates")
                        }
                    }
                } icon: {
                    Image(systemName: "location.fill")
                        .foregroundStyle(.green)
                }
                .font(.subheadline)
            } else if let coords = overriddenCoords {
                Label {
                    HStack(spacing: 4) {
                        Text(overriddenSource == .current ? "Current location" : "Location set from search")
                            .accessibilityIdentifier("outing.gpsStatus")
                        Text("(\(coords.latitude, specifier: "%.4f"), \(coords.longitude, specifier: "%.4f"))")
                            .foregroundStyle(Color.foregroundText)
                            .accessibilityIdentifier("outing.gpsCoordinates")
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
        if isLoadingLocation || isLocating {
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text(isLocating
                    ? "Getting current location..."
                    : suggestedSource == .current
                        ? "Identifying current location..."
                        : "Identifying location from GPS...")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Cancel", action: cancelLocationWork)
                    .accessibilityIdentifier("outing.locationCancel")
            }
            .frame(minHeight: 44)
        }
        // The field is the outing name. Typing renames the outing; submitting
        // looks the name up so a matching place can also supply coordinates.
        HStack(spacing: 0) {
            TextField("Location name", text: Binding(
                get: { locationName },
                set: {
                    guard locationName != $0 else { return }
                    cancelLocationWork()
                    cancelPlaceSearch()
                    locationName = $0
                }
            ))
                .textInputAutocapitalization(.words)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .focused($isLocationFieldFocused)
                .onSubmit(submitPlaceSearch)
                .accessibilityIdentifier("outing.locationName")

            if isLocationFieldFocused && !locationName.isEmpty {
                Button {
                    cancelLocationWork()
                    dismissLocationSearch()
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
            .accessibilityLabel(trimmedLocationName.isEmpty
                ? suggestedSource == .current ? "Show places near your current location" : "Show places near your photos"
                : "Search for this place")
            .accessibilityIdentifier("outing.locationSearchSubmit")
        }
        .popover(
            isPresented: $isShowingPlaceResults,
            attachmentAnchor: .rect(.bounds),
            arrowEdge: .top
        ) {
            placeResultsDropdown
        }

        if !suggestedLocation.isEmpty && (suggestedLocation != locationName
            || effectiveLat != suggestedCoords?.latitude || effectiveLon != suggestedCoords?.longitude) {
            Button(suggestedSource == .current
                ? "Use current location: \(suggestedLocation)"
                : "Use GPS: \(suggestedLocation)") {
                restoreSuggestedLocation()
            }
            .font(.subheadline)
            .accessibilityIdentifier("outing.locationRestore")
        }

        if !isLoadingLocation && locationName == suggestedLocation {
            switch locationLookupState {
            case .error:
                HStack(spacing: 4) {
                    Text("Location lookup failed.")
                        // System red nearly misses contrast against this
                        // screen's dark card background. The explicit error
                        // wording carries the state without relying on color.
                        .foregroundStyle(Color.primary)
                        .accessibilityIdentifier("outing.locationLookupError")
                    Button("Retry") {
                        retryReverseGeocoding()
                    }
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
                    .accessibilityIdentifier("outing.locationRetry")
                }
                .font(.footnote)
            case .empty:
                Text("No named place found nearby. Tap above to name this outing.")
                    .font(.footnote)
                    .foregroundStyle(Color.mutedText)
                    .accessibilityIdentifier("outing.locationLookupEmpty")
            case .ok:
                EmptyView()
            }
        }
        if isLocationFieldFocused && (effectiveLat == nil || effectiveLon == nil) {
            Button(action: useCurrentLocation) {
                Label("Use current location", systemImage: "location")
            }
            .disabled(isLocating)
            .accessibilityIdentifier("outing.useCurrentLocation")
        }
        if let currentLocationError {
            Text(currentLocationError)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("outing.currentLocationError")
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
                            Text(suggestedSource == .current ? "Near your current location" : "Near your photos")
                                .font(.footnote)
                                .foregroundStyle(Color.mutedText)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 16)
                                .padding(.top, 10)
                                .padding(.bottom, 4)
                        }
                        ForEach(dropdownPlaces) { item in
                            Button {
                                // A nearby result only changes the outing's name;
                                // it still describes the suggestion's source coordinate.
                                // A submitted search is an explicit coordinate
                                // correction and therefore overrides photo EXIF GPS.
                                selectPlace(item, overridesPhotoGPS: !isShowingNearby)
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
        isLocationFieldFocused = false
        isShowingPlaceResults = true
    }

    private var trimmedLocationName: String {
        locationName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func dismissLocationSearch() {
        cancelPlaceSearch()
        isLocationFieldFocused = false
    }

    private func cancelPlaceSearch() {
        placeSearchTask?.cancel()
        placeSearchTask = nil
        placeSearchGeneration += 1
        isSearchingPlace = false
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
        cancelLocationWork()
        dismissLocationSearch()
        Task {
            await viewModel.removePhotoFromCurrentCluster(id: photo.id)
            if viewModel.currentStep == .outingReview {
                resetClusterState()
                initializeIfNeeded()
            }
        }
    }

    // MARK: - Actions

    /// Reset per-cluster state so each cluster re-initializes correctly.
    private func resetClusterState() {
        cancelLocationWork()
        dismissLocationSearch()
        didInitialize = false
        locationName = ""
        suggestedLocation = ""
        suggestedStateProvince = nil
        suggestedCountryCode = nil
        suggestedCoords = nil
        suggestedSource = .gps
        overriddenSource = .search
        currentLocationError = nil
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
        locationLookupState = .ok
    }

    /// Initialize location lookup and matching outing detection.
    private func initializeIfNeeded() {
        guard !didInitialize else { return }
        didInitialize = true

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
        guard reverseGeocodingTask == nil, overriddenCoords == nil, suggestedCoords == nil,
              let cluster, let lat = cluster.centerLat, let lon = cluster.centerLon
        else { return }
        startReverseGeocode(latitude: lat, longitude: lon, source: .gps)
    }

    private func cancelLocationWork() {
        locationRequestGeneration += 1
        reverseGeocodingTask?.cancel()
        reverseGeocodingTask = nil
        currentLocationTask?.cancel()
        currentLocationTask = nil
        currentLocationService.cancel()
        isLoadingLocation = false
        isLocating = false
    }

    private func useCurrentLocation() {
        guard !isLocating, !useExistingOuting, let clusterID = cluster?.id else { return }
        cancelLocationWork()
        dismissLocationSearch()
        currentLocationError = nil
        isLocating = true
        let generation = locationRequestGeneration
        currentLocationTask = Task {
            defer {
                if locationRequestGeneration == generation {
                    isLocating = false
                    currentLocationTask = nil
                }
            }
            do {
                let coordinate: CLLocationCoordinate2D
                #if DEBUG
                if ProcessInfo.processInfo.arguments.contains("--ui-test-current-location-denied") {
                    throw CurrentLocationError.denied
                } else if ProcessInfo.processInfo.arguments.contains("--ui-test-current-location-success") {
                    if ProcessInfo.processInfo.arguments.contains("--ui-test-current-location-delay") {
                        try await Task.sleep(for: .seconds(10))
                    }
                    coordinate = CLLocationCoordinate2D(latitude: 47.7115123, longitude: -122.3717456)
                } else {
                    coordinate = try await currentLocationService.request()
                }
                #else
                coordinate = try await currentLocationService.request()
                #endif
                try Task.checkCancellation()
                guard locationRequestGeneration == generation, cluster?.id == clusterID,
                      !useExistingOuting else { return }
                overriddenCoords = coordinate
                overriddenSource = .current
                currentLocationTask = nil
                isLocating = false
                startReverseGeocode(latitude: coordinate.latitude, longitude: coordinate.longitude, source: .current)
            } catch is CancellationError {
                return
            } catch {
                guard locationRequestGeneration == generation, cluster?.id == clusterID,
                      !useExistingOuting, !Task.isCancelled else { return }
                currentLocationError = error.localizedDescription
            }
        }
    }

    private func startReverseGeocode(latitude: Double, longitude: Double, source: LocationSource) {
        guard let clusterID = cluster?.id, !useExistingOuting else { return }
        cancelLocationWork()
        let generation = locationRequestGeneration
        suggestedCoords = CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
        suggestedSource = source
        nearbyPlaces = []
        applyCoordinateFallback(latitude: latitude, longitude: longitude, state: .ok)
        isLoadingLocation = true
        reverseGeocodingTask = Task {
            await reverseGeocode(
                clusterID: clusterID, generation: generation, latitude: latitude, longitude: longitude
            )
        }
    }

    private func reverseGeocode(clusterID: UUID, generation: Int, latitude: Double, longitude: Double) async {
        guard locationRequestGeneration == generation, cluster?.id == clusterID, !Task.isCancelled else { return }
        let roundedLat = (latitude * 1000).rounded() / 1000
        let roundedLon = (longitude * 1000).rounded() / 1000
        defer {
            if locationRequestGeneration == generation, cluster?.id == clusterID {
                isLoadingLocation = false
                reverseGeocodingTask = nil
            }
        }

        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-test-geocoding-delay") {
            do {
                try await Task.sleep(for: .seconds(10))
            } catch is CancellationError {
                onReverseGeocodingCancellationAcknowledged()
                return
            } catch {
                return
            }
        }
        guard locationRequestGeneration == generation, cluster?.id == clusterID, !Task.isCancelled else { return }
        if ProcessInfo.processInfo.arguments.contains("--ui-test-geocoding-failure") {
            applyCoordinateFallback(latitude: roundedLat, longitude: roundedLon, state: .error)
            return
        }
        if ProcessInfo.processInfo.arguments.contains("--ui-test-geocoding-empty") {
            applyCoordinateFallback(
                latitude: roundedLat, longitude: roundedLon,
                regionCodes: .init(stateProvince: "US-WA", countryCode: "US"), state: .empty
            )
            return
        }
        if ProcessInfo.processInfo.arguments.contains("--ui-test-geocoding-success") {
            let result = GeocodingResult(
                label: "Carkeek Park", context: "Seattle, Washington",
                latitude: 47.712, longitude: -122.372, stateProvince: "US-WA", countryCode: "US"
            )
            nearbyPlaces = [result]
            applyGeocodedPlace(result)
            return
        }
        #endif

        do {
            // This lookup stays inside WingDex, so preserve the photo cluster's
            // exact coordinate. Rounding by three decimals can move a point
            // across a park or administrative boundary.
            let lookup = try await GeocodingService(auth: auth).reverse(latitude: latitude, longitude: longitude)
            try Task.checkCancellation()
            guard locationRequestGeneration == generation, cluster?.id == clusterID, !useExistingOuting else { return }
            nearbyPlaces = lookup.nearby
            if let result = lookup.result {
                applyGeocodedPlace(result)
            } else {
                // No NAMED place, but the jurisdiction is a separate question
                // and often still answerable offshore or on unmapped land.
                // Carry those codes through so the eBird export keeps them.
                applyCoordinateFallback(
                    latitude: roundedLat,
                    longitude: roundedLon,
                    regionCodes: lookup.regionCodes,
                    state: .empty
                )
            }
        } catch is CancellationError {
            return
        } catch {
            log.error("Reverse geocoding failed")
            guard locationRequestGeneration == generation, cluster?.id == clusterID,
                  !useExistingOuting, !Task.isCancelled else { return }
            applyCoordinateFallback(latitude: roundedLat, longitude: roundedLon, state: .error)
        }
    }

    private func retryReverseGeocoding() {
        guard let coordinate = suggestedCoords else { return }
        restoreSuggestedLocation()
        startReverseGeocode(latitude: coordinate.latitude, longitude: coordinate.longitude, source: suggestedSource)
    }

    private func applyGeocodedPlace(_ result: GeocodingResult) {
        locationName = result.label
        suggestedLocation = result.label
        suggestedStateProvince = result.stateProvince
        suggestedCountryCode = result.countryCode
        inferredStateProvince = result.stateProvince
        inferredCountryCode = result.countryCode
    }

    /// Fall back to a coordinate string as the outing name.
    ///
    /// `regionCodes` is nil on the ERROR path, where nothing is known, and
    /// carries the ISO codes on the successful-but-unnamed path, where the
    /// jurisdiction resolved even though no place did.
    private func applyCoordinateFallback(
        latitude: Double,
        longitude: Double,
        regionCodes: GeocodingService.RegionCodes? = nil,
        state: LocationLookupState
    ) {
        let roundedLat = (latitude * 1000).rounded() / 1000
        let roundedLon = (longitude * 1000).rounded() / 1000
        let fallback = "\(roundedLat)deg, \(roundedLon)deg"
        locationName = fallback
        suggestedLocation = fallback
        suggestedStateProvince = regionCodes?.stateProvince
        suggestedCountryCode = regionCodes?.countryCode
        inferredStateProvince = regionCodes?.stateProvince
        inferredCountryCode = regionCodes?.countryCode
        locationLookupState = state
    }

    private func submitPlaceSearch() {
        let query = trimmedLocationName
        guard !query.isEmpty, let clusterID = cluster?.id else { return }
        cancelLocationWork()
        placeSearchTask?.cancel()
        placeSearchGeneration += 1
        let generation = placeSearchGeneration
        isSearchingPlace = true
        placeSearchFailed = false
        placeResults = []
        searchedQuery = nil
        isLocationFieldFocused = false
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
                let results: [GeocodingResult]
                #if DEBUG
                if ProcessInfo.processInfo.arguments.contains("--ui-test-place-search-result") {
                    results = [GeocodingResult(
                        label: "Discovery Park",
                        context: "Seattle, Washington",
                        latitude: 47.6573,
                        longitude: -122.4066,
                        stateProvince: "Washington",
                        countryCode: "US"
                    )]
                } else {
                    results = try await GeocodingService(auth: auth).search(query: query)
                }
                #else
                results = try await GeocodingService(auth: auth).search(query: query)
                #endif
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

    private func selectPlace(_ result: GeocodingResult, overridesPhotoGPS: Bool) {
        cancelLocationWork()
        currentLocationError = nil
        let coordinate = CLLocationCoordinate2D(latitude: result.latitude, longitude: result.longitude)
        if overridesPhotoGPS, CLLocationCoordinate2DIsValid(coordinate) {
            overriddenCoords = coordinate
            overriddenSource = .search
        } else {
            overriddenCoords = suggestedSource == .current ? suggestedCoords : nil
            overriddenSource = suggestedSource
        }
        locationName = result.label
        inferredCountryCode = result.countryCode
        inferredStateProvince = result.stateProvince
        dismissLocationSearch()
    }

    private func restoreSuggestedLocation() {
        cancelLocationWork()
        currentLocationError = nil
        locationName = suggestedLocation
        inferredStateProvince = suggestedStateProvince
        inferredCountryCode = suggestedCountryCode
        overriddenCoords = suggestedSource == .current ? suggestedCoords : nil
        overriddenSource = suggestedSource
        dismissLocationSearch()
    }

    /// Confirm the outing and proceed to species identification.
    private func handleConfirm() {
        cancelLocationWork()
        dismissLocationSearch()
        if useExistingOuting, let existing = matchingOuting {
            // Merge into existing outing
            viewModel.outingConfirmed(
                outing: nil,
                outingId: existing.id,
                locationName: existing.locationName,
                lat: existing.lat,
                lon: existing.lon,
                outingOverridesPhotoGPS: false
            )
            return
        }

        // Create new outing
        let formatter = ISO8601DateFormatter()

        let finalLocationName = trimmedLocationName.isEmpty ? "Unknown Location" : trimmedLocationName
        let outing = Outing(
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
        viewModel.outingConfirmed(
            outing: outing,
            outingId: outing.id,
            locationName: finalLocationName,
            lat: effectiveLat,
            lon: effectiveLon,
            outingOverridesPhotoGPS: overriddenCoords != nil
        )
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
