import Foundation
import Observation
import os

private let log = Logger(subsystem: Config.bundleID, category: "DataStore")

/// Typed update for outing fields. Only non-nil fields are sent.
struct OutingUpdate: Codable, Sendable {
    var locationName: String?
    var defaultLocationName: String?
    var notes: String?
}

/// Central observable data store for the app.
///
/// Fetches all user data from `GET /api/data/all` and provides computed
/// properties and helpers that views bind to. This replaces the individual
/// stub ViewModels (HomeViewModel, OutingsViewModel, WingDexViewModel) with
/// a single source of truth, mirroring the web app's `WingDexDataStore`.
@MainActor
@Observable
final class DataStore {
    // MARK: - Raw Data

    var outings: [Outing] = [] {
        didSet { rebuildOutingDerivedData() }
    }
    var photos: [Photo] = []
    var observations: [BirdObservation] = [] {
        didSet { rebuildObservationDerivedData() }
    }
    var dex: [DexEntry] = [] {
        didSet { rebuildDexDerivedData() }
    }

    private var outingObservationsByID: [String: [BirdObservation]] = [:]
    private var confirmedObservationsByOutingID: [String: [BirdObservation]] = [:]
    private var possibleObservationsByOutingID: [String: [BirdObservation]] = [:]
    private var observationsBySpeciesName: [String: [BirdObservation]] = [:]
    private var speciesCountByOutingID: [String: Int] = [:]
    private var outingsByID: [String: Outing] = [:]
    private var outingDateByID: [String: Date] = [:]
    private var dexEntryBySpeciesName: [String: DexEntry] = [:]
    private var dexDateBySpeciesName: [String: Date] = [:]
    private var recentOutingsByDate: [Outing] = []
    private var recentSpeciesByDate: [DexEntry] = []

    // MARK: - State

    var isLoading = false
    var error: AppError?
    private(set) var hasLoadedAll = false
    private(set) var cachedAt: Date?
    private(set) var activeAccountID: String?
    var hasReadableData: Bool { cachedAt != nil || hasLoadedAll }
    var isShowingCachedData: Bool { cachedAt != nil && !hasLoadedAll }

    // MARK: - Dependencies

    private var service: (any DataStoreService)?
    private let serviceFactory: ((String) -> any DataStoreService)?
    private let cache: (any AccountDataCaching)?
    private var generation = 0
    private var loadRequestID = UUID()
    private var confirmedSnapshot: AllDataResponse?
    private var operationInProgress = false
    private var operationWaiters: [OperationWaiter] = []

    private struct OperationWaiter {
        let id: UUID
        let continuation: CheckedContinuation<Void, Error>
    }

    init(service: any DataStoreService, cache: (any AccountDataCaching)? = nil) {
        self.service = service
        serviceFactory = nil
        self.cache = cache
    }

    init(
        serviceFactory: @escaping (String) -> any DataStoreService,
        cache: (any AccountDataCaching)? = nil
    ) {
        service = nil
        self.serviceFactory = serviceFactory
        self.cache = cache
    }

    // MARK: - Fetch

    /// Activate one account and hydrate its read-only cache synchronously.
    func activate(accountID: String) {
        guard activeAccountID != accountID else { return }
        reset()
        activeAccountID = accountID
        if let serviceFactory {
            service = serviceFactory(accountID)
        }
        do {
            guard let snapshot = try cache?.load(accountID: accountID) else { return }
            install(snapshot.response)
            confirmedSnapshot = snapshot.response
            cachedAt = snapshot.refreshedAt
            log.info("Loaded cached account data")
        } catch {
            log.error("Failed to load cached account data; clearing the disposable cache")
            try? cache?.clear(accountID: accountID)
        }
    }

