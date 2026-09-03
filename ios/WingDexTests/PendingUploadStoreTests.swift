import XCTest

@testable import WingDex

@MainActor
final class PendingUploadStoreTests: XCTestCase {
  func testQueuePersistsInFIFOOrderAcrossStoreRecreation() throws {
    let directory = FileManager.default.temporaryDirectory
      .appending(path: "pending-upload-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let storeURL = directory.appending(path: "queue.store")

    var store: PendingUploadStore? = try PendingUploadStore(storeURL: storeURL)
    try store?.enqueue(
      fixtureUpload(id: "later", accountID: "account-a", createdAt: Date(timeIntervalSince1970: 20))
    )
    try store?.enqueue(
      fixtureUpload(
        id: "earlier", accountID: "account-a", createdAt: Date(timeIntervalSince1970: 10)))
    try store?.markAwaitingReconciliation(id: "earlier", accountID: "account-a")
    store = nil

    let reopened = try PendingUploadStore(storeURL: storeURL)
    let entries = try reopened.load(accountID: "account-a")

    XCTAssertEqual(entries.map(\.id), ["earlier", "later"])
    XCTAssertEqual(entries.compactMap(\.upload).map(\.id), ["earlier", "later"])
    XCTAssertEqual(entries.map(\.awaitingReconciliation), [true, false])
  }

  func testQueueOperationsStayAccountScoped() throws {
    let store = try PendingUploadStore(isStoredInMemoryOnly: true)
    try store.enqueue(fixtureUpload(id: "a", accountID: "account-a"))
    try store.enqueue(fixtureUpload(id: "b", accountID: "account-b"))

    try store.clear(accountID: "account-a")

    XCTAssertTrue(try store.load(accountID: "account-a").isEmpty)
    XCTAssertEqual(try store.load(accountID: "account-b").map(\.id), ["b"])
  }

  func testFailureStatePersistsUntilRetryOrDiscard() throws {
    let store = try PendingUploadStore(isStoredInMemoryOnly: true)
    try store.enqueue(fixtureUpload(id: "upload", accountID: "account-a"))

    try store.markFailed(
      id: "upload",
      accountID: "account-a",
      message: "Outing conflict",
      requiresAttention: true,
      awaitingReconciliation: false
    )

    let entry = try XCTUnwrap(store.load(accountID: "account-a").first)
    XCTAssertEqual(entry.lastError, "Outing conflict")
    XCTAssertTrue(entry.requiresAttention)

    try store.remove(id: "upload", accountID: "account-a")
    XCTAssertTrue(try store.load(accountID: "account-a").isEmpty)
  }

  func testAccountMergeReassignsPayloadAndOutingOwner() throws {
    let store = try PendingUploadStore(isStoredInMemoryOnly: true)
    try store.enqueue(fixtureUpload(id: "upload", accountID: "anonymous"))

    try store.reassign(from: "anonymous", to: "registered")

    XCTAssertTrue(try store.load(accountID: "anonymous").isEmpty)
    let upload = try XCTUnwrap(store.load(accountID: "registered").first?.upload)
    XCTAssertEqual(upload.accountID, "registered")
    XCTAssertEqual(upload.outing?.userId, "registered")
  }

  func testAccountMergePromotesExistingOutingRecoverySnapshot() throws {
    let store = try PendingUploadStore(isStoredInMemoryOnly: true)
    try store.enqueue(
      fixtureUpload(id: "upload", accountID: "anonymous", usesExistingOuting: true)
    )

    let pending = try XCTUnwrap(store.load(accountID: "anonymous").first?.upload)
    XCTAssertNil(pending.outing)
    XCTAssertEqual(pending.outingRecoverySnapshot?.userId, "anonymous")

    try store.reassign(from: "anonymous", to: "registered")

    let reassigned = try XCTUnwrap(store.load(accountID: "registered").first?.upload)
    XCTAssertEqual(reassigned.outing?.userId, "registered")
    XCTAssertNil(reassigned.outingRecoverySnapshot)
  }

  func testAnonymousSessionInvalidationDurablyPreservesQueueOwner() throws {
    let suiteName = "PendingUploadStoreTests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    try queue.enqueue(fixtureUpload(id: "upload", accountID: "anonymous"))
    let auth = AuthService(defaults: defaults)
    auth.installUITestAnonymousIdentity(userID: "anonymous", sessionToken: "rejected-token")

    XCTAssertTrue(auth.invalidateSession(rejectedToken: "rejected-token"))
    XCTAssertEqual(
      defaults.string(forKey: PendingUploadRecoveryKeys.reauthenticationAccountID),
      "anonymous"
    )

    let relaunchedStore = DataStore(
      service: PendingUploadServiceStub(),
      pendingUploadStore: queue,
      defaults: defaults
    )
    relaunchedStore.activate(accountID: "registered")

    XCTAssertTrue(try queue.load(accountID: "anonymous").isEmpty)
    XCTAssertEqual(
      try queue.load(accountID: "registered").map(\.id),
      ["upload"]
    )
    XCTAssertNil(
      defaults.string(forKey: PendingUploadRecoveryKeys.reauthenticationAccountID)
    )
  }

  func testPendingPhotoHashesParticipateInDuplicateDetection() throws {
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    try queue.enqueue(fixtureUpload(id: "upload", accountID: "account-a"))
    let store = DataStore(service: PendingUploadServiceStub(), pendingUploadStore: queue)
    store.activate(accountID: "account-a")

    XCTAssertTrue(store.containsPhoto(fileHash: "hash-upload"))

    store.activate(accountID: "account-b")
    XCTAssertFalse(store.containsPhoto(fileHash: "hash-upload"))
  }
}

@MainActor
final class PendingUploadSyncTests: XCTestCase {
  func testTransientFailureRetainsStableUploadForRetry() async throws {
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    let service = PendingUploadServiceStub()
    service.uploadResults = [
      .failure(URLError(.notConnectedToInternet)),
      .success(.init(observations: [], dexUpdates: [])),
    ]
    let store = DataStore(service: service, pendingUploadStore: queue)
    store.activate(accountID: "account-a")
    await store.loadAll()
    let upload = fixtureUpload(id: "upload", accountID: "account-a")

    let firstResult = try await store.savePhotoUpload(upload)

    if case .queued = firstResult {
    } else {
      XCTFail("Expected the offline upload to remain queued")
    }
    XCTAssertEqual(store.pendingUploadCount, 1)
    XCTAssertEqual(service.submittedUploadIDs, ["upload"])

    await store.syncPendingUploads()

    XCTAssertEqual(service.submittedUploadIDs, ["upload", "upload"])
    XCTAssertEqual(store.pendingUploadCount, 0)
    XCTAssertGreaterThanOrEqual(service.fetchCount, 2)
  }

  func testPostEnqueueReloadFailureDoesNotReportSuccessfulSave() async throws {
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    let failingQueue = PostEnqueueLoadFailurePendingUploadStore(base: queue)
    let store = DataStore(
      service: PendingUploadServiceStub(),
      pendingUploadStore: failingQueue
    )
    store.activate(accountID: "account-a")

    do {
      _ = try await store.savePhotoUpload(
        fixtureUpload(id: "upload", accountID: "account-a"))
      XCTFail("Expected save verification to fail")
    } catch {
      XCTAssertEqual(
        AppError.map(error)?.message,
        "WingDex couldn't save this upload on your device."
      )
    }

    XCTAssertEqual(try queue.load(accountID: "account-a").map(\.id), ["upload"])
    XCTAssertTrue(store.pendingUploadStoreUnavailable)
  }

