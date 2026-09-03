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

/// Typed update for per-species dex metadata. `groupKey` is `DexEntry.id`, which the
/// server requires to match an existing entry so two spellings of one bird cannot
/// split their notes.
struct DexUpdate: Codable, Sendable {
    var groupKey: String
    var speciesName: String
    var notes: String?
}

enum PendingUploadSaveResult: Sendable {
  case synced
  case queued
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
    private var observationsBySpeciesKey: [String: [BirdObservation]] = [:]
    private var speciesCountByOutingID: [String: Int] = [:]
    private var outingsByID: [String: Outing] = [:]
    private var outingDateByID: [String: Date] = [:]
    private var dexEntryBySpeciesName: [String: DexEntry] = [:]
    /// Keyed by DexEntry.id, the code-or-name grouping key.
    private var dexEntryBySpeciesKey: [String: DexEntry] = [:]
    private var dexDateBySpeciesKey: [String: Date] = [:]
    private var recentOutingsByDate: [Outing] = []
    private var recentSpeciesByDate: [DexEntry] = []

    // MARK: - State

    var isLoading = false
    var error: AppError?
    private(set) var hasLoadedAll = false
    private(set) var cachedAt: Date?
    private(set) var activeAccountID: String?
    private(set) var refreshFailed = false
  private(set) var pendingUploads: [PendingUploadEntry] = []
  private(set) var isSyncingPendingUploads = false
  private(set) var pendingUploadError: AppError?
  private(set) var hasPendingUploadAccountTransfer = false
  private(set) var pendingUploadStoreUnavailable = false
    var hasReadableData: Bool { cachedAt != nil || hasLoadedAll }
    /// Stale data is only worth calling out once a refresh has actually failed.
    var isShowingCachedData: Bool { cachedAt != nil && !hasLoadedAll && refreshFailed }
  var pendingUploadCount: Int { pendingUploads.count }
  var pendingUploadsNeedAttention: Bool {
    pendingUploads.contains(where: \.requiresAttention)
  }
  var hasAccountDataAtRisk: Bool {
    !outings.isEmpty || !observations.isEmpty || !pendingUploads.isEmpty
  }
  var hasSyncablePendingUploads: Bool {
    pendingUploads.contains { $0.upload != nil }
  }
  var pendingUploadSafetyBlocked: Bool {
    pendingUploadStoreUnavailable || blocksPendingUploadSync
  }

  func containsPhoto(fileHash: String) -> Bool {
    photos.contains { $0.fileHash == fileHash }
      || pendingUploads.contains { entry in
        entry.upload?.photos.contains { $0.fileHash == fileHash } == true
      }
  }

    // MARK: - Dependencies

    private var service: (any DataStoreService)?
    private let serviceFactory: ((String) -> any DataStoreService)?
    private let cache: (any AccountDataCaching)?
  private let pendingUploadStore: (any PendingUploadStoring)?
  private let requiresPendingUploadStore: Bool
  private let defaults: UserDefaults
    private var generation = 0
    private var loadRequestID = UUID()
    private var confirmedSnapshot: AllDataResponse?
    private var initialLoadTask: Task<Void, Never>?
    private var initialLoadID: UUID?
    private var initialLoadAccountID: String?
    private var initialLoadGeneration: Int?
    private var operationInProgress = false
    private var operationWaiters: [OperationWaiter] = []
    private var outingDeletions: [String: OutingDeletion] = [:]
  private var pendingSyncTask: Task<Set<String>, Never>?
  private var pendingSyncID: UUID?
  private var pendingUploadArrivedDuringSync = false
  private var pendingUploadInFlightIDs = Set<String>()
  private var blocksPendingUploadSync = false
  private static let pendingUploadAccountTransferKey = "pendingUploadAccountTransfer"
  private static let confirmedAccountDeletionKey = "confirmedAccountDeletion"
  private static let blockedPendingUploadAccountsKey = "blockedPendingUploadAccounts"

  private struct PendingUploadAccountTransfer: Codable {
    let sourceAccountID: String
    let targetAccountID: String
  }

    private struct OperationWaiter {
        let id: UUID
        let continuation: CheckedContinuation<Void, Error>
    }

    private struct OutingDeletion {
        let id: UUID
        let task: Task<Void, Error>
    }

  init(
    service: any DataStoreService,
    cache: (any AccountDataCaching)? = nil,
    pendingUploadStore: (any PendingUploadStoring)? = nil,
    requiresPendingUploadStore: Bool = false,
    defaults: UserDefaults = .standard
  ) {
        self.service = service
        serviceFactory = nil
        self.cache = cache
    self.pendingUploadStore = pendingUploadStore
    self.requiresPendingUploadStore = requiresPendingUploadStore
    self.defaults = defaults
    pendingUploadStoreUnavailable = requiresPendingUploadStore && pendingUploadStore == nil
    }