    /// Load all user data from the API. Called on app launch and pull-to-refresh.
    func loadAll() async {
        guard let operationContext = try? await acquireOperationContext(requireLoadedSnapshot: false) else { return }
        defer { releaseOperation(operationContext) }
        guard let accountID = activeAccountID, let service else { return }
        let loadGeneration = generation
        let requestID = UUID()
        loadRequestID = requestID
        log.info("Loading all data...")
        isLoading = true
        error = nil
        do {
            let response = try await service.fetchAllData()
            guard generation == loadGeneration,
                activeAccountID == accountID,
                loadRequestID == requestID
            else { return }
            install(response)
            confirmedSnapshot = response
            hasLoadedAll = true
            cachedAt = nil
            do {
                try cache?.replace(accountID: accountID, response: response, refreshedAt: .now)
            } catch {
                log.error("Failed to persist refreshed account cache")
            }
            log.info("Loaded \(self.outings.count) outings, \(self.observations.count) observations, \(self.dex.count) dex entries")
        } catch {
            guard generation == loadGeneration,
                  activeAccountID == accountID,
                  loadRequestID == requestID
            else { return }
            self.error = AppError.map(error)
            log.error("Failed to load account data")
        }
        if generation == loadGeneration,
           activeAccountID == accountID,
           loadRequestID == requestID {
            isLoading = false
        }
    }

    /// Clear all account-owned state and invalidate in-flight bulk loads.
    func reset() {
        generation += 1
        operationInProgress = false
        operationWaiters.forEach { $0.continuation.resume(throwing: CancellationError()) }
        operationWaiters.removeAll()
        outings = []
        photos = []
        observations = []
        dex = []
        isLoading = false
        error = nil
        hasLoadedAll = false
        cachedAt = nil
        activeAccountID = nil
        confirmedSnapshot = nil
        loadRequestID = UUID()
        if serviceFactory != nil {
            service = nil
        }
    }

    /// Clear the departing account from memory and persistent cache.
    func clearActiveAccount() {
        let accountID = activeAccountID
        reset()
        if let accountID {
            clearCachedAccount(accountID: accountID)
        }
    }

    func clearCachedAccount(accountID: String) {
        do {
            try cache?.clear(accountID: accountID)
        } catch {
            log.error("Failed to clear cached account data")
        }
    }

    // MARK: - Derived Data

    /// Observations for a specific outing, excluding rejected ones.
    func outingObservations(_ outingId: String) -> [BirdObservation] {
        outingObservationsByID[outingId] ?? []
    }

    /// Confirmed observations for a specific outing.
    func confirmedObservations(_ outingId: String) -> [BirdObservation] {
        confirmedObservationsByOutingID[outingId] ?? []
    }

    /// Possible observations for a specific outing.
    func possibleObservations(_ outingId: String) -> [BirdObservation] {
        possibleObservationsByOutingID[outingId] ?? []
    }

    /// Species count for an outing (confirmed only).
    func speciesCount(for outingId: String) -> Int {
        speciesCountByOutingID[outingId] ?? 0
    }

    func sortDate(for outing: Outing) -> Date {
        outingDateByID[outing.id] ?? .distantPast
    }

    func sortDate(for entry: DexEntry) -> Date {
        dexDateBySpeciesName[entry.speciesName] ?? .distantPast
    }

    /// Recent outings sorted by date descending, limited to `count`.
    func recentOutings(_ count: Int = 5) -> [Outing] {
        Array(recentOutingsByDate.prefix(count))
    }

    /// Recent species from the dex, sorted by firstSeenDate descending.
    func recentSpecies(_ count: Int = 6) -> [DexEntry] {
        Array(recentSpeciesByDate.prefix(count))
    }

    /// All sightings of a species across outings.
    func sightings(for speciesName: String) -> [(observation: BirdObservation, outing: Outing)] {
        let matches = (observationsBySpeciesName[speciesName] ?? [])
            .compactMap { observation -> (observation: BirdObservation, outing: Outing)? in
                guard let outing = outingsByID[observation.outingId] else { return nil }
                return (observation: observation, outing: outing)
            }
        return matches.sorted { sortDate(for: $0.outing) > sortDate(for: $1.outing) }
    }

    /// Find an outing by ID.
    func outing(id: String) -> Outing? {
        outingsByID[id]
    }