  func testFailureAfterPartialSubmissionRequiresReconciliation() async throws {
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    let service = PendingUploadServiceStub()
    service.uploadResults = [
      .failure(
        PendingUploadSubmissionError(
          underlying: URLError(.notConnectedToInternet)
        ))
    ]
    let store = DataStore(service: service, pendingUploadStore: queue)
    store.activate(accountID: "account-a")

    _ = try await store.savePhotoUpload(
      fixtureUpload(id: "upload", accountID: "account-a"))

    let entry = try XCTUnwrap(queue.load(accountID: "account-a").first)
    XCTAssertTrue(entry.awaitingReconciliation)
    XCTAssertTrue(store.isPendingUploadInFlight(id: "upload"))
    XCTAssertEqual(store.pendingUploadError, .offline)
  }

  func testDefiniteConflictAfterCommittedStageUnlocksAfterRefresh() async throws {
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    let service = PendingUploadServiceStub()
    service.uploadResults = [
      .failure(
        PendingUploadSubmissionError(
          underlying: DataServiceError.http(
            status: 409,
            message: "Photo ID conflict",
            retryAfter: nil,
            traceID: nil
          ),
          canReconcileAfterRefresh: true
        ))
    ]
    let store = DataStore(service: service, pendingUploadStore: queue)
    store.activate(accountID: "account-a")

    _ = try await store.savePhotoUpload(
      fixtureUpload(id: "upload", accountID: "account-a"))

    let entry = try XCTUnwrap(queue.load(accountID: "account-a").first)
    XCTAssertFalse(entry.awaitingReconciliation)
    XCTAssertTrue(entry.requiresAttention)
    XCTAssertFalse(store.isPendingUploadInFlight(id: "upload"))
    XCTAssertEqual(service.fetchCount, 1)
  }

  func testDefiniteRetryConflictUnlocksEarlierAmbiguousFailure() async throws {
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    let service = PendingUploadServiceStub()
    service.uploadResults = [
      .failure(
        DataServiceError.http(
          status: 500,
          message: nil,
          retryAfter: nil,
          traceID: nil
        )),
      .failure(
        DataServiceError.http(
          status: 409,
          message: "Photo ID conflict",
          retryAfter: nil,
          traceID: nil
        )),
    ]
    let store = DataStore(service: service, pendingUploadStore: queue)
    store.activate(accountID: "account-a")

    _ = try await store.savePhotoUpload(
      fixtureUpload(id: "upload", accountID: "account-a"))
    XCTAssertTrue(try XCTUnwrap(queue.load(accountID: "account-a").first).awaitingReconciliation)

    await store.syncPendingUploads()

    let entry = try XCTUnwrap(queue.load(accountID: "account-a").first)
    XCTAssertFalse(entry.awaitingReconciliation)
    XCTAssertTrue(entry.requiresAttention)
    XCTAssertFalse(store.isPendingUploadInFlight(id: "upload"))
    XCTAssertEqual(service.fetchCount, 1)
  }

  func testSuccessfulUploadRemainsQueuedUntilSnapshotRefreshSucceeds() async throws {
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    let service = PendingUploadServiceStub()
    let store = DataStore(service: service, pendingUploadStore: queue)
    store.activate(accountID: "account-a")
    await store.loadAll()
    service.fetchResult = .failure(URLError(.notConnectedToInternet))

    let result = try await store.savePhotoUpload(
      fixtureUpload(id: "upload", accountID: "account-a"))

    if case .queued = result {
    } else {
      XCTFail("Expected the upload to remain queued until refresh succeeds")
    }
    XCTAssertEqual(service.submittedUploadIDs, ["upload"])
    XCTAssertEqual(store.pendingUploadCount, 1)
    XCTAssertTrue(store.containsPhoto(fileHash: "hash-upload"))
    let awaitingEntry = try XCTUnwrap(queue.load(accountID: "account-a").first)
    XCTAssertEqual(awaitingEntry.id, "upload")
    XCTAssertTrue(awaitingEntry.awaitingReconciliation)

    let relaunchedStore = DataStore(
      service: service,
      pendingUploadStore: queue
    )
    relaunchedStore.activate(accountID: "account-a")
    XCTAssertTrue(relaunchedStore.containsPhoto(fileHash: "hash-upload"))

    service.fetchResult = .success(emptyResponse)
    await relaunchedStore.syncPendingUploads()

    XCTAssertEqual(service.submittedUploadIDs, ["upload", "upload"])
    XCTAssertEqual(relaunchedStore.pendingUploadCount, 0)
  }

  func testUploadArrivingDuringDrainGetsFollowUpWithoutRetryingFailure() async throws {
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    let service = PendingUploadServiceStub()
    service.uploadDelay = .milliseconds(100)
    service.uploadResults = [
      .failure(URLError(.notConnectedToInternet)),
      .success(.init(observations: [], dexUpdates: [])),
    ]
    let store = DataStore(service: service, pendingUploadStore: queue)
    store.activate(accountID: "account-a")
    await store.loadAll()

    let firstSave = Task {
      try await store.savePhotoUpload(
        fixtureUpload(id: "first", accountID: "account-a"))
    }
    for _ in 0..<100 where service.submittedUploadIDs.isEmpty {
      try await Task.sleep(for: .milliseconds(10))
    }

    let secondResult = try await store.savePhotoUpload(
      fixtureUpload(id: "second", accountID: "account-a"))
    let firstResult = try await firstSave.value

    if case .queued = firstResult {
    } else {
      XCTFail("Expected the failed upload to remain queued")
    }
    if case .synced = secondResult {
    } else {
      XCTFail("Expected the new upload to synchronize in the follow-up pass")
    }
    XCTAssertEqual(service.submittedUploadIDs, ["first", "second"])
    XCTAssertEqual(try queue.load(accountID: "account-a").map(\.id), ["first"])
  }

  func testKnownOfflineCachedSnapshotQueuesAfterEnqueueRetry() async throws {
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    let service = PendingUploadServiceStub()
    service.fetchResult = .failure(URLError(.notConnectedToInternet))
    let cache = PendingUploadCacheStub(
      snapshot: AccountDataSnapshot(
        response: emptyResponse,
        refreshedAt: .now
      ))
    let store = DataStore(
      service: service,
      cache: cache,
      pendingUploadStore: queue
    )
    store.activate(accountID: "account-a")
    await store.loadAll()

    let result = try await store.savePhotoUpload(
      fixtureUpload(id: "upload", accountID: "account-a"))

    if case .queued = result {
    } else {
      XCTFail("Expected a device-saved upload")
    }

    XCTAssertTrue(store.refreshFailed)
    XCTAssertEqual(store.pendingUploadCount, 1)
    XCTAssertEqual(service.submittedUploadIDs, ["upload"])
  }

  func testFailedRefreshStillTriggersPendingUploadRetry() async throws {
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    try queue.enqueue(fixtureUpload(id: "upload", accountID: "account-a"))
    let service = PendingUploadServiceStub()
    service.fetchResult = .failure(URLError(.notConnectedToInternet))
    let store = DataStore(service: service, pendingUploadStore: queue)
    store.activate(accountID: "account-a")

    await store.loadAll()
    for _ in 0..<100 where service.fetchCount < 2 {
      try await Task.sleep(for: .milliseconds(10))
    }

    XCTAssertEqual(service.submittedUploadIDs, ["upload"])
    XCTAssertEqual(service.fetchCount, 2)
    XCTAssertEqual(store.pendingUploadCount, 1)
  }