    init(
        serviceFactory: @escaping (String) -> any DataStoreService,
    cache: (any AccountDataCaching)? = nil,
    pendingUploadStore: (any PendingUploadStoring)? = nil,
    requiresPendingUploadStore: Bool = false,
    defaults: UserDefaults = .standard
    ) {
        service = nil
        self.serviceFactory = serviceFactory
        self.cache = cache
    self.pendingUploadStore = pendingUploadStore
    self.requiresPendingUploadStore = requiresPendingUploadStore
    self.defaults = defaults
    pendingUploadStoreUnavailable = requiresPendingUploadStore && pendingUploadStore == nil
    }

    // MARK: - Fetch

    func ensureLoaded() async throws {
        if hasLoadedAll { return }
        guard let accountID = activeAccountID else { throw AuthError.notAuthenticated }
        let loadGeneration = generation

        let task: Task<Void, Never>
        let taskID: UUID
        if let initialLoadTask,
           let initialLoadID,
           initialLoadAccountID == accountID,
      initialLoadGeneration == loadGeneration
    {
            task = initialLoadTask
            taskID = initialLoadID
        } else {
            let newTaskID = UUID()
            let newTask = Task { @MainActor [weak self] in
                guard let self else { return }
                await self.loadAll()
            }
            initialLoadTask = newTask
            initialLoadID = newTaskID
            initialLoadAccountID = accountID
            initialLoadGeneration = loadGeneration
            task = newTask
            taskID = newTaskID
        }

        await task.value
        guard activeAccountID == accountID, generation == loadGeneration else {
            throw CancellationError()
        }
        if initialLoadID == taskID {
            initialLoadTask = nil
            initialLoadID = nil
            initialLoadAccountID = nil
            initialLoadGeneration = nil
        }
        guard hasLoadedAll else { throw error ?? AuthError.notAuthenticated }
    }

  func ensureReadableData() async throws {
    if hasReadableData { return }
    try await ensureLoaded()
  }