    /// Find a dex entry by species name.
    func dexEntry(for speciesName: String) -> DexEntry? {
        dexEntryBySpeciesName[speciesName]
    }

    /// Search the server taxonomy for manual observation entry.
    func searchSpecies(query: String, limit: Int = 8) async throws -> [DataService.SpeciesSearchResult] {
        guard let service else { throw AuthError.notAuthenticated }
        return try await service.searchSpecies(query: query, limit: limit)
    }

    /// Download one outing in eBird Record CSV format.
    func exportOutingCSV(outingId: String) async throws -> Data {
        guard let service else { throw AuthError.notAuthenticated }
        return try await service.exportOutingCSV(outingId: outingId)
    }

    // MARK: - Mutations

    /// Delete an outing and remove its observations locally, then sync with server.
    func deleteOuting(id: String) async throws {
        let mutationContext = try await acquireOperationContext(requireLoadedSnapshot: true)
        defer { releaseOperation(mutationContext) }
        guard let service else { throw AuthError.notAuthenticated }
        outings.removeAll { $0.id == id }
        observations.removeAll { $0.outingId == id }
        photos.removeAll { $0.outingId == id }
        do {
            let response = try await service.deleteOuting(id: id)
            guard isCurrentMutation(mutationContext) else { return }
            dex = response.dexUpdates
            confirmAndPersistCurrentSnapshot()
        } catch {
            guard isCurrentMutation(mutationContext) else { return }
            restoreConfirmedSnapshot()
            log.warning("Outing deletion failed; reconciling account data")
            reconcileAfterMutationFailure(mutationContext)
            throw error
        }
    }

    /// Mark observations as rejected (soft delete).
    func rejectObservations(ids: [String]) async throws {
        let mutationContext = try await acquireOperationContext(requireLoadedSnapshot: true)
        defer { releaseOperation(mutationContext) }
        guard let service else { throw AuthError.notAuthenticated }
        for i in observations.indices where ids.contains(observations[i].id) {
            observations[i].certainty = .rejected
        }
        do {
            let response = try await service.rejectObservations(ids: ids)
            guard isCurrentMutation(mutationContext) else { return }
            if let updated = response.observations {
                let updatedById = Dictionary(uniqueKeysWithValues: updated.map { ($0.id, $0) })
                observations = observations.map { updatedById[$0.id] ?? $0 }
            }
            if let dexUpdates = response.dexUpdates {
                dex = dexUpdates
            }
            confirmAndPersistCurrentSnapshot()
        } catch {
            guard isCurrentMutation(mutationContext) else { return }
            restoreConfirmedSnapshot()
            log.warning("Observation rejection failed; reconciling account data")
            reconcileAfterMutationFailure(mutationContext)
            throw error
        }
    }

    /// Add one observation and install the server's recomputed dex.
    func addObservation(_ observation: BirdObservation) async throws {
        let mutationContext = try await acquireOperationContext(requireLoadedSnapshot: true)
        defer { releaseOperation(mutationContext) }
        guard let service else { throw AuthError.notAuthenticated }
        observations.append(observation)
        do {
            let response = try await service.createObservations([observation])
            guard isCurrentMutation(mutationContext) else { return }
            if let created = response.observations {
                let createdById = Dictionary(uniqueKeysWithValues: created.map { ($0.id, $0) })
                observations = observations.map { createdById[$0.id] ?? $0 }
            }
            if let dexUpdates = response.dexUpdates {
                dex = dexUpdates
            }
            confirmAndPersistCurrentSnapshot()
        } catch {
            guard isCurrentMutation(mutationContext) else { return }
            restoreConfirmedSnapshot()
            log.warning("Observation creation failed; reconciling account data")
            reconcileAfterMutationFailure(mutationContext)
            throw error
        }
    }