  func testClientConflictRequiresExplicitRetry() async throws {
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    let service = PendingUploadServiceStub()
    service.uploadResults = [
      .failure(
        DataServiceError.http(
          status: 409,
          message: "Outing conflict",
          retryAfter: nil,
          traceID: nil
        )),
      .success(.init(observations: [], dexUpdates: [])),
    ]
    let store = DataStore(service: service, pendingUploadStore: queue)
    store.activate(accountID: "account-a")
    await store.loadAll()

    _ = try await store.savePhotoUpload(fixtureUpload(id: "upload", accountID: "account-a"))

    XCTAssertTrue(store.pendingUploadsNeedAttention)
    await store.syncPendingUploads()
    XCTAssertEqual(service.submittedUploadIDs, ["upload"])

    await store.syncPendingUploads(retryAttention: true)

    XCTAssertEqual(service.submittedUploadIDs, ["upload", "upload"])
    XCTAssertEqual(store.pendingUploadCount, 0)
  }

  func testQueueNeverDispatchesForAnotherAccount() async throws {
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    try queue.enqueue(fixtureUpload(id: "account-a-upload", accountID: "account-a"))
    let service = PendingUploadServiceStub()
    let store = DataStore(service: service, pendingUploadStore: queue)

    store.activate(accountID: "account-b")
    await store.syncPendingUploads()

    XCTAssertTrue(service.submittedUploadIDs.isEmpty)
    XCTAssertEqual(store.pendingUploadCount, 0)

    store.activate(accountID: "account-a")
    await store.syncPendingUploads()

    XCTAssertEqual(service.submittedUploadIDs, ["account-a-upload"])
    XCTAssertEqual(store.pendingUploadCount, 0)
  }