    /// Activate one account and hydrate its read-only cache synchronously.
    func activate(accountID: String) {
        guard activeAccountID != accountID else { return }
        reset()
        activeAccountID = accountID
        if let serviceFactory {
            service = serviceFactory(accountID)
        }
    do {
            try finishConfirmedAccountDeletionCleanup(accountID: accountID)
        } catch {
            pendingUploadError = .message(
              "WingDex couldn't finish removing uploads for the deleted account."
            )
            log.error("Failed to finish confirmed account deletion cleanup")
        }
        do {
            try finishPendingUploadAccountTransfer(targetAccountID: accountID)
      try finishPendingUploadReauthentication(targetAccountID: accountID)
    } catch {
      pendingUploadError = .message(
        "WingDex couldn't transfer uploads saved before this account was created."
      )
      log.error("Failed to finish pending upload account transfer")
    }
    blocksPendingUploadSync = isPendingUploadSyncBlocked(accountID: accountID)
    reloadPendingUploads(accountID: accountID)
    if blocksPendingUploadSync, pendingUploadError == nil {
      pendingUploadError = .message(
        "Saved uploads are paused because data deletion could not be confirmed."
      )
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
        _ = await loadAll(syncPendingUploadsAfterLoad: true)
    }

    private func loadAll(syncPendingUploadsAfterLoad: Bool) async -> Bool {
    guard let operationContext = try? await acquireOperationContext(requireLoadedSnapshot: false)
    else { return false }
        defer { releaseOperation(operationContext) }
        guard let accountID = activeAccountID, let service else { return false }
        let loadGeneration = generation
        let requestID = UUID()
        loadRequestID = requestID
        log.info("Loading all data...")
        isLoading = true
        error = nil
        var didInstallSnapshot = false
        do {
            let response = try await service.fetchAllData()
            guard generation == loadGeneration,
                activeAccountID == accountID,
                loadRequestID == requestID
            else { return false }
            install(response)
            confirmedSnapshot = response
            hasLoadedAll = true
            cachedAt = nil
            refreshFailed = false
            do {
                try cache?.replace(accountID: accountID, response: response, refreshedAt: .now)
            } catch {
                log.error("Failed to persist refreshed account cache")
            }
      log.info(
        "Loaded \(self.outings.count) outings, \(self.observations.count) observations, \(self.dex.count) dex entries"
      )
      didInstallSnapshot = true
        } catch {
            guard generation == loadGeneration,
                  activeAccountID == accountID,
                  loadRequestID == requestID
            else { return false }
            // A cancellation maps to nil and isn't a refresh failure.
            if let mappedError = AppError.map(error) {
                self.error = mappedError
                refreshFailed = true
                log.error("Failed to load account data")
            }
        }
        if syncPendingUploadsAfterLoad, !pendingUploads.isEmpty {
            Task { @MainActor [weak self] in
                await self?.syncPendingUploads()
            }
        }
        if generation == loadGeneration,
           activeAccountID == accountID,
      loadRequestID == requestID
    {
            isLoading = false
        }
    return didInstallSnapshot
    }

    /// Clear all account-owned state and invalidate in-flight bulk loads.
    func reset() {
        generation += 1
        outingDeletions.values.forEach { $0.task.cancel() }
        outingDeletions.removeAll()
    pendingSyncTask?.cancel()
    pendingSyncTask = nil
    pendingSyncID = nil
    pendingUploadArrivedDuringSync = false
    pendingUploadInFlightIDs = []
    blocksPendingUploadSync = false
        initialLoadTask?.cancel()
        initialLoadTask = nil
        initialLoadID = nil
        initialLoadAccountID = nil
        initialLoadGeneration = nil
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
        refreshFailed = false
    pendingUploads = []
    isSyncingPendingUploads = false
    pendingUploadError = nil
    hasPendingUploadAccountTransfer = false
    pendingUploadStoreUnavailable = requiresPendingUploadStore && pendingUploadStore == nil
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

  // MARK: - Pending uploads

  func savePhotoUpload(_ upload: PendingPhotoUpload) async throws -> PendingUploadSaveResult {
    guard upload.accountID == activeAccountID else { throw AuthError.notAuthenticated }
    guard !blocksPendingUploadSync else {
      throw AppError.message(
        "WingDex can't save another upload while data deletion is unresolved."
      )
    }
    guard !pendingUploadStoreUnavailable, let pendingUploadStore else {
      throw AppError.message("WingDex couldn't save this upload on your device.")
    }
    let syncWasInProgress = pendingSyncTask != nil
    do {
      try pendingUploadStore.enqueue(upload)
      guard reloadPendingUploads(accountID: upload.accountID) else {
        throw AppError.message("WingDex couldn't verify the saved upload.")
      }
      if syncWasInProgress {
        pendingUploadArrivedDuringSync = true
      }
    } catch {
      log.error("Failed to persist pending upload")
      throw AppError.message("WingDex couldn't save this upload on your device.")
    }

    let syncedIDs = await syncPendingUploads()
    return syncedIDs.contains(upload.id) ? .synced : .queued
  }

  @discardableResult
  func syncPendingUploads(retryAttention: Bool = false) async -> Set<String> {
    if let pendingSyncTask {
      return await pendingSyncTask.value
    }
    guard let accountID = activeAccountID,
      !pendingUploads.isEmpty,
      !blocksPendingUploadSync,
      !pendingUploadStoreUnavailable
    else { return [] }

    let syncGeneration = generation
    let syncID = UUID()
    let task = Task { @MainActor [weak self] in
      guard let self else { return Set<String>() }
      let syncedIDs = await self.performPendingUploadSync(
        accountID: accountID,
        syncGeneration: syncGeneration,
        retryAttention: retryAttention
      )
      if self.pendingSyncID == syncID {
        self.pendingSyncTask = nil
        self.pendingSyncID = nil
      }
      return syncedIDs
    }
    pendingSyncTask = task
    pendingSyncID = syncID
    return await task.value
  }

  func discardPendingUpload(id: String) async throws {
    guard !pendingUploadInFlightIDs.contains(id) else {
      throw AppError.message("Wait for the current upload attempt to finish before discarding it.")
    }
    await stopPendingUploadSync()
    guard let accountID = activeAccountID else { throw AuthError.notAuthenticated }
    guard let pendingUploadStore else {
      throw AppError.message("WingDex couldn't discard this saved upload.")
    }
    do {
      try pendingUploadStore.remove(id: id, accountID: accountID)
      guard reloadPendingUploads(accountID: accountID) else {
        throw AppError.message("WingDex couldn't verify the saved upload was discarded.")
      }
      if pendingUploads.isEmpty {
        pendingUploadError = nil
        setPendingUploadSyncBlocked(false, accountID: accountID)
        blocksPendingUploadSync = false
      }
    } catch {
      let discardError = AppError.message("WingDex couldn't discard this saved upload.")
      pendingUploadError = discardError
      log.error("Failed to discard pending upload")
      throw discardError
    }
  }

  func discardAllPendingUploads() async throws {
    guard pendingUploadInFlightIDs.isEmpty else {
      throw AppError.message(
        "Wait for the current upload attempt to finish before discarding saved uploads."
      )
    }
    await stopPendingUploadSync()
    guard let accountID = activeAccountID else { return }
    guard let pendingUploadStore else {
      if !requiresPendingUploadStore, pendingUploads.isEmpty { return }
      throw AppError.message("WingDex couldn't discard the saved uploads.")
    }
    do {
      try pendingUploadStore.clear(accountID: accountID)
      pendingUploads = []
      pendingUploadError = nil
      pendingUploadStoreUnavailable = false
      setPendingUploadSyncBlocked(false, accountID: accountID)
      blocksPendingUploadSync = false
    } catch {
      log.error("Failed to discard pending uploads")
      throw AppError.message("WingDex couldn't discard the saved uploads.")
    }
  }

  func applyAccountMerge(_ result: AccountMergeResult) throws {
    guard result.sourceUserId != result.targetUserId else { return }
    guard result.sourceUserId != "multiple" else {
      throw AppError.message("WingDex couldn't identify uploads from the merged account.")
    }
    rememberPendingUploadAccountTransfer(
      sourceAccountID: result.sourceUserId,
      targetAccountID: result.targetUserId
    )
    try finishPendingUploadAccountTransfer(targetAccountID: result.targetUserId)
  }

  func rememberPendingUploadsForReauthentication(accountID: String) {
    guard accountID == activeAccountID,
      pendingUploadStoreUnavailable || !pendingUploads.isEmpty
    else { return }
    defaults.set(accountID, forKey: PendingUploadRecoveryKeys.reauthenticationAccountID)
  }

  func retryPendingUploadAccountTransfer() throws {
    guard let activeAccountID else { throw AuthError.notAuthenticated }
    try finishPendingUploadAccountTransfer(targetAccountID: activeAccountID)
    try finishPendingUploadReauthentication(targetAccountID: activeAccountID)
  }

  func stopPendingUploadSync() async {
    guard let task = pendingSyncTask else { return }
    task.cancel()
    _ = await task.value
  }

  func isPendingUploadInFlight(id: String) -> Bool {
    pendingUploadInFlightIDs.contains(id)
  }

  func beginAccountDeletion() async throws {
    guard !pendingUploadStoreUnavailable else {
      throw AppError.message("WingDex couldn't open uploads saved on this device.")
    }
    guard let accountID = activeAccountID else { throw AuthError.notAuthenticated }
    guard pendingUploadInFlightIDs.isEmpty else {
      throw AppError.message(
        "Wait for the current upload attempt to finish before deleting your account."
      )
    }
    blocksPendingUploadSync = true
    if !pendingUploads.isEmpty {
      setPendingUploadSyncBlocked(true, accountID: accountID)
    }
    await stopPendingUploadSync()
  }

  func endAccountDeletion(after failure: Error? = nil) {
    if let failure,
      let activeAccountID,
      !accountDeletionFailureMayHaveCommitted(failure)
    {
      setPendingUploadSyncBlocked(false, accountID: activeAccountID)
    }
    refreshPendingUploadSyncBlock()
  }

  func markAccountDeletionConfirmed() throws {
    guard let activeAccountID else { throw AuthError.notAuthenticated }
    defaults.set(activeAccountID, forKey: Self.confirmedAccountDeletionKey)
  }

  func completeAccountDeletionCleanup() {
    defaults.removeObject(forKey: Self.confirmedAccountDeletionKey)
  }

  private func rememberPendingUploadAccountTransfer(
    sourceAccountID: String,
    targetAccountID: String
  ) {
    let transfer = PendingUploadAccountTransfer(
      sourceAccountID: sourceAccountID,
      targetAccountID: targetAccountID
    )
    if let data = try? JSONEncoder().encode(transfer) {
      defaults.set(data, forKey: Self.pendingUploadAccountTransferKey)
    }
    hasPendingUploadAccountTransfer = true
  }

  private func finishPendingUploadAccountTransfer(targetAccountID: String) throws {
    guard
      let data = defaults.data(forKey: Self.pendingUploadAccountTransferKey),
      let transfer = try? JSONDecoder().decode(PendingUploadAccountTransfer.self, from: data),
      transfer.targetAccountID == targetAccountID
    else {
      hasPendingUploadAccountTransfer = false
      return
    }
    hasPendingUploadAccountTransfer = true
    guard let pendingUploadStore else {
      throw AppError.message("WingDex couldn't open uploads saved on this device.")
    }
    if isPendingUploadSyncBlocked(accountID: transfer.sourceAccountID) {
      setPendingUploadSyncBlocked(true, accountID: transfer.targetAccountID)
      refreshPendingUploadSyncBlock()
    }
    try pendingUploadStore.reassign(
      from: transfer.sourceAccountID,
      to: transfer.targetAccountID
    )
    setPendingUploadSyncBlocked(false, accountID: transfer.sourceAccountID)
    refreshPendingUploadSyncBlock()
    defaults.removeObject(forKey: Self.pendingUploadAccountTransferKey)
    hasPendingUploadAccountTransfer = false
    if activeAccountID == transfer.sourceAccountID || activeAccountID == transfer.targetAccountID {
      reloadPendingUploads(accountID: transfer.targetAccountID)
    }
  }

  private func finishPendingUploadReauthentication(targetAccountID: String) throws {
    guard let sourceAccountID = defaults.string(
      forKey: PendingUploadRecoveryKeys.reauthenticationAccountID
    ) else { return }
    hasPendingUploadAccountTransfer = true
    guard sourceAccountID != targetAccountID else {
      defaults.removeObject(forKey: PendingUploadRecoveryKeys.reauthenticationAccountID)
      hasPendingUploadAccountTransfer =
        defaults.data(forKey: Self.pendingUploadAccountTransferKey) != nil
      return
    }
    guard let pendingUploadStore else {
      throw AppError.message("WingDex couldn't open uploads saved on this device.")
    }
    if isPendingUploadSyncBlocked(accountID: sourceAccountID) {
      setPendingUploadSyncBlocked(true, accountID: targetAccountID)
    }
    try pendingUploadStore.reassign(
      from: sourceAccountID,
      to: targetAccountID
    )
    setPendingUploadSyncBlocked(false, accountID: sourceAccountID)
    if activeAccountID == targetAccountID,
      !reloadPendingUploads(accountID: targetAccountID)
    {
      throw AppError.message("WingDex couldn't verify transferred uploads.")
    }
    defaults.removeObject(forKey: PendingUploadRecoveryKeys.reauthenticationAccountID)
    hasPendingUploadAccountTransfer =
      defaults.data(forKey: Self.pendingUploadAccountTransferKey) != nil
  }

  private func finishConfirmedAccountDeletionCleanup(accountID: String) throws {
    guard defaults.string(forKey: Self.confirmedAccountDeletionKey) == accountID else {
      return
    }
    guard let pendingUploadStore else {
      throw AppError.message("WingDex couldn't open uploads saved on this device.")
    }
    try pendingUploadStore.clear(accountID: accountID)
    pendingUploads = []
    pendingUploadInFlightIDs = []
    setPendingUploadSyncBlocked(false, accountID: accountID)
    defaults.removeObject(forKey: Self.confirmedAccountDeletionKey)
  }

  private func refreshPendingUploadSyncBlock() {
    guard let activeAccountID else {
      blocksPendingUploadSync = false
      return
    }
    blocksPendingUploadSync = isPendingUploadSyncBlocked(accountID: activeAccountID)
  }

  private func performPendingUploadSync(
    accountID: String,
    syncGeneration: Int,
    retryAttention: Bool
  ) async -> Set<String> {
    guard let service, let pendingUploadStore else { return [] }
    guard !Task.isCancelled,
      activeAccountID == accountID,
      generation == syncGeneration
    else { return [] }
    isSyncingPendingUploads = true
    pendingUploadError = nil
    defer {
      if activeAccountID == accountID, generation == syncGeneration {
        isSyncingPendingUploads = false
      }
    }

    var syncedIDs = Set<String>()
    var seenEntryIDs = Set<String>()
    repeat {
      pendingUploadArrivedDuringSync = false
      let entries = pendingUploads.filter { seenEntryIDs.insert($0.id).inserted }
      var submittedEntries: [PendingUploadEntry] = []
      var reconcilableFailures: [(id: String, message: String, requiresAttention: Bool)] = []
      for entry in entries {
        guard activeAccountID == accountID, generation == syncGeneration else { break }
        if entry.requiresAttention, !retryAttention { continue }
        guard let upload = entry.upload else { continue }
        let wasAwaitingConfirmation = entry.awaitingReconciliation
          || pendingUploadInFlightIDs.contains(entry.id)
        if !wasAwaitingConfirmation {
          do {
            try pendingUploadStore.markAwaitingReconciliation(
              id: entry.id,
              accountID: accountID
            )
          } catch {
            pendingUploadError = .message("WingDex couldn't update the saved upload.")
            log.error("Failed to protect pending upload before synchronization")
            break
          }
        }
        pendingUploadInFlightIDs.insert(entry.id)
        do {
          _ = try await service.submitPendingUpload(upload)
          guard activeAccountID == accountID, generation == syncGeneration else { break }
          submittedEntries.append(entry)
        } catch is CancellationError {
          break
        } catch {
          guard activeAccountID == accountID, generation == syncGeneration else { break }
          let failure = pendingUploadFailure(error)
          let failureMayHaveCommitted = mutationFailureMayHaveCommitted(error)
          let awaitingReconciliation = wasAwaitingConfirmation || failureMayHaveCommitted
          let canReconcileAfterRefresh =
            (error as? PendingUploadSubmissionError)?.canReconcileAfterRefresh == true
            || (wasAwaitingConfirmation && !failureMayHaveCommitted)
          pendingUploadError = failure.error
          do {
            try pendingUploadStore.markFailed(
              id: entry.id,
              accountID: accountID,
              message: failure.error.message,
              requiresAttention: failure.requiresAttention,
              awaitingReconciliation: awaitingReconciliation
            )
            if !awaitingReconciliation {
              pendingUploadInFlightIDs.remove(entry.id)
            }
            if canReconcileAfterRefresh {
              reconcilableFailures.append((
                id: entry.id,
                message: failure.error.message,
                requiresAttention: failure.requiresAttention
              ))
            }
          } catch {
            pendingUploadError = .message("WingDex couldn't update the saved upload.")
            log.error("Failed to persist pending upload failure")
          }
          if failure.stopsDrain { break }
        }
      }

      guard activeAccountID == accountID, generation == syncGeneration else {
        return syncedIDs
      }
      if (!submittedEntries.isEmpty || !reconcilableFailures.isEmpty),
         await loadAll(syncPendingUploadsAfterLoad: false)
      {
        guard activeAccountID == accountID, generation == syncGeneration else {
          return syncedIDs
        }
        for entry in submittedEntries {
          do {
            try pendingUploadStore.remove(id: entry.id, accountID: accountID)
            pendingUploadInFlightIDs.remove(entry.id)
            syncedIDs.insert(entry.id)
          } catch {
            pendingUploadError = .message("WingDex couldn't update the saved upload.")
            log.error("Failed to remove synchronized pending upload")
          }
        }
        for failure in reconcilableFailures {
          do {
            try pendingUploadStore.markFailed(
              id: failure.id,
              accountID: accountID,
              message: failure.message,
              requiresAttention: failure.requiresAttention,
              awaitingReconciliation: false
            )
            pendingUploadInFlightIDs.remove(failure.id)
          } catch {
            pendingUploadError = .message("WingDex couldn't update the saved upload.")
            log.error("Failed to reconcile pending upload failure")
          }
        }
      }
      reloadPendingUploads(accountID: accountID)
    } while pendingUploadArrivedDuringSync && !Task.isCancelled
    return syncedIDs
  }

  @discardableResult
  private func reloadPendingUploads(accountID: String) -> Bool {
    guard let pendingUploadStore else {
      pendingUploads = []
      if requiresPendingUploadStore {
        pendingUploadStoreUnavailable = true
        pendingUploadError = .message("WingDex couldn't open uploads saved on this device.")
      }
      return !requiresPendingUploadStore
    }
    do {
      pendingUploads = try pendingUploadStore.load(accountID: accountID)
      pendingUploadInFlightIDs = Set(
        pendingUploads.lazy
          .filter { $0.awaitingReconciliation && $0.upload != nil }
          .map(\.id)
      )
      pendingUploadStoreUnavailable = false
      return true
    } catch {
      pendingUploads = []
      pendingUploadStoreUnavailable = true
      pendingUploadError = .message("WingDex couldn't read saved uploads on this device.")
      log.error("Failed to load pending uploads")
      return false
    }
  }

  private func pendingUploadFailure(
    _ error: Error
  ) -> (error: AppError, requiresAttention: Bool, stopsDrain: Bool) {
    let error = (error as? PendingUploadSubmissionError)?.underlying ?? error
    let appError =
      AppError.map(error, fallback: "Could not sync this saved upload.")
      ?? .message("Could not sync this saved upload.")
    if let serviceError = error as? DataServiceError,
      case .http(let status, _, _, _) = serviceError
    {
      if status == 401 {
        return (appError, true, true)
      }
      if (400...499).contains(status), status != 408, status != 429 {
        return (appError, true, false)
      }
    }
    return (appError, false, true)
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
        dexDateBySpeciesKey[entry.id] ?? .distantPast
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
    ///
    /// Resolves through the dex entry when one exists, so a lookup by display
    /// name still finds sightings recorded under a different spelling of the
    /// same coded species.
    func sightings(for speciesName: String) -> [(observation: BirdObservation, outing: Outing)] {
        let key = dexEntryBySpeciesName[speciesName]?.id ?? "name:\(speciesName)"
        return sightings(byKey: key)
    }

    /// All sightings of a species identified by its dex grouping key.
    ///
    /// Two groups can share a display label, so callers that already hold the
    /// key (grouped outing rows) must resolve by key to avoid returning the
    /// wrong group's sightings.
    func sightings(byKey key: String) -> [(observation: BirdObservation, outing: Outing)] {
        let matches = (observationsBySpeciesKey[key] ?? [])
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

    /// Find a dex entry by its grouping key (DexEntry.id).
    ///
    /// Grouped outing rows carry the key, so they resolve here rather than by
    /// label, which two distinct groups can share.
    func dexEntry(byKey key: String) -> DexEntry? {
        dexEntryBySpeciesKey[key]
    }

    /// Search the server taxonomy for manual observation entry.
  func searchSpecies(query: String, limit: Int = 8) async throws -> [DataService
    .SpeciesSearchResult]
  {
        guard let service else { throw AuthError.notAuthenticated }
        return try await service.searchSpecies(query: query, limit: limit)
    }

    /// Download one outing in eBird Record CSV format.
    func exportOutingCSV(outingId: String) async throws -> Data {
        guard let service else { throw AuthError.notAuthenticated }
        return try await service.exportOutingCSV(outingId: outingId)
    }

    // MARK: - Mutations

    /// Delete an outing on the server, then remove its local data in one update.
    func deleteOuting(id: String) async throws {
        if let deletion = outingDeletions[id] {
            return try await deletion.task.value
        }

        let deletionID = UUID()
        let task = Task { @MainActor [weak self] in
            guard let self else { throw CancellationError() }
            try await self.performDeleteOuting(id: id)
        }
        outingDeletions[id] = OutingDeletion(id: deletionID, task: task)
        defer {
            if outingDeletions[id]?.id == deletionID {
                outingDeletions[id] = nil
            }
        }
        try await task.value
    }

    private func performDeleteOuting(id: String) async throws {
        let mutationContext = try await acquireOperationContext(requireLoadedSnapshot: true)
        defer { releaseOperation(mutationContext) }
        guard let service else { throw AuthError.notAuthenticated }
        guard outings.contains(where: { $0.id == id }) else { return }
        do {
            let response = try await service.deleteOuting(id: id)
            guard isCurrentMutation(mutationContext) else { throw CancellationError() }
            outings.removeAll { $0.id == id }
            observations.removeAll { $0.outingId == id }
            photos.removeAll { $0.outingId == id }
            dex = response.dexUpdates
            confirmAndPersistCurrentSnapshot()
        } catch {
            guard isCurrentMutation(mutationContext) else { throw CancellationError() }
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

    /// Update the per-species notes locally and on the server.
    func updateDexNotes(entry: DexEntry, notes: String) async throws {
        let mutationContext = try await acquireOperationContext(requireLoadedSnapshot: true)
        defer { releaseOperation(mutationContext) }
        guard let service else { throw AuthError.notAuthenticated }
        if let idx = dex.firstIndex(where: { $0.id == entry.id }) {
            dex[idx].notes = notes
        }
        do {
            let updates = try await service.updateDexEntry(
                fields: DexUpdate(groupKey: entry.id, speciesName: entry.speciesName, notes: notes)
            )
            guard isCurrentMutation(mutationContext) else { return }
            dex = updates
            confirmAndPersistCurrentSnapshot()
        } catch {
            guard isCurrentMutation(mutationContext) else { return }
            restoreConfirmedSnapshot()
            log.warning("Dex notes update failed; reconciling account data")
            reconcileAfterMutationFailure(mutationContext)
            throw error
        }
    }

    /// Clear all user data.
    func clearAll() async throws {
        guard !pendingUploadStoreUnavailable else {
            throw AppError.message("WingDex couldn't open uploads saved on this device.")
        }
        guard pendingUploadInFlightIDs.isEmpty else {
            throw AppError.message(
                "Wait for the current upload attempt to finish before deleting your data."
            )
        }
        let wasAlreadyBlocked = activeAccountID.map {
            isPendingUploadSyncBlocked(accountID: $0)
        } ?? blocksPendingUploadSync
        blocksPendingUploadSync = true
        await stopPendingUploadSync()
        var keepPendingUploadSyncBlocked = wasAlreadyBlocked
        defer {
            blocksPendingUploadSync = keepPendingUploadSyncBlocked
        }
        let mutationContext = try await acquireOperationContext(requireLoadedSnapshot: true)
        defer { releaseOperation(mutationContext) }
        guard let service else { throw AuthError.notAuthenticated }
        guard let accountID = activeAccountID else { throw AuthError.notAuthenticated }
        keepPendingUploadSyncBlocked = wasAlreadyBlocked || !pendingUploads.isEmpty
        if !pendingUploads.isEmpty {
            setPendingUploadSyncBlocked(true, accountID: accountID)
        }
        do {
            try await service.clearAllData()
        } catch {
            if !mutationFailureMayHaveCommitted(error), !wasAlreadyBlocked {
                setPendingUploadSyncBlocked(false, accountID: accountID)
                keepPendingUploadSyncBlocked = false
            }
            throw error
        }
        guard isCurrentMutation(mutationContext) else { return }
        outings = []
        photos = []
        observations = []
        dex = []
        confirmedSnapshot = AllDataResponse(outings: [], photos: [], observations: [], dex: [])
        try? cache?.clear(accountID: accountID)
      do {
        try pendingUploadStore?.clear(accountID: accountID)
        pendingUploads = []
        setPendingUploadSyncBlocked(false, accountID: accountID)
        keepPendingUploadSyncBlocked = false
      } catch {
        let cleanupError = AppError.message(
          "Your server data was deleted, but saved uploads could not be removed from this device."
        )
        pendingUploadError = cleanupError
        log.error("Failed to clear pending uploads after deleting server data")
        throw cleanupError
      }
    }

    private func accountDeletionFailureMayHaveCommitted(_ error: Error) -> Bool {
        if let serviceError = error as? DataServiceError,
           case .http(let status, _, _, _) = serviceError,
           status == 409 || status == 502 || status == 503 {
            return false
        }
        return mutationFailureMayHaveCommitted(error)
    }

    private func mutationFailureMayHaveCommitted(_ error: Error) -> Bool {
        if error is PendingUploadSubmissionError {
            return true
        }
        if let serviceError = error as? DataServiceError {
            switch serviceError {
            case .network(let urlError):
                return mutationFailureMayHaveCommitted(urlError)
            case .invalidResponse:
                return true
            case .http(let status, _, _, _):
                return !(400...499).contains(status)
            }
        }
        if let urlError = error as? URLError {
            switch urlError.code {
            case .notConnectedToInternet, .cannotConnectToHost, .cannotFindHost,
                 .dnsLookupFailed, .internationalRoamingOff:
                return false
            default:
                return true
            }
        }
        if error is AuthError {
            return false
        }
        return true
    }

    private func isPendingUploadSyncBlocked(accountID: String) -> Bool {
        defaults.stringArray(forKey: Self.blockedPendingUploadAccountsKey)?.contains(accountID) == true
    }

    private func setPendingUploadSyncBlocked(_ blocked: Bool, accountID: String) {
        var accountIDs = Set(
            defaults.stringArray(forKey: Self.blockedPendingUploadAccountsKey) ?? []
        )
        if blocked {
            accountIDs.insert(accountID)
        } else {
            accountIDs.remove(accountID)
        }
        if accountIDs.isEmpty {
            defaults.removeObject(forKey: Self.blockedPendingUploadAccountsKey)
        } else {
            defaults.set(accountIDs.sorted(), forKey: Self.blockedPendingUploadAccountsKey)
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
    recentOutingsByDate =
      datedOutings
            .sorted { $0.date > $1.date }
            .map(\.outing)
    }

    private func rebuildObservationDerivedData() {
    outingObservationsByID = Dictionary(
      grouping: observations.filter { $0.certainty != .rejected }, by: \.outingId)
    confirmedObservationsByOutingID = Dictionary(
      grouping: observations.filter { $0.certainty == .confirmed }, by: \.outingId)
    possibleObservationsByOutingID = Dictionary(
      grouping: observations.filter { $0.certainty == .possible }, by: \.outingId)
        // Index by the dex grouping key, not the display name. The server
        // combines two spellings of one bird into a single dex entry, so a
        // name-keyed index here would miss the sightings stored under the other
        // spelling and count one species twice.
        observationsBySpeciesKey = Dictionary(
            grouping: observations.filter { $0.certainty != .rejected },
            by: { dexGroupKey(speciesCode: $0.speciesCode, speciesName: $0.speciesName) })
        speciesCountByOutingID = confirmedObservationsByOutingID.mapValues {
            Set($0.map { dexGroupKey(speciesCode: $0.speciesCode, speciesName: $0.speciesName) }).count
        }
    }

    private func rebuildDexDerivedData() {
        let datedEntries = dex.map { (entry: $0, date: DateFormatting.sortDate($0.firstSeenDate)) }
    dexEntryBySpeciesName = Dictionary(
      dex.map { ($0.speciesName, $0) }, uniquingKeysWith: { _, latest in latest })
    dexEntryBySpeciesKey = Dictionary(
      dex.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
        // Keyed by DexEntry.id, not speciesName. DEX_QUERY can legitimately
        // return a coded and an uncoded group carrying the same MIN(speciesName),
        // and Dictionary(uniqueKeysWithValues:) TRAPS on a duplicate key, so
        // keying by name crashed the app on a valid rollout state.
    dexDateBySpeciesKey = Dictionary(
      datedEntries.map { ($0.entry.id, $0.date) },
                                         uniquingKeysWith: { _, latest in latest })
    recentSpeciesByDate =
      datedEntries
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
        try Task.checkCancellation()
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

/// Collapse repeat observations of one species on one outing into a single sighting.
///
/// Several photos of the same bird in one outing are stored as separate observations, which
/// would otherwise render as identical rows. Certainty is part of the key so a possible
/// sighting is never folded into a confirmed count. Input order is preserved.
func mergeSightingsByOuting(
    _ sightings: [(observation: BirdObservation, outing: Outing)]
) -> [(observation: BirdObservation, outing: Outing)] {
    var order: [String] = []
    var groups: [String: (observation: BirdObservation, outing: Outing)] = [:]
    for item in sightings {
        let key = "\(item.outing.id)|\(item.observation.certainty.rawValue)"
        if var existing = groups[key] {
            existing.observation.count += item.observation.count
            groups[key] = existing
        } else {
            order.append(key)
            groups[key] = item
        }
    }
    return order.compactMap { groups[$0] }
}