    /// Update outing fields locally and on the server.
    func updateOuting(id: String, fields: OutingUpdate) async throws {
        let mutationContext = try await acquireOperationContext(requireLoadedSnapshot: true)
        defer { releaseOperation(mutationContext) }
        guard let service else { throw AuthError.notAuthenticated }
        if let idx = outings.firstIndex(where: { $0.id == id }) {
            let old = outings[idx]
            outings[idx] = Outing(
                id: old.id,
                userId: old.userId,
                startTime: old.startTime,
                endTime: old.endTime,
                locationName: fields.locationName ?? old.locationName,
                defaultLocationName: fields.defaultLocationName ?? old.defaultLocationName,
                lat: old.lat,
                lon: old.lon,
                stateProvince: old.stateProvince,
                countryCode: old.countryCode,
                protocol: old.protocol,
                numberObservers: old.numberObservers,
                allObsReported: old.allObsReported,
                effortDistanceMiles: old.effortDistanceMiles,
                effortAreaAcres: old.effortAreaAcres,
                notes: fields.notes ?? old.notes,
                createdAt: old.createdAt
            )
        }
        do {
            let updated = try await service.updateOuting(id: id, fields: fields)
            guard isCurrentMutation(mutationContext) else { return }
            if let idx = outings.firstIndex(where: { $0.id == id }) {
                outings[idx] = updated
            }
            confirmAndPersistCurrentSnapshot()
        } catch {
            guard isCurrentMutation(mutationContext) else { return }
            restoreConfirmedSnapshot()
            log.warning("Outing update failed; reconciling account data")
            reconcileAfterMutationFailure(mutationContext)
            throw error
        }
    }

    /// Clear all user data.
    func clearAll() async throws {
        let mutationContext = try await acquireOperationContext(requireLoadedSnapshot: true)
        defer { releaseOperation(mutationContext) }
        guard let service else { throw AuthError.notAuthenticated }
        let accountID = activeAccountID
        try await service.clearAllData()
        guard isCurrentMutation(mutationContext) else { return }
        outings = []
        photos = []
        observations = []
        dex = []
        confirmedSnapshot = AllDataResponse(outings: [], photos: [], observations: [], dex: [])
        if let accountID {
            try? cache?.clear(accountID: accountID)
        }
    }

    /// Load demo data by importing the bundled eBird CSV.
    func loadDemoData() async throws {
        let mutationContext = try await acquireOperationContext(requireLoadedSnapshot: true)
        defer { releaseOperation(mutationContext) }
        guard let service else { throw AuthError.notAuthenticated }
        guard let csvURL = Bundle.main.url(forResource: "demo-ebird-import", withExtension: "csv"),
              let csvData = try? Data(contentsOf: csvURL)
        else {
            throw AppError.message("Demo data isn't available in this build.")
        }

        do {
            try await service.clearAllData()
            guard isCurrentMutation(mutationContext) else { return }
            let previewIds = try await service.importEBirdCSV(csvData)
            guard isCurrentMutation(mutationContext) else { return }
            _ = try await service.confirmImport(previewIds: previewIds)
            guard isCurrentMutation(mutationContext) else { return }
            let response = try await service.fetchAllData()
            guard isCurrentMutation(mutationContext) else { return }
            install(response)
            hasLoadedAll = true
            cachedAt = nil
            confirmAndPersistCurrentSnapshot()
        } catch {
            guard isCurrentMutation(mutationContext) else { return }
            restoreConfirmedSnapshot()
            log.warning("Demo data load failed; reconciling account data")
            reconcileAfterMutationFailure(mutationContext)
            throw error
        }
    }

    private func install(_ response: AllDataResponse) {
        outings = response.outings
        photos = response.photos
        observations = response.observations
        dex = response.dex
    }