  func testAccountChangeDuringUploadKeepsOriginalAccountRecord() async throws {
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    try queue.enqueue(fixtureUpload(id: "account-a-upload", accountID: "account-a"))
    let service = PendingUploadServiceStub()
    service.uploadDelay = .seconds(1)
    let store = DataStore(service: service, pendingUploadStore: queue)
    store.activate(accountID: "account-a")

    let syncTask = Task { await store.syncPendingUploads() }
    for _ in 0..<100 where service.submittedUploadIDs.isEmpty {
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTAssertEqual(service.submittedUploadIDs, ["account-a-upload"])

    store.activate(accountID: "account-b")
    _ = await syncTask.value

    XCTAssertEqual(try queue.load(accountID: "account-a").map(\.id), ["account-a-upload"])
    XCTAssertTrue(try queue.load(accountID: "account-b").isEmpty)
    XCTAssertEqual(store.activeAccountID, "account-b")
    XCTAssertEqual(store.pendingUploadCount, 0)
    XCTAssertFalse(store.isSyncingPendingUploads)
    XCTAssertNil(store.pendingUploadError)
  }

  func testClearingServerDataAlsoPurgesPendingUploads() async throws {
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    try queue.enqueue(fixtureUpload(id: "upload", accountID: "account-a"))
    let service = PendingUploadServiceStub()
    let store = DataStore(service: service, pendingUploadStore: queue)
    store.activate(accountID: "account-a")
    await store.loadAll()

    try await store.clearAll()

    XCTAssertEqual(service.clearCount, 1)
    XCTAssertTrue(try queue.load(accountID: "account-a").isEmpty)
    XCTAssertEqual(store.pendingUploadCount, 0)
  }

  func testClearFailureBeforeConnectionRestoresPendingUploadSync() async throws {
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    try queue.enqueue(fixtureUpload(id: "upload", accountID: "account-a"))
    let service = PendingUploadServiceStub()
    service.clearResult = .failure(URLError(.notConnectedToInternet))
    let store = DataStore(service: service, pendingUploadStore: queue)
    store.activate(accountID: "account-a")
    await store.loadAll()

    do {
      try await store.clearAll()
      XCTFail("Expected clear to fail")
    } catch {
      XCTAssertEqual((error as? URLError)?.code, .notConnectedToInternet)
    }
    await store.syncPendingUploads()

    XCTAssertEqual(service.submittedUploadIDs, ["upload"])
    XCTAssertTrue(try queue.load(accountID: "account-a").isEmpty)
  }

  func testAmbiguousClearFailureKeepsPendingUploadSyncBlocked() async throws {
    let suiteName = "PendingUploadSyncTests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    try queue.enqueue(fixtureUpload(id: "upload", accountID: "account-a"))
    let service = PendingUploadServiceStub()
    service.clearResult = .failure(URLError(.timedOut))
    let store = DataStore(service: service, pendingUploadStore: queue, defaults: defaults)
    store.activate(accountID: "account-a")
    await store.loadAll()

    do {
      try await store.clearAll()
      XCTFail("Expected clear to fail")
    } catch {
      XCTAssertEqual((error as? URLError)?.code, .timedOut)
    }
    await store.syncPendingUploads()

    XCTAssertTrue(service.submittedUploadIDs.isEmpty)
    XCTAssertEqual(try queue.load(accountID: "account-a").map(\.id), ["upload"])
  }

  func testAmbiguousDeletionBlockRejectsNewUploads() async throws {
    let suiteName = "PendingUploadSyncTests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    try queue.enqueue(fixtureUpload(id: "existing", accountID: "account-a"))
    let service = PendingUploadServiceStub()
    service.clearResult = .failure(URLError(.timedOut))
    let store = DataStore(
      service: service,
      pendingUploadStore: queue,
      defaults: defaults
    )
    store.activate(accountID: "account-a")
    await store.loadAll()
    try? await store.clearAll()

    do {
      _ = try await store.savePhotoUpload(
        fixtureUpload(id: "new", accountID: "account-a"))
      XCTFail("Expected unresolved deletion to reject the new upload")
    } catch {
      XCTAssertEqual(
        AppError.map(error)?.message,
        "WingDex can't save another upload while data deletion is unresolved."
      )
    }
    XCTAssertEqual(try queue.load(accountID: "account-a").map(\.id), ["existing"])
  }

  func testAmbiguousClearBlockSurvivesRelaunchUntilExplicitDiscard() async throws {
    let suiteName = "PendingUploadSyncTests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    try queue.enqueue(fixtureUpload(id: "upload", accountID: "account-a"))
    let clearService = PendingUploadServiceStub()
    clearService.clearResult = .failure(URLError(.timedOut))
    let firstStore = DataStore(
      service: clearService,
      pendingUploadStore: queue,
      defaults: defaults
    )
    firstStore.activate(accountID: "account-a")
    await firstStore.loadAll()

    do {
      try await firstStore.clearAll()
      XCTFail("Expected clear to fail")
    } catch {
      XCTAssertEqual((error as? URLError)?.code, .timedOut)
    }

    let blockedService = PendingUploadServiceStub()
    let relaunchedStore = DataStore(
      service: blockedService,
      pendingUploadStore: queue,
      defaults: defaults
    )
    relaunchedStore.activate(accountID: "account-a")
    await relaunchedStore.loadAll()
    await relaunchedStore.syncPendingUploads()

    XCTAssertTrue(blockedService.submittedUploadIDs.isEmpty)
    XCTAssertTrue(relaunchedStore.pendingUploadSafetyBlocked)

    try await relaunchedStore.discardAllPendingUploads()
    try queue.enqueue(fixtureUpload(id: "replacement", accountID: "account-a"))
    let resumedService = PendingUploadServiceStub()
    let resumedStore = DataStore(
      service: resumedService,
      pendingUploadStore: queue,
      defaults: defaults
    )
    resumedStore.activate(accountID: "account-a")
    await resumedStore.loadAll()
    await resumedStore.syncPendingUploads()

    XCTAssertEqual(resumedService.submittedUploadIDs, ["replacement"])
    XCTAssertFalse(resumedStore.pendingUploadSafetyBlocked)
  }

  func testBlockedAccountMergeImmediatelyBlocksActiveTarget() async throws {
    let suiteName = "PendingUploadSyncTests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    try queue.enqueue(fixtureUpload(id: "upload", accountID: "anonymous"))
    let clearService = PendingUploadServiceStub()
    clearService.clearResult = .failure(URLError(.timedOut))
    let sourceStore = DataStore(
      service: clearService,
      pendingUploadStore: queue,
      defaults: defaults
    )
    sourceStore.activate(accountID: "anonymous")
    await sourceStore.loadAll()
    do {
      try await sourceStore.clearAll()
      XCTFail("Expected clear to fail")
    } catch {
      XCTAssertEqual((error as? URLError)?.code, .timedOut)
    }

    let targetService = PendingUploadServiceStub()
    let targetStore = DataStore(
      service: targetService,
      pendingUploadStore: queue,
      defaults: defaults
    )
    targetStore.activate(accountID: "registered")
    try targetStore.applyAccountMerge(
      AccountMergeResult(
        sourceUserId: "anonymous",
        targetUserId: "registered",
        promoted: false,
        outings: 0,
        observations: 0,
        photos: 0
      )
    )
    await targetStore.syncPendingUploads()

    XCTAssertTrue(targetService.submittedUploadIDs.isEmpty)
    XCTAssertTrue(targetStore.pendingUploadSafetyBlocked)
    XCTAssertTrue(try queue.load(accountID: "anonymous").isEmpty)
    XCTAssertEqual(try queue.load(accountID: "registered").map(\.id), ["upload"])
  }

  func testExistingClearBlockSurvivesFailureBeforeDeleteRequest() async throws {
    let suiteName = "PendingUploadSyncTests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    try queue.enqueue(fixtureUpload(id: "upload", accountID: "account-a"))
    let clearService = PendingUploadServiceStub()
    clearService.clearResult = .failure(URLError(.timedOut))
    let firstStore = DataStore(
      service: clearService,
      pendingUploadStore: queue,
      defaults: defaults
    )
    firstStore.activate(accountID: "account-a")
    await firstStore.loadAll()
    do {
      try await firstStore.clearAll()
      XCTFail("Expected clear to fail")
    } catch {
      XCTAssertEqual((error as? URLError)?.code, .timedOut)
    }

    let offlineService = PendingUploadServiceStub()
    offlineService.fetchResult = .failure(URLError(.notConnectedToInternet))
    let relaunchedStore = DataStore(
      service: offlineService,
      cache: PendingUploadCacheStub(
        snapshot: AccountDataSnapshot(response: emptyResponse, refreshedAt: .now)
      ),
      pendingUploadStore: queue,
      defaults: defaults
    )
    relaunchedStore.activate(accountID: "account-a")
    await relaunchedStore.loadAll()
    do {
      try await relaunchedStore.clearAll()
      XCTFail("Expected clear to require a server snapshot")
    } catch {
      XCTAssertNotNil(AppError.map(error))
    }
    await relaunchedStore.syncPendingUploads()

    XCTAssertTrue(offlineService.submittedUploadIDs.isEmpty)
    XCTAssertTrue(relaunchedStore.pendingUploadSafetyBlocked)
    XCTAssertEqual(try queue.load(accountID: "account-a").map(\.id), ["upload"])
  }

  func testAccountDeletionBlocksSyncUntilQueueIsDiscarded() async throws {
    let suiteName = "PendingUploadSyncTests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    try queue.enqueue(fixtureUpload(id: "upload", accountID: "account-a"))
    let service = PendingUploadServiceStub()
    let store = DataStore(
      service: service,
      pendingUploadStore: queue,
      defaults: defaults
    )
    store.activate(accountID: "account-a")

    try await store.beginAccountDeletion()
    await store.syncPendingUploads()
    XCTAssertTrue(service.submittedUploadIDs.isEmpty)
    XCTAssertTrue(store.pendingUploadSafetyBlocked)
    try await store.discardAllPendingUploads()
    store.endAccountDeletion()
    XCTAssertFalse(store.pendingUploadSafetyBlocked)
  }

  func testDefiniteAccountDeletionFailureRestoresPendingUploadSync() async throws {
    let suiteName = "PendingUploadSyncTests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    try queue.enqueue(fixtureUpload(id: "upload", accountID: "account-a"))
    let service = PendingUploadServiceStub()
    let store = DataStore(
      service: service,
      pendingUploadStore: queue,
      defaults: defaults
    )
    store.activate(accountID: "account-a")

    try await store.beginAccountDeletion()
    store.endAccountDeletion(after: URLError(.notConnectedToInternet))
    await store.syncPendingUploads()

    XCTAssertEqual(service.submittedUploadIDs, ["upload"])
    XCTAssertFalse(store.pendingUploadSafetyBlocked)
  }

  func testAmbiguousAccountDeletionFailureKeepsPendingUploadSyncBlocked() async throws {
    let suiteName = "PendingUploadSyncTests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    try queue.enqueue(fixtureUpload(id: "upload", accountID: "account-a"))
    let service = PendingUploadServiceStub()
    let store = DataStore(
      service: service,
      pendingUploadStore: queue,
      defaults: defaults
    )
    store.activate(accountID: "account-a")

    try await store.beginAccountDeletion()
    store.endAccountDeletion(after: URLError(.timedOut))
    await store.syncPendingUploads()

    XCTAssertTrue(service.submittedUploadIDs.isEmpty)
    XCTAssertTrue(store.pendingUploadSafetyBlocked)
    XCTAssertEqual(try queue.load(accountID: "account-a").map(\.id), ["upload"])
  }

  func testProviderRevocationFailureRestoresPendingUploadSync() async throws {
    let suiteName = "PendingUploadSyncTests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    try queue.enqueue(fixtureUpload(id: "upload", accountID: "account-a"))
    let service = PendingUploadServiceStub()
    let store = DataStore(
      service: service,
      pendingUploadStore: queue,
      defaults: defaults
    )
    store.activate(accountID: "account-a")

    try await store.beginAccountDeletion()
    store.endAccountDeletion(
      after: DataServiceError.http(
        status: 502,
        message: "Account deletion failed",
        retryAfter: nil,
        traceID: nil
      ))
    await store.syncPendingUploads()

    XCTAssertEqual(service.submittedUploadIDs, ["upload"])
    XCTAssertFalse(store.pendingUploadSafetyBlocked)
  }

  func testServerAccountDeletionFailureKeepsPendingUploadSyncBlocked() async throws {
    let suiteName = "PendingUploadSyncTests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    try queue.enqueue(fixtureUpload(id: "upload", accountID: "account-a"))
    let service = PendingUploadServiceStub()
    let store = DataStore(
      service: service,
      pendingUploadStore: queue,
      defaults: defaults
    )
    store.activate(accountID: "account-a")

    try await store.beginAccountDeletion()
    store.endAccountDeletion(
      after: DataServiceError.http(
        status: 500,
        message: "Account deletion failed",
        retryAfter: nil,
        traceID: nil
      ))
    await store.syncPendingUploads()

    XCTAssertTrue(service.submittedUploadIDs.isEmpty)
    XCTAssertTrue(store.pendingUploadSafetyBlocked)
    XCTAssertEqual(try queue.load(accountID: "account-a").map(\.id), ["upload"])
  }

  func testConfirmedAccountDeletionCleanupFinishesAfterRelaunch() async throws {
    let suiteName = "PendingUploadSyncTests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    try queue.enqueue(fixtureUpload(id: "upload", accountID: "account-a"))
    let store = DataStore(
      service: PendingUploadServiceStub(),
      pendingUploadStore: queue,
      defaults: defaults
    )
    store.activate(accountID: "account-a")
    try await store.beginAccountDeletion()
    try store.markAccountDeletionConfirmed()

    let relaunchedStore = DataStore(
      service: PendingUploadServiceStub(),
      pendingUploadStore: queue,
      defaults: defaults
    )
    relaunchedStore.activate(accountID: "account-a")

    XCTAssertTrue(try queue.load(accountID: "account-a").isEmpty)
    XCTAssertEqual(relaunchedStore.pendingUploadCount, 0)
    XCTAssertFalse(relaunchedStore.pendingUploadSafetyBlocked)
  }

  func testConfirmedAccountDeletionCleanupRetriesAfterLocalClearFailure() async throws {
    let suiteName = "PendingUploadSyncTests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    try queue.enqueue(fixtureUpload(id: "upload", accountID: "account-a"))
    let store = DataStore(
      service: PendingUploadServiceStub(),
      pendingUploadStore: ClearFailurePendingUploadStore(base: queue),
      defaults: defaults
    )
    store.activate(accountID: "account-a")
    try await store.beginAccountDeletion()
    try store.markAccountDeletionConfirmed()

    do {
      try await store.discardAllPendingUploads()
      XCTFail("Expected local cleanup to fail")
    } catch {
      store.endAccountDeletion(after: error)
    }

    XCTAssertEqual(try queue.load(accountID: "account-a").map(\.id), ["upload"])
    XCTAssertTrue(store.pendingUploadSafetyBlocked)

    let relaunchedStore = DataStore(
      service: PendingUploadServiceStub(),
      pendingUploadStore: queue,
      defaults: defaults
    )
    relaunchedStore.activate(accountID: "account-a")

    XCTAssertTrue(try queue.load(accountID: "account-a").isEmpty)
    XCTAssertFalse(relaunchedStore.pendingUploadSafetyBlocked)
  }

  func testRequiredQueueStoreFailureBlocksDestructiveActions() async throws {
    let service = PendingUploadServiceStub()
    let store = DataStore(service: service, requiresPendingUploadStore: true)
    store.activate(accountID: "account-a")
    await store.loadAll()

    XCTAssertTrue(store.pendingUploadStoreUnavailable)
    do {
      try await store.clearAll()
      XCTFail("Expected clear to fail")
    } catch {
      XCTAssertEqual(
        AppError.map(error)?.message,
        "WingDex couldn't open uploads saved on this device."
      )
    }
    do {
      try await store.discardAllPendingUploads()
      XCTFail("Expected discard to fail")
    } catch {
      XCTAssertEqual(
        AppError.map(error)?.message,
        "WingDex couldn't discard the saved uploads."
      )
    }
    XCTAssertEqual(service.clearCount, 0)
  }

  func testDiscardFailureThrowsAndKeepsPendingEntry() async throws {
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    try queue.enqueue(fixtureUpload(id: "upload", accountID: "account-a"))
    let failingQueue = RemoveFailurePendingUploadStore(base: queue)
    let store = DataStore(
      service: PendingUploadServiceStub(),
      pendingUploadStore: failingQueue
    )
    store.activate(accountID: "account-a")

    do {
      try await store.discardPendingUpload(id: "upload")
      XCTFail("Expected discard to fail")
    } catch {
      XCTAssertEqual(
        AppError.map(error)?.message,
        "WingDex couldn't discard this saved upload."
      )
    }

    XCTAssertEqual(store.pendingUploads.map(\.id), ["upload"])
    XCTAssertEqual(try queue.load(accountID: "account-a").map(\.id), ["upload"])
  }

  func testDiscardingLastUploadClearsOfflineErrorForNextSave() async throws {
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    let service = PendingUploadServiceStub()
    service.uploadResults = [
      .failure(URLError(.notConnectedToInternet)),
      .success(.init(observations: [], dexUpdates: [])),
    ]
    let store = DataStore(service: service, pendingUploadStore: queue)
    store.activate(accountID: "account-a")
    await store.loadAll()

    _ = try await store.savePhotoUpload(
      fixtureUpload(id: "offline", accountID: "account-a"))
    XCTAssertEqual(store.pendingUploadError, .offline)

    try await store.discardPendingUpload(id: "offline")

    XCTAssertNil(store.pendingUploadError)
    let result = try await store.savePhotoUpload(
      fixtureUpload(id: "online", accountID: "account-a"))

    if case .synced = result {
    } else {
      XCTFail("Expected the next upload to synchronize")
    }
    XCTAssertEqual(service.submittedUploadIDs, ["offline", "online"])
  }

  func testDiscardDuringSyncCancelsBeforeRemovingRecord() async throws {
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    try queue.enqueue(fixtureUpload(id: "first", accountID: "account-a"))
    try queue.enqueue(fixtureUpload(id: "second", accountID: "account-a"))
    let service = PendingUploadServiceStub()
    service.uploadDelay = .seconds(1)
    let store = DataStore(service: service, pendingUploadStore: queue)
    store.activate(accountID: "account-a")

    let syncTask = Task { await store.syncPendingUploads() }
    for _ in 0..<100 where service.submittedUploadIDs.isEmpty {
      try await Task.sleep(for: .milliseconds(10))
    }
    try await store.discardPendingUpload(id: "second")
    _ = await syncTask.value

    XCTAssertEqual(service.submittedUploadIDs, ["first"])
    XCTAssertEqual(try queue.load(accountID: "account-a").map(\.id), ["first"])
  }

  func testCannotDiscardUploadWhileItsRequestIsInFlight() async throws {
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    try queue.enqueue(fixtureUpload(id: "upload", accountID: "account-a"))
    let service = PendingUploadServiceStub()
    service.uploadDelay = .milliseconds(200)
    let store = DataStore(service: service, pendingUploadStore: queue)
    store.activate(accountID: "account-a")

    let syncTask = Task { await store.syncPendingUploads() }
    for _ in 0..<100 where service.submittedUploadIDs.isEmpty {
      try await Task.sleep(for: .milliseconds(10))
    }

    do {
      try await store.discardPendingUpload(id: "upload")
      XCTFail("Expected discard to wait for the active request")
    } catch {
      XCTAssertEqual(
        AppError.map(error)?.message,
        "Wait for the current upload attempt to finish before discarding it."
      )
    }

    _ = await syncTask.value
    XCTAssertEqual(service.submittedUploadIDs, ["upload"])
    XCTAssertTrue(try queue.load(accountID: "account-a").isEmpty)
  }

  func testCannotDiscardCommittedUploadDuringSnapshotReconciliation() async throws {
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    try queue.enqueue(fixtureUpload(id: "upload", accountID: "account-a"))
    let service = PendingUploadServiceStub()
    service.fetchDelay = .milliseconds(200)
    let store = DataStore(service: service, pendingUploadStore: queue)
    store.activate(accountID: "account-a")

    let syncTask = Task { await store.syncPendingUploads() }
    for _ in 0..<100 where service.fetchCount == 0 {
      try await Task.sleep(for: .milliseconds(10))
    }

    do {
      try await store.discardPendingUpload(id: "upload")
      XCTFail("Expected discard to wait for snapshot reconciliation")
    } catch {
      XCTAssertEqual(
        AppError.map(error)?.message,
        "Wait for the current upload attempt to finish before discarding it."
      )
    }

    _ = await syncTask.value
    XCTAssertTrue(try queue.load(accountID: "account-a").isEmpty)
  }

  func testCommittedUploadRemainsNonDiscardableAfterStoreRecreation() async throws {
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    try queue.enqueue(fixtureUpload(id: "upload", accountID: "account-a"))
    let service = PendingUploadServiceStub()
    service.fetchResult = .failure(URLError(.notConnectedToInternet))
    let firstStore = DataStore(service: service, pendingUploadStore: queue)
    firstStore.activate(accountID: "account-a")

    await firstStore.syncPendingUploads()

    XCTAssertTrue(try XCTUnwrap(queue.load(accountID: "account-a").first).awaitingReconciliation)
    let restoredStore = DataStore(service: service, pendingUploadStore: queue)
    restoredStore.activate(accountID: "account-a")
    XCTAssertTrue(restoredStore.isPendingUploadInFlight(id: "upload"))
    do {
      try await restoredStore.discardPendingUpload(id: "upload")
      XCTFail("Expected discard to require snapshot reconciliation")
    } catch {
      XCTAssertEqual(
        AppError.map(error)?.message,
        "Wait for the current upload attempt to finish before discarding it."
      )
    }

    service.fetchResult = .success(emptyResponse)
    await restoredStore.syncPendingUploads()
    XCTAssertTrue(try queue.load(accountID: "account-a").isEmpty)
  }

  func testUnreadableReconciliationRecordRemainsDiscardable() async throws {
    let queue = UnreadablePendingUploadStore(accountID: "account-a")
    let store = DataStore(
      service: PendingUploadServiceStub(),
      pendingUploadStore: queue
    )
    store.activate(accountID: "account-a")

    XCTAssertFalse(store.isPendingUploadInFlight(id: "unreadable"))
    XCTAssertFalse(store.hasSyncablePendingUploads)
    try await store.discardPendingUpload(id: "unreadable")

    XCTAssertTrue(store.pendingUploads.isEmpty)
  }

  func testFailedAccountTransferRetriesAfterStoreRecreation() throws {
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    try queue.enqueue(fixtureUpload(id: "upload", accountID: "anonymous"))
    let result = AccountMergeResult(
      sourceUserId: "anonymous",
      targetUserId: "registered",
      promoted: false,
      outings: 0,
      observations: 0,
      photos: 0
    )
    let unavailableStore = DataStore(service: PendingUploadServiceStub())

    XCTAssertThrowsError(try unavailableStore.applyAccountMerge(result))
    XCTAssertTrue(unavailableStore.hasPendingUploadAccountTransfer)

    let restoredStore = DataStore(
      service: PendingUploadServiceStub(),
      pendingUploadStore: queue
    )
    restoredStore.activate(accountID: "registered")

    XCTAssertFalse(restoredStore.hasPendingUploadAccountTransfer)
    XCTAssertTrue(try queue.load(accountID: "anonymous").isEmpty)
    XCTAssertEqual(try queue.load(accountID: "registered").map(\.id), ["upload"])
  }

  func testUnexpectedSessionLossTransfersQueueAfterReauthentication() throws {
    let suiteName = "PendingUploadSyncTests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    try queue.enqueue(fixtureUpload(id: "upload", accountID: "expired-anonymous"))
    let sourceStore = DataStore(
      service: PendingUploadServiceStub(),
      pendingUploadStore: queue,
      defaults: defaults
    )
    sourceStore.activate(accountID: "expired-anonymous")
    XCTAssertTrue(sourceStore.hasAccountDataAtRisk)

    sourceStore.rememberPendingUploadsForReauthentication(
      accountID: "expired-anonymous"
    )
    sourceStore.clearActiveAccount()

    let restoredStore = DataStore(
      service: PendingUploadServiceStub(),
      pendingUploadStore: queue,
      defaults: defaults
    )
    restoredStore.activate(accountID: "new-account")

    XCTAssertTrue(try queue.load(accountID: "expired-anonymous").isEmpty)
    let upload = try XCTUnwrap(queue.load(accountID: "new-account").first?.upload)
    XCTAssertEqual(upload.accountID, "new-account")
    XCTAssertEqual(upload.outing?.userId, "new-account")
    XCTAssertFalse(restoredStore.hasPendingUploadAccountTransfer)
  }

  func testRetriedReauthenticationTransferReloadsActiveQueue() throws {
    let suiteName = "PendingUploadSyncTests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    try queue.enqueue(fixtureUpload(id: "upload", accountID: "expired-anonymous"))
    let sourceStore = DataStore(
      service: PendingUploadServiceStub(),
      pendingUploadStore: queue,
      defaults: defaults
    )
    sourceStore.activate(accountID: "expired-anonymous")
    sourceStore.rememberPendingUploadsForReauthentication(
      accountID: "expired-anonymous"
    )
    sourceStore.clearActiveAccount()
    let failingQueue = FailOnceReassignPendingUploadStore(base: queue)
    let targetStore = DataStore(
      service: PendingUploadServiceStub(),
      pendingUploadStore: failingQueue,
      defaults: defaults
    )
    targetStore.activate(accountID: "new-account")
    XCTAssertTrue(targetStore.hasPendingUploadAccountTransfer)
    XCTAssertEqual(targetStore.pendingUploadCount, 0)

    try targetStore.retryPendingUploadAccountTransfer()

    XCTAssertFalse(targetStore.hasPendingUploadAccountTransfer)
    XCTAssertEqual(targetStore.pendingUploads.map(\.id), ["upload"])
  }
}

@MainActor
final class OfflinePhotoFlowTests: XCTestCase {
  func testCachedPhotoFlowCompletesWithDeviceSavedUpload() async throws {
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    let service = PendingUploadServiceStub()
    service.fetchResult = .failure(URLError(.notConnectedToInternet))
    service.uploadResults = [.failure(URLError(.notConnectedToInternet))]
    let response = responseWithOuting(accountID: "account-a")
    let store = DataStore(
      service: service,
      cache: PendingUploadCacheStub(
        snapshot: AccountDataSnapshot(
          response: response,
          refreshedAt: .now
        )),
      pendingUploadStore: queue
    )
    store.activate(accountID: "account-a")
    await store.loadAll()
    let viewModel = configuredPhotoViewModel(store: store, accountID: "account-a")

    viewModel.confirmCurrentPhoto(
      species: "American Robin",
      confidence: 0.9,
      status: .confirmed,
      count: 1
    )
    try await waitForCompletion(viewModel)

    XCTAssertEqual(viewModel.currentStep, .done)
    XCTAssertEqual(viewModel.queuedUploadCount, 1)
    XCTAssertEqual(store.pendingUploadCount, 1)
    let queued = try XCTUnwrap(store.pendingUploads.first?.upload)
    XCTAssertNil(queued.outing)
    XCTAssertEqual(queued.outingRecoverySnapshot?.id, "existing-outing")
    XCTAssertEqual(queued.outingRecoverySnapshot?.userId, "account-a")
    XCTAssertEqual(queued.photos.map(\.id), ["photo"])
    XCTAssertEqual(queued.observations.map(\.speciesName), ["American Robin"])

    service.fetchResult = .success(response)
    await store.syncPendingUploads()

    XCTAssertEqual(viewModel.queuedUploadCount, 0)
    XCTAssertEqual(store.pendingUploadCount, 0)
  }

