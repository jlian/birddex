import MapKit
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

    /// Place search via MapKit autocomplete
    @State private var placeCompleter = PlaceSearchCompleter()
    @State private var isEditingLocation = false
    @State private var locationSearchQuery = ""
    @FocusState private var isLocationFieldFocused: Bool
    @State private var overriddenCoords: CLLocationCoordinate2D?

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
                .focused($isLocationFieldFocused)
                .onSubmit {
                    // If user presses return with text, use it as the location name
                    if !locationSearchQuery.trimmingCharacters(in: .whitespaces).isEmpty {
                        locationName = locationSearchQuery
                    }
                    dismissLocationSearch()
                }
                .onChange(of: locationSearchQuery) {
                    placeCompleter.search(query: locationSearchQuery)
                }
                .onAppear {
                    locationSearchQuery = ""
                }
                .task {
                    try? await Task.sleep(for: .milliseconds(300))
                    isLocationFieldFocused = true
                }

            // Autocomplete results
            ForEach(placeCompleter.results) { item in
                Button {
                    selectCompletion(item)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title)
                            .font(.subheadline)
                            .foregroundStyle(.primary)
                        if !item.subtitle.isEmpty {
                            Text(item.subtitle)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .tint(.primary)
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
    }

    private func dismissLocationSearch() {
        isEditingLocation = false
        locationSearchQuery = ""
        placeCompleter.results = []
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
        didInitialize = false
        locationName = ""
        suggestedLocation = ""
        inferredStateProvince = nil
        inferredCountryCode = nil
        overriddenStartTime = nil
        overriddenCoords = nil
        isEditingLocation = false
        locationSearchQuery = ""
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

        // Reverse geocode if GPS available and not merging into existing outing
        if viewModel.useGeoContext && hasGps && matchingOuting == nil {
            Task { await reverseGeocode() }
        }
    }

    /// Reverse geocode the cluster center coordinates via Nominatim.
    private func reverseGeocode() async {
        guard let lat = cluster?.centerLat, let lon = cluster?.centerLon else { return }
        let roundedLat = (lat * 1000).rounded() / 1000
        let roundedLon = (lon * 1000).rounded() / 1000
        isLoadingLocation = true

        do {
            // Try nearby nature place first (parks, reserves)
            if let natureName = try await fetchNearbyNaturePlace(lat: roundedLat, lon: roundedLon) {
                locationName = natureName.name
                suggestedLocation = natureName.name
                inferredStateProvince = natureName.stateProvince
                inferredCountryCode = natureName.countryCode
                isLoadingLocation = false
                return
            }

            // Fall back to reverse geocode at progressively coarser zoom
            for zoom in [15, 14, 10] {
                if let result = try await fetchReverseGeocode(lat: roundedLat, lon: roundedLon, zoom: zoom) {
                    locationName = result.name
                    suggestedLocation = result.name
                    inferredStateProvince = result.stateProvince
                    inferredCountryCode = result.countryCode
                    isLoadingLocation = false
                    return
                }
            }

            // Final fallback: coordinate string
            let fallback = viewModel.lastLocationName.isEmpty
                ? "\(roundedLat)deg, \(roundedLon)deg"
                : viewModel.lastLocationName
            locationName = fallback
            suggestedLocation = fallback
        } catch {
            log.error("Reverse geocoding failed")
            let fallback = viewModel.lastLocationName.isEmpty
                ? "\(roundedLat)deg, \(roundedLon)deg"
                : viewModel.lastLocationName
            locationName = fallback
            suggestedLocation = fallback
        }
        isLoadingLocation = false
    }

    /// Search for a nature place (park, reserve) near the given coordinates.
    private func fetchNearbyNaturePlace(lat: Double, lon: Double) async throws -> GeoResult? {
        let delta = 0.02
        let left = lon - delta
        let right = lon + delta
        let top = lat + delta
        let bottom = lat - delta

        var components = URLComponents(string: "https://nominatim.openstreetmap.org/search")!
        components.queryItems = [
            URLQueryItem(name: "format", value: "jsonv2"),
            URLQueryItem(name: "q", value: "park"),
            URLQueryItem(name: "addressdetails", value: "1"),
            URLQueryItem(name: "namedetails", value: "1"),
            URLQueryItem(name: "accept-language", value: "en"),
            URLQueryItem(name: "bounded", value: "1"),
            URLQueryItem(name: "limit", value: "5"),
            URLQueryItem(name: "viewbox", value: "\(left),\(top),\(right),\(bottom)"),
        ]

        guard let url = components.url else { return nil }
        var request = URLRequest(url: url)
        request.setValue("WingDex-iOS/1.0", forHTTPHeaderField: "User-Agent")

        let (data, _) = try await URLSession.shared.data(for: request)
        let results = try JSONDecoder().decode([NominatimResult].self, from: data)

        // Score results and pick the best nature place
        let best = results
            .map { (result: $0, score: scoreNominatimResult($0)) }
            .filter { $0.score >= 60 }
            .max(by: { $0.score < $1.score })

        guard let winner = best?.result else { return nil }
        return formatGeoResult(winner)
    }

    /// Reverse geocode a point via Nominatim at the given zoom level.
    private func fetchReverseGeocode(lat: Double, lon: Double, zoom: Int) async throws -> GeoResult? {
        var components = URLComponents(string: "https://nominatim.openstreetmap.org/reverse")!
        components.queryItems = [
            URLQueryItem(name: "lat", value: "\(lat)"),
            URLQueryItem(name: "lon", value: "\(lon)"),
            URLQueryItem(name: "format", value: "jsonv2"),
            URLQueryItem(name: "addressdetails", value: "1"),
            URLQueryItem(name: "namedetails", value: "1"),
            URLQueryItem(name: "accept-language", value: "en"),
            URLQueryItem(name: "zoom", value: "\(zoom)"),
        ]

        guard let url = components.url else { return nil }
        var request = URLRequest(url: url)
        request.setValue("WingDex-iOS/1.0", forHTTPHeaderField: "User-Agent")

        let (data, _) = try await URLSession.shared.data(for: request)
        let result = try JSONDecoder().decode(NominatimResult.self, from: data)

        let score = scoreNominatimResult(result)
        guard score >= 30 else { return nil }
        return formatGeoResult(result)
    }

    /// Score a Nominatim result by category relevance (matches web's scoreResult).
    private func scoreNominatimResult(_ result: NominatimResult) -> Int {
        var score = 0
        let category = (result.category ?? "").lowercased()
        let type = (result.type ?? "").lowercased()
        let hasName = result.name != nil || result.namedetails?["name:en"] != nil || result.namedetails?["name"] != nil

        if category == "leisure" && type == "park" { score += 100 }
        else if category == "boundary" && type == "protected_area" { score += 95 }
        else if category == "natural" { score += 80 }
        else if category == "waterway" { score += 72 }
        else if category == "place" && ["suburb", "neighbourhood", "village", "town"].contains(type) { score += 60 }
        else if category == "boundary" && type == "administrative" { score += 45 }
        else { score += 30 }

        if hasName { score += 5 }
        let addr = result.address
        if addr?["city"] != nil || addr?["town"] != nil || addr?["village"] != nil || addr?["county"] != nil {
            score += 5
        }
        return min(score, 100)
    }

    /// Format a Nominatim result into a display-friendly label with region codes.
    private func formatGeoResult(_ result: NominatimResult) -> GeoResult {
        let englishName = result.namedetails?["name:en"] ?? result.namedetails?["name"]
        let addr = result.address ?? [:]

        // Find primary name by priority: english name > result name > place type
        let primary: String? = englishName
            ?? result.name
            ?? firstNonNil(addr, keys: ["park", "nature_reserve", "neighbourhood", "suburb",
                                        "village", "town", "city", "county", "state"])

        // Find locality for the secondary label component
        let locality: String? = firstNonNil(addr, keys: ["neighbourhood", "suburb", "village",
                                                          "town", "city", "county"])

        var parts = [primary, locality, addr["state"]].compactMap { $0 }
        // Deduplicate while preserving order
        var seen = Set<String>()
        parts = parts.filter { seen.insert($0).inserted }
        let name = parts.prefix(3).joined(separator: ", ")

        let region = extractRegionCodes(result)
        return GeoResult(name: name, stateProvince: region.stateProvince, countryCode: region.countryCode)
    }

    /// Extract ISO 3166-2 state/province code and country code from a Nominatim result.
    private func extractRegionCodes(_ result: NominatimResult) -> (stateProvince: String?, countryCode: String?) {
        let addr = result.address ?? [:]
        let countryCode = addr["country_code"]?.trimmingCharacters(in: .whitespaces).uppercased()

        // Try direct ISO3166-2 fields
        let directState = normalizeStateCode(addr["ISO3166-2-lvl4"])
            ?? normalizeStateCode(addr["ISO3166-2-lvl3"])
            ?? normalizeStateCode(addr["ISO3166-2-lvl5"])

        if let directState {
            return (directState, countryCode)
        }

        // Construct from country + state code
        if let cc = countryCode {
            let stateCode = (addr["state_code"] ?? addr["region_code"])?.trimmingCharacters(in: .whitespaces).uppercased()
            if let sc = stateCode, sc.range(of: #"^[A-Z0-9]{1,6}$"#, options: .regularExpression) != nil {
                return ("\(cc)-\(sc)", cc)
            }
        }

        return (nil, countryCode)
    }

    /// Validate an ISO 3166-2 state/province code format.
    private func normalizeStateCode(_ raw: String?) -> String? {
        guard let value = raw?.trimmingCharacters(in: .whitespaces).uppercased(), !value.isEmpty else { return nil }
        return value.range(of: #"^[A-Z]{2}-[A-Z0-9]{1,6}$"#, options: .regularExpression) != nil ? value : nil
    }

    /// Return the first non-nil value from a dictionary for the given ordered keys.
    private func firstNonNil(_ dict: [String: String], keys: [String]) -> String? {
        for key in keys {
            if let value = dict[key] { return value }
        }
        return nil
    }

    /// Select a place from MapKit autocomplete results.
    private func selectCompletion(_ item: PlaceSearchCompleter.PlaceResult) {
        // Build the search request BEFORE dismissing, since dismiss clears the snapshot
        let searchRequest = placeCompleter.buildRequest(for: item)
        dismissLocationSearch()

        guard let searchRequest else { return }
        Task {
            let search = MKLocalSearch(request: searchRequest)
            let mapItem: MKMapItem?
            do {
                mapItem = try await search.start().mapItems.first
            } catch {
                log.debug("Place search failed")
                return
            }
            guard let mapItem else { return }

            let coord = mapItem.location.coordinate
            if CLLocationCoordinate2DIsValid(coord) {
                overriddenCoords = coord
            }

            let info = Self.extractPlaceInfo(from: mapItem)
            if !info.shortName.isEmpty {
                locationName = info.shortName
                suggestedLocation = info.shortName
            } else if let name = mapItem.name, !name.isEmpty {
                locationName = name
                suggestedLocation = name
            }
            inferredCountryCode = info.countryCode
            inferredStateProvince = info.stateProvince
        }
    }

    /// Extract display name and region codes from an MKMapItem using iOS 26 APIs.
    private static func extractPlaceInfo(from mapItem: MKMapItem) -> (shortName: String, countryCode: String?, stateProvince: String?) {
        // Use addressRepresentations for display and region info
        if let reps = mapItem.addressRepresentations {
            let shortName = reps.cityWithContext(.full)
                ?? reps.fullAddress(includingRegion: false, singleLine: true)
                ?? mapItem.name
                ?? ""
            let regionCode = reps.region?.identifier
            return (shortName, regionCode, nil)
        }

        // Fallback to name
        return (mapItem.name ?? "", nil, nil)
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

// MARK: - Nominatim API Models

/// Decoded Nominatim API result.
private struct NominatimResult: Codable {
    let name: String?
    let displayName: String?
    let lat: String?
    let lon: String?
    let category: String?
    let type: String?
    let address: [String: String]?
    let namedetails: [String: String]?

    enum CodingKeys: String, CodingKey {
        case name
        case displayName = "display_name"
        case lat, lon, category, type, address, namedetails
    }
}

/// A place search result from Nominatim.
/// Still used for reverse geocoding results; place search uses MKLocalSearchCompleter.
struct NominatimPlace: Identifiable {
    let id: String
    let displayName: String
    let lat: Double
    let lon: Double
    let address: [String: String]?
}

/// Formatted geocoding result with region codes.
private struct GeoResult {
    let name: String
    let stateProvince: String?
    let countryCode: String?
}

// MARK: - MapKit Place Search Completer

/// Wraps MKLocalSearchCompleter for SwiftUI, providing native place autocomplete.
///
/// Replaces the hand-rolled Nominatim search API with Apple's MapKit autocomplete,
/// which is faster, respects user privacy, and provides proper localized results.
///
/// Uses a delegate bridge to handle Swift 6 concurrency since MKLocalSearchCompletion
/// is not Sendable.
@MainActor
@Observable
final class PlaceSearchCompleter: NSObject {
    /// Search results displayed in the UI.
    var results: [PlaceResult] = []
    private var completer: MKLocalSearchCompleter?
    private var bridge: CompleterBridge?
    /// Snapshot of completions at the time results were last updated.
    private var completionSnapshot: [MKLocalSearchCompletion] = []

    struct PlaceResult: Identifiable {
        let id = UUID()
        let title: String
        let subtitle: String
        /// Index into the snapshot captured when this result was created.
        let index: Int
    }

    func search(query: String) {
        if completer == nil {
            let c = MKLocalSearchCompleter()
            c.resultTypes = [.address, .pointOfInterest]
            let b = CompleterBridge { [weak self] completions in
                Task { @MainActor in
                    guard let self else { return }
                    self.completionSnapshot = completions
                    self.results = completions.enumerated().map { i, c in
                        PlaceResult(title: c.title, subtitle: c.subtitle, index: i)
                    }
                }
            }
            c.delegate = b
            completer = c
            bridge = b
        }

        if query.trimmingCharacters(in: .whitespaces).isEmpty {
            results = []
            completionSnapshot = []
            return
        }
        completer?.queryFragment = query
    }

    /// Resolve a search result to coordinates using the captured snapshot.
    func resolve(_ result: PlaceResult) async -> MKMapItem? {
        guard let request = buildRequest(for: result) else { return nil }
        let search = MKLocalSearch(request: request)
        do {
            return try await search.start().mapItems.first
        } catch {
            log.debug("Failed to resolve place search result")
            return nil
        }
    }

    /// Build an MKLocalSearch.Request from the captured snapshot. Call synchronously
    /// BEFORE clearing results, since dismiss wipes the snapshot.
    func buildRequest(for result: PlaceResult) -> MKLocalSearch.Request? {
        guard result.index < completionSnapshot.count else { return nil }
        let completion = completionSnapshot[result.index]
        return MKLocalSearch.Request(completion: completion)
    }
}

/// NSObject delegate bridge that captures results in a closure.
/// Avoids Swift 6 Sendable issues by keeping MKLocalSearchCompletion on the same thread.
private class CompleterBridge: NSObject, MKLocalSearchCompleterDelegate {
    let onResults: ([MKLocalSearchCompletion]) -> Void

    init(onResults: @escaping ([MKLocalSearchCompletion]) -> Void) {
        self.onResults = onResults
    }

    func completerDidUpdateResults(_ completer: MKLocalSearchCompleter) {
        onResults(completer.results)
    }

    func completer(_ completer: MKLocalSearchCompleter, didFailWithError error: Error) {
        onResults([])
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