    private func rebuildOutingDerivedData() {
        let datedOutings = outings.map { (outing: $0, date: DateFormatting.sortDate($0.startTime)) }
        outingsByID = Dictionary(outings.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
        outingDateByID = Dictionary(uniqueKeysWithValues: datedOutings.map { ($0.outing.id, $0.date) })
        recentOutingsByDate = datedOutings
            .sorted { $0.date > $1.date }
            .map(\.outing)
    }

    private func rebuildObservationDerivedData() {
        outingObservationsByID = Dictionary(grouping: observations.filter { $0.certainty != .rejected }, by: \.outingId)
        confirmedObservationsByOutingID = Dictionary(grouping: observations.filter { $0.certainty == .confirmed }, by: \.outingId)
        possibleObservationsByOutingID = Dictionary(grouping: observations.filter { $0.certainty == .possible }, by: \.outingId)
        observationsBySpeciesName = Dictionary(grouping: observations.filter { $0.certainty != .rejected }, by: \.speciesName)
        speciesCountByOutingID = confirmedObservationsByOutingID.mapValues {
            Set($0.map(\.speciesName)).count
        }
    }

    private func rebuildDexDerivedData() {
        let datedEntries = dex.map { (entry: $0, date: DateFormatting.sortDate($0.firstSeenDate)) }
        dexEntryBySpeciesName = Dictionary(dex.map { ($0.speciesName, $0) }, uniquingKeysWith: { _, latest in latest })
        dexDateBySpeciesName = Dictionary(uniqueKeysWithValues: datedEntries.map { ($0.entry.speciesName, $0.date) })
        recentSpeciesByDate = datedEntries
            .sorted { $0.date > $1.date }
            .map(\.entry)
    }

    private func confirmAndPersistCurrentSnapshot() {
        guard let accountID = activeAccountID else { return }
        let snapshot = AllDataResponse(
            outings: outings,
            photos: photos,
            observations: observations,
            dex: dex
        )
        confirmedSnapshot = snapshot
        do {
            try cache?.replace(
                accountID: accountID,
                response: snapshot,
                refreshedAt: .now
            )
        } catch {
            log.error("Failed to persist server-confirmed account cache")
        }
    }

    private func restoreConfirmedSnapshot() {
        if let confirmedSnapshot {
            install(confirmedSnapshot)
        }
    }

    private func acquireOperationContext(
        requireLoadedSnapshot: Bool
    ) async throws -> (accountID: String, generation: Int) {
        guard let accountID = activeAccountID else { throw AuthError.notAuthenticated }
        let operationGeneration = generation
        if !operationInProgress {
            operationInProgress = true
        } else {
            try Task.checkCancellation()
            let waiterID = UUID()
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { continuation in
                    operationWaiters.append(OperationWaiter(id: waiterID, continuation: continuation))
                }
            } onCancel: {
                Task { @MainActor [weak self] in
                    self?.cancelOperationWaiter(id: waiterID)
                }
            }
        }
        do {
            try Task.checkCancellation()
        } catch {
            releaseOperation((accountID, operationGeneration))
            throw error
        }
        guard activeAccountID == accountID,
              generation == operationGeneration
        else {
            releaseOperation((accountID, operationGeneration))
            throw CancellationError()
        }
        if requireLoadedSnapshot {
            do {
                try requireServerSnapshot()
            } catch {
                releaseOperation((accountID, operationGeneration))
                throw error
            }
            loadRequestID = UUID()
            isLoading = false
        }
        return (accountID, operationGeneration)
    }

    private func releaseOperation(_ context: (accountID: String, generation: Int)) {
        guard generation == context.generation, activeAccountID == context.accountID else { return }
        if operationWaiters.isEmpty {
            operationInProgress = false
        } else {
            operationWaiters.removeFirst().continuation.resume()
        }
    }

    private func cancelOperationWaiter(id: UUID) {
        guard let index = operationWaiters.firstIndex(where: { $0.id == id }) else { return }
        operationWaiters.remove(at: index).continuation.resume(throwing: CancellationError())
    }

    private func isCurrentMutation(_ context: (accountID: String, generation: Int)) -> Bool {
        activeAccountID == context.accountID && generation == context.generation
    }

    private func reconcileAfterMutationFailure(_ context: (accountID: String, generation: Int)) {
        Task { @MainActor [weak self] in
            guard let self, self.isCurrentMutation(context) else { return }
            await self.loadAll()
        }
    }

    private func requireServerSnapshot() throws {
        guard hasLoadedAll else {
            throw AppError.message("Reconnect and refresh WingDex before making changes.")
        }
    }
}