  func testOnlinePhotoFlowKeepsImmediateSaveBehavior() async throws {
    let queue = try PendingUploadStore(isStoredInMemoryOnly: true)
    let service = PendingUploadServiceStub()
    service.fetchResult = .success(responseWithOuting(accountID: "account-a"))
    service.uploadResults = [.success(.init(observations: [], dexUpdates: []))]
    let store = DataStore(service: service, pendingUploadStore: queue)
    store.activate(accountID: "account-a")
    await store.loadAll()
    let viewModel = configuredPhotoViewModel(store: store, accountID: "account-a")

    viewModel.confirmCurrentPhoto(
      species: "American Robin",
      confidence: 0.9,
      status: .confirmed,
      count: 1
    )
    try await waitForCompletion(viewModel)

    XCTAssertEqual(viewModel.currentStep, .done)
    XCTAssertEqual(viewModel.queuedUploadCount, 0)
    XCTAssertEqual(store.pendingUploadCount, 0)
    XCTAssertEqual(service.submittedUploadIDs.count, 1)
    XCTAssertTrue(service.submittedUploadIDs[0].hasPrefix("upload_"))
  }

  private func configuredPhotoViewModel(
    store: DataStore,
    accountID: String
  ) -> AddPhotosViewModel {
    let auth = AuthService()
    auth.userId = accountID
    let viewModel = AddPhotosViewModel()
    viewModel.configure(auth: auth, dataStore: store)
    let photo = ProcessedPhoto(
      id: "photo",
      originalURL: FileManager.default.temporaryDirectory.appending(path: "unused-photo"),
      cleanupOriginal: false,
      thumbnail: Data(),
      exifTime: Date(timeIntervalSince1970: 1_788_364_800),
      gpsLat: 47.7,
      gpsLon: -122.4,
      fileHash: "photo-hash",
      fileName: "bird.jpg",
      byteCount: 100
    )
    viewModel.processedPhotos = [photo]
    viewModel.clusters = [
      PhotoCluster(
        photos: [photo],
        startTime: Date(timeIntervalSince1970: 1_788_364_800),
        endTime: Date(timeIntervalSince1970: 1_788_364_800),
        centerLat: 47.7,
        centerLon: -122.4
      )
    ]
    viewModel.currentOutingId = "existing-outing"
    viewModel.lastLocationName = "Test Marsh"
    viewModel.currentStep = .perPhotoConfirm
    return viewModel
  }

  private func waitForCompletion(_ viewModel: AddPhotosViewModel) async throws {
    for _ in 0..<100 where viewModel.currentStep != .done {
      try await Task.sleep(for: .milliseconds(25))
    }
    XCTAssertEqual(viewModel.currentStep, .done)
  }
}

@MainActor
private func fixtureUpload(
  id: String,
  accountID: String,
  createdAt: Date = .now,
  usesExistingOuting: Bool = false
) -> PendingPhotoUpload {
  let outingID = "outing-\(id)"
  let outing = Outing(
    id: outingID,
    userId: accountID,
    startTime: "2026-09-02T12:00:00Z",
    endTime: "2026-09-02T13:00:00Z",
    locationName: "Test Marsh",
    notes: "",
    createdAt: "2026-09-02T12:00:00Z"
  )
  return PendingPhotoUpload(
    id: id,
    accountID: accountID,
    createdAt: createdAt,
    locationName: "Test Marsh",
    outing: usesExistingOuting ? nil : outing,
    outingRecoverySnapshot: usesExistingOuting ? outing : nil,
    photos: [
      DataService.PhotoPayload(
        id: "photo-\(id)",
        outingId: outingID,
        exifTime: "2026-09-02T12:30:00Z",
        gps: nil,
        fileHash: "hash-\(id)",
        fileName: "bird.jpg"
      )
    ],
    observations: [
      BirdObservation(
        id: "observation-\(id)",
        outingId: outingID,
        speciesName: "American Robin",
        count: 1,
        certainty: .confirmed,
        representativePhotoId: "photo-\(id)",
        notes: ""
      )
    ]
  )
}

private let emptyResponse = AllDataResponse(
  outings: [],
  photos: [],
  observations: [],
  dex: []
)

private func responseWithOuting(accountID: String) -> AllDataResponse {
  AllDataResponse(
    outings: [
      Outing(
        id: "existing-outing",
        userId: accountID,
        startTime: "2026-09-02T12:00:00Z",
        endTime: "2026-09-02T13:00:00Z",
        locationName: "Test Marsh",
        notes: "",
        createdAt: "2026-09-02T12:00:00Z"
      )
    ],
    photos: [],
    observations: [],
    dex: []
  )
}

private final class PendingUploadServiceStub: DataStoreService, @unchecked Sendable {
  var fetchResult: Result<AllDataResponse, Error> = .success(emptyResponse)
  var uploadResults: [Result<DataService.ObservationsResponse, Error>] = []
  var submittedUploadIDs: [String] = []
  var fetchCount = 0
  var clearCount = 0
  var fetchDelay: Duration?
  var uploadDelay: Duration?
  var clearResult: Result<Void, Error> = .success(())

  func fetchAllData() async throws -> AllDataResponse {
    fetchCount += 1
    if let fetchDelay {
      try await Task.sleep(for: fetchDelay)
    }
    return try fetchResult.get()
  }

  func submitPendingUpload(_ upload: PendingPhotoUpload) async throws
    -> DataService.ObservationsResponse
  {
    submittedUploadIDs.append(upload.id)
    if let uploadDelay {
      try await Task.sleep(for: uploadDelay)
    }
    if uploadResults.isEmpty {
      return .init(observations: [], dexUpdates: [])
    }
    return try uploadResults.removeFirst().get()
  }

  func deleteOuting(id _: String) async throws -> DexUpdateResponse {
    DexUpdateResponse(dexUpdates: [])
  }

  func updateOuting(id _: String, fields _: OutingUpdate) async throws -> Outing {
    throw URLError(.unsupportedURL)
  }

  func updateDexEntry(fields _: DexUpdate) async throws -> [DexEntry] { [] }
  func rejectObservations(ids _: [String]) async throws -> DataService.ObservationsResponse {
    .init(observations: [], dexUpdates: [])
  }
  func searchSpecies(query _: String, limit _: Int) async throws -> [DataService
    .SpeciesSearchResult]
  { [] }
  func createObservations(_ observations: [BirdObservation]) async throws
    -> DataService.ObservationsResponse
  {
    .init(observations: observations, dexUpdates: [])
  }
  func exportOutingCSV(outingId _: String) async throws -> Data { Data() }
  func importEBirdCSV(_ csvData: Data, profileTimezone _: String?) async throws
    -> DataService.ImportResponse
  {
    throw URLError(.unsupportedURL)
  }
  func clearAllData() async throws {
    clearCount += 1
    try clearResult.get()
  }
}

@MainActor
private final class RemoveFailurePendingUploadStore: PendingUploadStoring {
  private let base: PendingUploadStore

  init(base: PendingUploadStore) {
    self.base = base
  }

  func load(accountID: String) throws -> [PendingUploadEntry] {
    try base.load(accountID: accountID)
  }

  func enqueue(_ upload: PendingPhotoUpload) throws {
    try base.enqueue(upload)
  }

  func markFailed(
    id: String,
    accountID: String,
    message: String,
    requiresAttention: Bool,
    awaitingReconciliation: Bool
  ) throws {
    try base.markFailed(
      id: id,
      accountID: accountID,
      message: message,
      requiresAttention: requiresAttention,
      awaitingReconciliation: awaitingReconciliation
    )
  }

  func markAwaitingReconciliation(id: String, accountID: String) throws {
    try base.markAwaitingReconciliation(id: id, accountID: accountID)
  }

  func remove(id _: String, accountID _: String) throws {
    throw CocoaError(.fileWriteUnknown)
  }

  func clear(accountID: String) throws {
    try base.clear(accountID: accountID)
  }

  func reassign(from sourceAccountID: String, to targetAccountID: String) throws {
    try base.reassign(from: sourceAccountID, to: targetAccountID)
  }
}

@MainActor
private final class ClearFailurePendingUploadStore: PendingUploadStoring {
  private let base: PendingUploadStore

  init(base: PendingUploadStore) {
    self.base = base
  }

  func load(accountID: String) throws -> [PendingUploadEntry] {
    try base.load(accountID: accountID)
  }

  func enqueue(_ upload: PendingPhotoUpload) throws {
    try base.enqueue(upload)
  }

  func markFailed(
    id: String,
    accountID: String,
    message: String,
    requiresAttention: Bool,
    awaitingReconciliation: Bool
  ) throws {
    try base.markFailed(
      id: id,
      accountID: accountID,
      message: message,
      requiresAttention: requiresAttention,
      awaitingReconciliation: awaitingReconciliation
    )
  }

  func markAwaitingReconciliation(id: String, accountID: String) throws {
    try base.markAwaitingReconciliation(id: id, accountID: accountID)
  }

  func remove(id: String, accountID: String) throws {
    try base.remove(id: id, accountID: accountID)
  }

  func clear(accountID _: String) throws {
    throw CocoaError(.fileWriteUnknown)
  }

  func reassign(from sourceAccountID: String, to targetAccountID: String) throws {
    try base.reassign(from: sourceAccountID, to: targetAccountID)
  }
}

@MainActor
private final class PostEnqueueLoadFailurePendingUploadStore: PendingUploadStoring {
  private let base: PendingUploadStore
  private var didEnqueue = false

  init(base: PendingUploadStore) {
    self.base = base
  }

  func load(accountID: String) throws -> [PendingUploadEntry] {
    if didEnqueue {
      throw CocoaError(.fileReadUnknown)
    }
    return try base.load(accountID: accountID)
  }

  func enqueue(_ upload: PendingPhotoUpload) throws {
    try base.enqueue(upload)
    didEnqueue = true
  }

  func markFailed(
    id: String,
    accountID: String,
    message: String,
    requiresAttention: Bool,
    awaitingReconciliation: Bool
  ) throws {
    try base.markFailed(
      id: id,
      accountID: accountID,
      message: message,
      requiresAttention: requiresAttention,
      awaitingReconciliation: awaitingReconciliation
    )
  }

  func markAwaitingReconciliation(id: String, accountID: String) throws {
    try base.markAwaitingReconciliation(id: id, accountID: accountID)
  }

  func remove(id: String, accountID: String) throws {
    try base.remove(id: id, accountID: accountID)
  }

  func clear(accountID: String) throws {
    try base.clear(accountID: accountID)
  }

  func reassign(from sourceAccountID: String, to targetAccountID: String) throws {
    try base.reassign(from: sourceAccountID, to: targetAccountID)
  }
}

@MainActor
private final class FailOnceReassignPendingUploadStore: PendingUploadStoring {
  private let base: PendingUploadStore
  private var shouldFailReassign = true

  init(base: PendingUploadStore) {
    self.base = base
  }

  func load(accountID: String) throws -> [PendingUploadEntry] {
    try base.load(accountID: accountID)
  }

  func enqueue(_ upload: PendingPhotoUpload) throws {
    try base.enqueue(upload)
  }

  func markFailed(
    id: String,
    accountID: String,
    message: String,
    requiresAttention: Bool,
    awaitingReconciliation: Bool
  ) throws {
    try base.markFailed(
      id: id,
      accountID: accountID,
      message: message,
      requiresAttention: requiresAttention,
      awaitingReconciliation: awaitingReconciliation
    )
  }

  func markAwaitingReconciliation(id: String, accountID: String) throws {
    try base.markAwaitingReconciliation(id: id, accountID: accountID)
  }

  func remove(id: String, accountID: String) throws {
    try base.remove(id: id, accountID: accountID)
  }

  func clear(accountID: String) throws {
    try base.clear(accountID: accountID)
  }

  func reassign(from sourceAccountID: String, to targetAccountID: String) throws {
    if shouldFailReassign {
      shouldFailReassign = false
      throw CocoaError(.fileWriteUnknown)
    }
    try base.reassign(from: sourceAccountID, to: targetAccountID)
  }
}

@MainActor
private final class UnreadablePendingUploadStore: PendingUploadStoring {
  private var entries: [PendingUploadEntry]

  init(accountID: String) {
    entries = [
      PendingUploadEntry(
        id: "unreadable",
        accountID: accountID,
        createdAt: .now,
        locationName: "Test Marsh",
        upload: nil,
        lastError: "This saved upload is unreadable.",
        requiresAttention: true,
        awaitingReconciliation: true
      )
    ]
  }

  func load(accountID: String) throws -> [PendingUploadEntry] {
    entries.filter { $0.accountID == accountID }
  }

  func enqueue(_: PendingPhotoUpload) throws {}

  func markFailed(
    id _: String,
    accountID _: String,
    message _: String,
    requiresAttention _: Bool,
    awaitingReconciliation _: Bool
  ) throws {}

  func markAwaitingReconciliation(id _: String, accountID _: String) throws {}

  func remove(id: String, accountID: String) throws {
    entries.removeAll { $0.id == id && $0.accountID == accountID }
  }

  func clear(accountID: String) throws {
    entries.removeAll { $0.accountID == accountID }
  }

  func reassign(from _: String, to _: String) throws {}
}

@MainActor
private final class PendingUploadCacheStub: AccountDataCaching {
  let snapshot: AccountDataSnapshot?

  init(snapshot: AccountDataSnapshot?) {
    self.snapshot = snapshot
  }

  func load(accountID _: String) throws -> AccountDataSnapshot? { snapshot }
  func replace(accountID _: String, response _: AllDataResponse, refreshedAt _: Date) throws {}
  func clear(accountID _: String) throws {}
}
