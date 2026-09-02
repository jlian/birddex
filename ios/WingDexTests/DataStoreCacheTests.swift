@testable import WingDex
import Observation
import XCTest

@MainActor
final class DataStoreCacheTests: XCTestCase {
    func testDexEntryDecodesCanonicalTaxonAndCompoundParents() throws {
        let data = Data(#"{"outings":[],"photos":[],"observations":[],"dex":[{"id":"code:x00051","speciesName":"Western x Glaucous-winged Gull (hybrid)","speciesCode":"x00051","taxonCode":"x00051","commonName":"Western x Glaucous-winged Gull (hybrid)","scientificName":"Larus occidentalis x glaucescens","firstSeenDate":"2026-01-01","lastSeenDate":"2026-01-01","totalOutings":1,"totalCount":1,"notes":"","borrowedFrom":"Western Gull","compound":{"kind":"hybrid","parents":[{"commonName":"Western Gull","scientificName":"Larus occidentalis","speciesCode":"wesgul"},{"commonName":"Glaucous-winged Gull","scientificName":"Larus glaucescens","speciesCode":"glwgul"}]}}]}"#.utf8)

        let response = try JSONDecoder().decode(AllDataResponse.self, from: data)
        let entry = try XCTUnwrap(response.dex.first)

        XCTAssertEqual(entry.taxonCode, "x00051")
        XCTAssertEqual(entry.scientificName, "Larus occidentalis x glaucescens")
        XCTAssertEqual(entry.borrowedFrom, "Western Gull")
        XCTAssertEqual(entry.compound?.kind, "hybrid")
        XCTAssertEqual(entry.compound?.parents.map(\.commonName), ["Western Gull", "Glaucous-winged Gull"])
    }

    func testSingleRequestImportResponseDecodesSummaryAndSkippedRows() throws {
        let data = Data(#"{"imported":{"outings":2,"observations":3,"newSpecies":1},"skipped":{"rows":4},"dexUpdates":[]}"#.utf8)

        let response = try JSONDecoder().decode(DataService.ImportResponse.self, from: data)

        XCTAssertEqual(response.imported.outings, 2)
        XCTAssertEqual(response.imported.observations, 3)
        XCTAssertEqual(response.imported.newSpecies, 1)
        XCTAssertEqual(response.skipped.rows, 4)
        XCTAssertEqual(response.userMessage, "Imported eBird data across 2 outings (1 new!)")
    }

    func testDuplicateOnlyImportResponseUsesUsefulCopy() throws {
        let data = Data(#"{"imported":{"outings":0,"observations":0,"newSpecies":0},"skipped":{"rows":9},"dexUpdates":[]}"#.utf8)

        let response = try JSONDecoder().decode(DataService.ImportResponse.self, from: data)

        XCTAssertEqual(response.userMessage, "Already imported: nothing new in that file")
    }

    func testDerivedDataRebuildsWhenRawCollectionsChange() {
        let store = DataStore(service: ServiceStub(result: .failure(URLError(.notConnectedToInternet))))
        let older = Outing(
            id: "older",
            userId: "account-a",
            startTime: "2026-01-01T12:00:00Z",
            endTime: "2026-01-01T13:00:00Z",
            locationName: "Older Marsh",
            notes: "",
            createdAt: "2026-01-01T12:00:00Z"
        )
        let newer = Outing(
            id: "newer",
            userId: "account-a",
            startTime: "2026-02-01T12:00:00Z",
            endTime: "2026-02-01T13:00:00Z",
            locationName: "Newer Marsh",
            notes: "",
            createdAt: "2026-02-01T12:00:00Z"
        )
        store.outings = [older, newer]
        store.observations = [
            BirdObservation(
                id: "confirmed",
                outingId: newer.id,
                speciesName: "American Robin",
                count: 1,
                certainty: .confirmed,
                notes: ""
            ),
            BirdObservation(
                id: "possible",
                outingId: newer.id,
                speciesName: "Northern Cardinal",
                count: 1,
                certainty: .possible,
                notes: ""
            ),
        ]
        store.dex = [
            fixtureDex(speciesName: "Older Bird", totalCount: 1, firstSeenDate: "2026-01-01T12:00:00Z"),
            fixtureDex(speciesName: "Newer Bird", totalCount: 1, firstSeenDate: "2026-02-01T12:00:00Z"),
        ]

        XCTAssertEqual(store.recentOutings().map(\.id), [newer.id, older.id])
        XCTAssertEqual(store.confirmedObservations(newer.id).map(\.id), ["confirmed"])
        XCTAssertEqual(store.possibleObservations(newer.id).map(\.id), ["possible"])
        XCTAssertEqual(store.outingObservations(newer.id).map(\.id), ["confirmed", "possible"])
        XCTAssertEqual(store.speciesCount(for: newer.id), 1)
        XCTAssertEqual(store.recentSpecies().map(\.speciesName), ["Newer Bird", "Older Bird"])

        store.observations = []

        XCTAssertTrue(store.confirmedObservations(newer.id).isEmpty)
        XCTAssertEqual(store.speciesCount(for: newer.id), 0)
    }

    func testDerivedDataMutationInvalidatesObservationConsumer() {
        let store = DataStore(service: ServiceStub(result: .failure(URLError(.notConnectedToInternet))))
        store.observations = [BirdObservation(
            id: "observation",
            outingId: "outing",
            speciesName: "American Robin",
            count: 1,
            certainty: .confirmed,
            notes: ""
        )]
        let invalidated = expectation(description: "Derived species count invalidated")

        withObservationTracking {
            _ = store.speciesCount(for: "outing")
        } onChange: {
            invalidated.fulfill()
        }

        store.observations[0].certainty = .rejected

        wait(for: [invalidated], timeout: 1)
        XCTAssertEqual(store.speciesCount(for: "outing"), 0)
    }

    func testActivateHydratesCacheWithoutEnablingMutations() throws {
        let cache = CacheStub(snapshot: AccountDataSnapshot(
            response: fixtureResponse(locationName: "Cached Marsh"),
            refreshedAt: Date(timeIntervalSince1970: 100)
        ))
        let store = DataStore(service: ServiceStub(result: .failure(URLError(.notConnectedToInternet))), cache: cache)

        store.activate(accountID: "account-a")

        XCTAssertEqual(store.outings.first?.locationName, "Cached Marsh")
        XCTAssertTrue(store.hasReadableData)
        XCTAssertFalse(store.hasLoadedAll)
        XCTAssertNotNil(store.cachedAt)
        XCTAssertFalse(store.isShowingCachedData)
        XCTAssertThrowsError(try storeMutationReadiness(store))
    }

    func testOfflineRefreshKeepsCachedDataVisible() async {
        let cache = CacheStub(snapshot: AccountDataSnapshot(
            response: fixtureResponse(locationName: "Cached Marsh"),
            refreshedAt: .now
        ))
        let store = DataStore(service: ServiceStub(result: .failure(URLError(.notConnectedToInternet))), cache: cache)
        store.activate(accountID: "account-a")

        await store.loadAll()

        XCTAssertEqual(store.outings.first?.locationName, "Cached Marsh")
        XCTAssertEqual(store.error, .offline)
        XCTAssertFalse(store.hasLoadedAll)
        XCTAssertTrue(store.isShowingCachedData)
    }

    func testCancelledRefreshDoesNotFlagCachedData() async {
        let cache = CacheStub(snapshot: AccountDataSnapshot(
            response: fixtureResponse(locationName: "Cached Marsh"),
            refreshedAt: .now
        ))
        let store = DataStore(service: ServiceStub(result: .failure(URLError(.cancelled))), cache: cache)
        store.activate(accountID: "account-a")

        await store.loadAll()

        XCTAssertNil(store.error)
        XCTAssertFalse(store.isShowingCachedData)
    }

    func testFirstLaunchOfflineHasNoReadableSnapshot() async {
        let cache = CacheStub(snapshot: nil)
        let store = DataStore(
            service: ServiceStub(result: .failure(URLError(.notConnectedToInternet))),
            cache: cache
        )
        store.activate(accountID: "account-a")

        await store.loadAll()

        XCTAssertFalse(store.hasReadableData)
        XCTAssertTrue(store.outings.isEmpty)
        XCTAssertEqual(store.error, .offline)
    }

    func testSuccessfulRefreshReconcilesAndPersists() async {
        let cache = CacheStub(snapshot: AccountDataSnapshot(
            response: fixtureResponse(locationName: "Cached Marsh"),
            refreshedAt: .now
        ))
        let store = DataStore(
            service: ServiceStub(result: .success(fixtureResponse(locationName: "Fresh Marsh"))),
            cache: cache
        )
        store.activate(accountID: "account-a")

        await store.loadAll()

        XCTAssertEqual(store.outings.first?.locationName, "Fresh Marsh")
        XCTAssertTrue(store.hasLoadedAll)
        XCTAssertNil(store.cachedAt)
        XCTAssertEqual(cache.replacements.last?.accountID, "account-a")
        XCTAssertEqual(cache.replacements.last?.response.outings.first?.locationName, "Fresh Marsh")
    }

    func testCacheWriteFailureDoesNotTurnServerSuccessIntoRefreshFailure() async {
        let cache = CacheStub(snapshot: nil)
        cache.replaceError = CocoaError(.fileWriteUnknown)
        let store = DataStore(
            service: ServiceStub(result: .success(fixtureResponse(locationName: "Fresh Marsh"))),
            cache: cache
        )
        store.activate(accountID: "account-a")

        await store.loadAll()

        XCTAssertTrue(store.hasLoadedAll)
        XCTAssertEqual(store.outings.first?.locationName, "Fresh Marsh")
        XCTAssertNil(store.error)
    }

    func testCorruptPayloadIsPurgedWithoutBecomingReadable() {
        let cache = CacheStub(snapshot: nil)
        cache.loadError = DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "corrupt"))
        let store = DataStore(
            service: ServiceStub(result: .failure(URLError(.notConnectedToInternet))),
            cache: cache
        )

        store.activate(accountID: "account-a")

        XCTAssertFalse(store.hasReadableData)
        XCTAssertEqual(cache.clearedAccountIDs, ["account-a"])
    }

    func testClearActiveAccountPurgesMemoryAndPersistedSnapshot() {
        let cache = CacheStub(snapshot: AccountDataSnapshot(
            response: fixtureResponse(locationName: "Cached Marsh"),
            refreshedAt: .now
        ))
        let store = DataStore(service: ServiceStub(result: .failure(URLError(.notConnectedToInternet))), cache: cache)
        store.activate(accountID: "account-a")

        store.clearActiveAccount()

        XCTAssertNil(store.activeAccountID)
        XCTAssertTrue(store.outings.isEmpty)
        XCTAssertEqual(cache.clearedAccountIDs, ["account-a"])
    }

    func testCachedSnapshotRejectsMutationsUntilServerRefreshSucceeds() async {
        let cache = CacheStub(snapshot: AccountDataSnapshot(
            response: fixtureResponse(locationName: "Cached Marsh"),
            refreshedAt: .now
        ))
        let service = ServiceStub(result: .failure(URLError(.notConnectedToInternet)))
        let store = DataStore(service: service, cache: cache)
        store.activate(accountID: "account-a")

        do {
            try await store.deleteOuting(id: "outing-1")
            XCTFail("Expected cached data to remain read-only")
        } catch let error as AppError {
            XCTAssertEqual(error, .message("Reconnect and refresh WingDex before making changes."))
            XCTAssertEqual(store.outings.first?.locationName, "Cached Marsh")
            XCTAssertEqual(service.deleteOutingCalls, 0)
        } catch {
            XCTFail("Expected explicit cached-read-only error, got \(error)")
        }
    }

    func testSuccessfulMutationPersistsServerConfirmedSnapshot() async throws {
        let cache = CacheStub(snapshot: nil)
        let service = ServiceStub(result: .success(fixtureResponse(locationName: "Fresh Marsh")))
        let store = DataStore(service: service, cache: cache)
        store.activate(accountID: "account-a")
        await store.loadAll()
        cache.replacements.removeAll()

        try await store.deleteOuting(id: "outing-1")

        XCTAssertEqual(service.deleteOutingCalls, 1)
        XCTAssertTrue(store.outings.isEmpty)
        XCTAssertTrue(cache.replacements.last?.response.outings.isEmpty == true)
    }

    func testDeleteOutingInstallsAuthoritativeDexResponse() async throws {
        let authoritativeDex = [fixtureDex(speciesName: "American Robin", totalCount: 2)]
        let service = ServiceStub(result: .success(fixtureResponse(locationName: "Fresh Marsh")))
        service.deleteDexUpdates = authoritativeDex
        let cache = CacheStub(snapshot: nil)
        let store = DataStore(service: service, cache: cache)
        store.activate(accountID: "account-a")
        await store.loadAll()

        try await store.deleteOuting(id: "outing-1")

        XCTAssertEqual(store.dex, authoritativeDex)
        XCTAssertEqual(cache.replacements.last?.response.dex, authoritativeDex)
    }

    func testUpdateDexNotesSendsKeyAndInstallsAuthoritativeResponse() async throws {
        var entry = fixtureDex(speciesName: "American Robin", totalCount: 1)
        entry.speciesCode = "amerob"
        let initial = AllDataResponse(
            outings: [],
            photos: [],
            observations: [],
            dex: [entry]
        )
        var authoritative = entry
        authoritative.notes = "Seen at dawn"
        let service = ServiceStub(result: .success(initial))
        service.updateDexEntryResult = .success([authoritative])
        let cache = CacheStub(snapshot: nil)
        let store = DataStore(service: service, cache: cache)
        store.activate(accountID: "account-a")
        await store.loadAll()
        cache.replacements.removeAll()

        try await store.updateDexNotes(entry: entry, notes: "Seen at dawn")

        XCTAssertEqual(service.updateDexEntryCalls, 1)
        XCTAssertEqual(service.lastDexUpdate?.groupKey, "code:amerob")
        XCTAssertEqual(service.lastDexUpdate?.speciesName, entry.speciesName)
        XCTAssertEqual(service.lastDexUpdate?.notes, "Seen at dawn")
        XCTAssertEqual(store.dex, [authoritative])
        XCTAssertEqual(cache.replacements.last?.response.dex, [authoritative])
    }

    func testFailedUpdateDexNotesRestoresConfirmedSnapshot() async throws {
        var entry = fixtureDex(speciesName: "American Robin", totalCount: 1)
        entry.notes = "Original note"
        let initial = AllDataResponse(
            outings: [],
            photos: [],
            observations: [],
            dex: [entry]
        )
        let service = ServiceStub(result: .success(initial))
        service.updateDexEntryResult = .failure(URLError(.notConnectedToInternet))
        let cache = CacheStub(snapshot: nil)
        let store = DataStore(service: service, cache: cache)
        store.activate(accountID: "account-a")
        await store.loadAll()
        cache.replacements.removeAll()

        do {
            try await store.updateDexNotes(entry: entry, notes: "Unsaved note")
            XCTFail("Expected dex notes update to fail")
        } catch {
            XCTAssertTrue(error is URLError)
        }

        XCTAssertEqual(service.lastDexUpdate?.notes, "Unsaved note")
        XCTAssertEqual(store.dex, [entry])
    }

    func testDeleteOutingKeepsLocalDataUntilServerConfirms() async throws {
        let response = fixtureResponseWithDependentData(locationName: "Fresh Marsh")
        let service = SuspendedDeleteService(response: response)
        let cache = CacheStub(snapshot: nil)
        let store = DataStore(service: service, cache: cache)
        store.activate(accountID: "account-a")
        await store.loadAll()
        cache.replacements.removeAll()

        let deletion = Task { try await store.deleteOuting(id: "outing-1") }
        await service.waitUntilDeleteStarts()

        XCTAssertEqual(store.outings.map(\.id), ["outing-1"])
        XCTAssertEqual(store.observations.map(\.id), ["observation-1"])
        XCTAssertEqual(store.photos.map(\.id), ["photo-1"])

        await service.completeDelete()
        try await deletion.value

        XCTAssertTrue(store.outings.isEmpty)
        XCTAssertTrue(store.observations.isEmpty)
        XCTAssertTrue(store.photos.isEmpty)
        XCTAssertTrue(cache.replacements.last?.response.outings.isEmpty == true)
    }

    func testFailedDeleteNeverOptimisticallyRemovesOuting() async {
        let response = fixtureResponseWithDependentData(locationName: "Fresh Marsh")
        let service = SuspendedDeleteService(response: response)
        let store = DataStore(service: service)
        store.activate(accountID: "account-a")
        await store.loadAll()

        let deletion = Task { try await store.deleteOuting(id: "outing-1") }
        await service.waitUntilDeleteStarts()
        await Task.yield()

        XCTAssertEqual(store.outings.map(\.id), ["outing-1"])

        await service.completeDelete(with: .failure(URLError(.notConnectedToInternet)))
        do {
            try await deletion.value
            XCTFail("Expected deletion to fail")
        } catch {
            XCTAssertTrue(error is URLError)
        }
        XCTAssertEqual(store.outings.map(\.id), ["outing-1"])
    }

    func testQueuedDuplicateDeleteOnlyCallsServerOnce() async throws {
        let response = fixtureResponse(locationName: "Fresh Marsh")
        let service = SuspendedDeleteService(response: response)
        let store = DataStore(service: service)
        store.activate(accountID: "account-a")
        await store.loadAll()

        let firstDeletion = Task { try await store.deleteOuting(id: "outing-1") }
        await service.waitUntilDeleteStarts()
        let duplicateDeletion = Task { try await store.deleteOuting(id: "outing-1") }
        await Task.yield()

        let callsWhilePending = await service.deleteCallCount()
        XCTAssertEqual(callsWhilePending, 1)

        await service.completeDelete()
        try await firstDeletion.value
        try await duplicateDeletion.value

        let finalCalls = await service.deleteCallCount()
        XCTAssertEqual(finalCalls, 1)
        XCTAssertTrue(store.outings.isEmpty)
    }

    func testQueuedDuplicateDeleteSharesAmbiguousFailure() async {
        let response = fixtureResponse(locationName: "Fresh Marsh")
        let service = SuspendedDeleteService(response: response)
        let store = DataStore(service: service)
        store.activate(accountID: "account-a")
        await store.loadAll()

        let firstDeletion = Task { try await store.deleteOuting(id: "outing-1") }
        await service.waitUntilDeleteStarts()
        let duplicateDeletion = Task { try await store.deleteOuting(id: "outing-1") }
        await Task.yield()

        await service.completeDelete(with: .failure(URLError(.timedOut)))
        for deletion in [firstDeletion, duplicateDeletion] {
            do {
                try await deletion.value
                XCTFail("Expected the shared deletion to fail")
            } catch {
                XCTAssertTrue(error is URLError)
            }
        }

        let deleteCallCount = await service.deleteCallCount()
        XCTAssertEqual(deleteCallCount, 1)
    }

    func testAmbiguousMutationFailureReconcilesServerAuthoritativeState() async {
        let authoritativeEmpty = AllDataResponse(outings: [], photos: [], observations: [], dex: [])
        let service = AmbiguousDeleteService(
            initial: fixtureResponse(locationName: "Fresh Marsh"),
            reconciled: authoritativeEmpty
        )
        let cache = CacheStub(snapshot: nil)
        let store = DataStore(service: service, cache: cache)
        store.activate(accountID: "account-a")
        await store.loadAll()

        do {
            try await store.deleteOuting(id: "outing-1")
            XCTFail("Expected the simulated post-commit timeout")
        } catch {
            XCTAssertTrue(error is URLError)
        }
        await service.waitForReconciliationFetch()
        await Task.yield()

        XCTAssertTrue(store.outings.isEmpty)
        XCTAssertTrue(cache.replacements.last?.response.outings.isEmpty == true)
    }

    func testDeleteAllClearsAccountCacheAfterServerSuccess() async throws {
        let cache = CacheStub(snapshot: nil)
        let service = ServiceStub(result: .success(fixtureResponse(locationName: "Fresh Marsh")))
        let store = DataStore(service: service, cache: cache)
        store.activate(accountID: "account-a")
        await store.loadAll()

        try await store.clearAll()

        XCTAssertEqual(service.clearAllCalls, 1)
        XCTAssertEqual(cache.clearedAccountIDs, ["account-a"])
        XCTAssertTrue(store.outings.isEmpty)
    }

    func testRefreshForDepartedAccountCannotOverwriteReplacementAccount() async {
        let cache = CacheStub(snapshot: nil)
        let service = SuspendedFetchService()
        let store = DataStore(service: service, cache: cache)
        store.activate(accountID: "account-a")

        let load = Task { await store.loadAll() }
        await service.waitUntilFetchStarts()
        store.activate(accountID: "account-b")
        await service.complete(with: fixtureResponse(locationName: "Account A Marsh"))
        await load.value

        XCTAssertEqual(store.activeAccountID, "account-b")
        XCTAssertTrue(store.outings.isEmpty)
        XCTAssertTrue(cache.replacements.isEmpty)
    }

    func testSameAccountRefreshesAreSerialized() async {
        let cache = CacheStub(snapshot: nil)
        let service = MultiFetchService()
        let store = DataStore(service: service, cache: cache)
        store.activate(accountID: "account-a")

        let firstLoad = Task { await store.loadAll() }
        await service.waitForFetchCount(1)
        let secondLoad = Task { await store.loadAll() }
        await Task.yield()
        let fetchCountBeforeRelease = await service.fetchCount()
        XCTAssertEqual(fetchCountBeforeRelease, 1)
        await service.complete(index: 0, with: fixtureResponse(locationName: "First Marsh"))
        await firstLoad.value
        await service.waitForFetchCount(2)
        await service.complete(index: 1, with: fixtureResponse(locationName: "Second Marsh"))
        await secondLoad.value

        XCTAssertEqual(store.outings.first?.locationName, "Second Marsh")
        XCTAssertEqual(cache.replacements.last?.response.outings.first?.locationName, "Second Marsh")
    }

    func testConcurrentInitialLoadsShareOneFetch() async throws {
        let service = MultiFetchService()
        let store = DataStore(service: service)
        store.activate(accountID: "account-a")

        let firstLoad = Task { try await store.ensureLoaded() }
        await service.waitForFetchCount(1)
        let secondLoad = Task { try await store.ensureLoaded() }
        await Task.yield()
        let fetchCountBeforeRelease = await service.fetchCount()
        XCTAssertEqual(fetchCountBeforeRelease, 1)

        await service.complete(index: 0, with: fixtureResponse(locationName: "Initial Marsh"))
        try await firstLoad.value
        try await secondLoad.value

        let finalFetchCount = await service.fetchCount()
        XCTAssertEqual(finalFetchCount, 1)
        XCTAssertEqual(store.outings.first?.locationName, "Initial Marsh")
    }

    func testAccountReplacementInvalidatesInitialLoad() async {
        let service = SuspendedFetchService()
        let store = DataStore(service: service)
        store.activate(accountID: "account-a")

        let load = Task { try await store.ensureLoaded() }
        await service.waitUntilFetchStarts()
        store.activate(accountID: "account-b")
        await service.complete(with: fixtureResponse(locationName: "Departed Marsh"))

        do {
            try await load.value
            XCTFail("Departed account hydration should be cancelled")
        } catch is CancellationError {
            // Expected.
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
        XCTAssertEqual(store.activeAccountID, "account-b")
        XCTAssertTrue(store.outings.isEmpty)
    }

    func testCancelledQueuedRefreshReleasesOperationSlot() async {
        let service = MultiFetchService()
        let store = DataStore(service: service)
        store.activate(accountID: "account-a")

        let firstLoad = Task { await store.loadAll() }
        await service.waitForFetchCount(1)
        let cancellationCompleted = expectation(description: "Queued refresh cancelled promptly")
        let cancelledLoad = Task {
            await store.loadAll()
            cancellationCompleted.fulfill()
        }
        await Task.yield()
        cancelledLoad.cancel()
        await fulfillment(of: [cancellationCompleted], timeout: 1)
        let fetchCountAfterCancellation = await service.fetchCount()
        XCTAssertEqual(fetchCountAfterCancellation, 1)

        await service.complete(index: 0, with: fixtureResponse(locationName: "First Marsh"))
        await firstLoad.value
        await cancelledLoad.value

        let finalLoad = Task { await store.loadAll() }
        await service.waitForFetchCount(2)
        await service.complete(index: 1, with: fixtureResponse(locationName: "Final Marsh"))
        await finalLoad.value

        XCTAssertEqual(store.outings.first?.locationName, "Final Marsh")
    }

    func testOverlappingRefreshCannotRestoreSuccessfullyDeletedData() async throws {
        let service = RefreshDeleteRaceService(response: fixtureResponse(locationName: "Fresh Marsh"))
        let cache = CacheStub(snapshot: nil)
        let store = DataStore(service: service, cache: cache)
        store.activate(accountID: "account-a")
        await store.loadAll()

        let staleRefresh = Task { await store.loadAll() }
        await service.waitForSuspendedRefresh()
        let delete = Task { try await store.deleteOuting(id: "outing-1") }
        await service.completeSuspendedRefresh()
        await staleRefresh.value
        try await delete.value

        XCTAssertTrue(store.outings.isEmpty)
        XCTAssertTrue(cache.replacements.last?.response.outings.isEmpty == true)
    }

    func testQueuedMutationFromDepartedAccountNeverDispatchesForReplacementAccount() async throws {
        let accountAService = SuspendedDeleteService(response: fixtureResponse(locationName: "Account A Marsh"))
        let accountBService = ServiceStub(result: .success(fixtureResponse(locationName: "Account B Marsh")))
        let store = DataStore(serviceFactory: { accountID -> any DataStoreService in
            if accountID == "account-a" { return accountAService }
            return accountBService
        })
        store.activate(accountID: "account-a")
        await store.loadAll()

        let firstDelete = Task { try await store.deleteOuting(id: "outing-1") }
        await accountAService.waitUntilDeleteStarts()
        let queuedDelete = Task { try await store.deleteOuting(id: "outing-2") }
        await Task.yield()
        store.activate(accountID: "account-b")
        await accountAService.completeDelete()
        for deletion in [firstDelete, queuedDelete] {
            do {
                try await deletion.value
                XCTFail("Expected departed-account mutation to be cancelled")
            } catch is CancellationError {
            } catch {
                XCTFail("Expected cancellation, got \(error)")
            }
        }
        await store.loadAll()

        let accountADeleteCount = await accountAService.deleteCallCount()
        XCTAssertEqual(accountADeleteCount, 1)
        XCTAssertEqual(accountBService.deleteOutingCalls, 0)
        XCTAssertEqual(store.activeAccountID, "account-b")
    }

    private func storeMutationReadiness(_ store: DataStore) throws {
        guard store.hasLoadedAll else {
            throw AppError.message("not ready")
        }
    }

    private func fixtureResponse(locationName: String) -> AllDataResponse {
        AllDataResponse(
            outings: [Outing(
                id: "outing-1",
                userId: "account-a",
                startTime: "2026-07-20T12:00:00Z",
                endTime: "2026-07-20T13:00:00Z",
                locationName: locationName,
                notes: "",
                createdAt: "2026-07-20T12:00:00Z"
            )],
            photos: [],
            observations: [],
            dex: []
        )
    }

    private func fixtureResponseWithDependentData(locationName: String) -> AllDataResponse {
        let response = fixtureResponse(locationName: locationName)
        return AllDataResponse(
            outings: response.outings,
            photos: [Photo(
                id: "photo-1",
                outingId: "outing-1",
                dataUrl: "data:image/jpeg;base64,",
                thumbnail: "data:image/jpeg;base64,",
                fileHash: "photo-hash",
                fileName: "bird.jpg"
            )],
            observations: [BirdObservation(
                id: "observation-1",
                outingId: "outing-1",
                speciesName: "American Robin",
                count: 1,
                certainty: .confirmed,
                notes: ""
            )],
            dex: [fixtureDex(speciesName: "American Robin", totalCount: 1)]
        )
    }

    private func fixtureDex(
        speciesName: String,
        totalCount: Int,
        firstSeenDate: String = "2026-07-20"
    ) -> DexEntry {
        DexEntry(
            speciesName: speciesName,
            firstSeenDate: firstSeenDate,
            lastSeenDate: "2026-07-20",
            totalOutings: 1,
            totalCount: totalCount,
            notes: ""
        )
    }
}

@MainActor
private final class CacheStub: AccountDataCaching {
    struct Replacement {
        let accountID: String
        let response: AllDataResponse
    }

    var snapshot: AccountDataSnapshot?
    var replacements: [Replacement] = []
    var clearedAccountIDs: [String] = []
    var loadError: Error?
    var replaceError: Error?

    init(snapshot: AccountDataSnapshot?) {
        self.snapshot = snapshot
    }

    func load(accountID _: String) throws -> AccountDataSnapshot? {
        if let loadError { throw loadError }
        return snapshot
    }

    func replace(accountID: String, response: AllDataResponse, refreshedAt _: Date) throws {
        if let replaceError { throw replaceError }
        replacements.append(Replacement(accountID: accountID, response: response))
    }

    func clear(accountID: String) throws {
        clearedAccountIDs.append(accountID)
        snapshot = nil
    }
}

private final class ServiceStub: DataStoreService, @unchecked Sendable {
    let result: Result<AllDataResponse, Error>
    var deleteOutingCalls = 0
    var clearAllCalls = 0
    var deleteDexUpdates: [DexEntry] = []
    var updateDexEntryCalls = 0
    var lastDexUpdate: DexUpdate?
    var updateDexEntryResult: Result<[DexEntry], Error> = .success([])

    init(result: Result<AllDataResponse, Error>) {
        self.result = result
    }

    func fetchAllData() async throws -> AllDataResponse { try result.get() }
    func deleteOuting(id _: String) async throws -> DexUpdateResponse {
        deleteOutingCalls += 1
        return DexUpdateResponse(dexUpdates: deleteDexUpdates)
    }
    func updateOuting(id _: String, fields _: OutingUpdate) async throws -> Outing { fatalError() }
    func updateDexEntry(fields: DexUpdate) async throws -> [DexEntry] {
        updateDexEntryCalls += 1
        lastDexUpdate = fields
        return try updateDexEntryResult.get()
    }
    func rejectObservations(ids _: [String]) async throws -> DataService.ObservationsResponse { fatalError() }
    func searchSpecies(query _: String, limit _: Int) async throws -> [DataService.SpeciesSearchResult] { [] }
    func createObservations(_ observations: [BirdObservation]) async throws -> DataService.ObservationsResponse { fatalError() }
    func exportOutingCSV(outingId _: String) async throws -> Data { Data() }
    func importEBirdCSV(_ csvData: Data, profileTimezone: String?) async throws -> DataService.ImportResponse { fatalError() }
    func clearAllData() async throws { clearAllCalls += 1 }
}

private actor MultiFetchService: DataStoreService {
    private var continuations: [CheckedContinuation<AllDataResponse, Error>?] = []
    private var countWaiters: [(count: Int, continuation: CheckedContinuation<Void, Never>)] = []

    func fetchAllData() async throws -> AllDataResponse {
        let index = continuations.count
        continuations.append(nil)
        resumeCountWaiters()
        return try await withCheckedThrowingContinuation { continuations[index] = $0 }
    }

    func waitForFetchCount(_ count: Int) async {
        guard continuations.count < count else { return }
        await withCheckedContinuation { countWaiters.append((count, $0)) }
    }

    func fetchCount() -> Int { continuations.count }

    func complete(index: Int, with response: AllDataResponse) {
        continuations[index]?.resume(returning: response)
        continuations[index] = nil
    }

    private func resumeCountWaiters() {
        let ready = countWaiters.filter { continuations.count >= $0.count }
        countWaiters.removeAll { continuations.count >= $0.count }
        ready.forEach { $0.continuation.resume() }
    }

    func deleteOuting(id _: String) async throws -> DexUpdateResponse { DexUpdateResponse(dexUpdates: []) }
    func updateOuting(id _: String, fields _: OutingUpdate) async throws -> Outing { fatalError() }
    func updateDexEntry(fields _: DexUpdate) async throws -> [DexEntry] { fatalError() }
    func rejectObservations(ids _: [String]) async throws -> DataService.ObservationsResponse { fatalError() }
    func searchSpecies(query _: String, limit _: Int) async throws -> [DataService.SpeciesSearchResult] { [] }
    func createObservations(_ observations: [BirdObservation]) async throws -> DataService.ObservationsResponse { fatalError() }
    func exportOutingCSV(outingId _: String) async throws -> Data { Data() }
    func importEBirdCSV(_ csvData: Data, profileTimezone: String?) async throws -> DataService.ImportResponse { fatalError() }
    func clearAllData() async throws {}
}

private actor SuspendedFetchService: DataStoreService {
    private var fetchStarted = false
    private var fetchWaiters: [CheckedContinuation<Void, Never>] = []
    private var responseContinuation: CheckedContinuation<AllDataResponse, Error>?

    func fetchAllData() async throws -> AllDataResponse {
        fetchStarted = true
        fetchWaiters.forEach { $0.resume() }
        fetchWaiters.removeAll()
        return try await withCheckedThrowingContinuation { responseContinuation = $0 }
    }

    func waitUntilFetchStarts() async {
        guard !fetchStarted else { return }
        await withCheckedContinuation { fetchWaiters.append($0) }
    }

    func complete(with response: AllDataResponse) {
        responseContinuation?.resume(returning: response)
        responseContinuation = nil
    }

    func deleteOuting(id _: String) async throws -> DexUpdateResponse {
        DexUpdateResponse(dexUpdates: [])
    }
    func updateOuting(id _: String, fields _: OutingUpdate) async throws -> Outing { fatalError() }
    func updateDexEntry(fields _: DexUpdate) async throws -> [DexEntry] { fatalError() }
    func rejectObservations(ids _: [String]) async throws -> DataService.ObservationsResponse { fatalError() }
    func searchSpecies(query _: String, limit _: Int) async throws -> [DataService.SpeciesSearchResult] { [] }
    func createObservations(_ observations: [BirdObservation]) async throws -> DataService.ObservationsResponse { fatalError() }
    func exportOutingCSV(outingId _: String) async throws -> Data { Data() }
    func importEBirdCSV(_ csvData: Data, profileTimezone: String?) async throws -> DataService.ImportResponse { fatalError() }
    func clearAllData() async throws {}
}

private actor RefreshDeleteRaceService: DataStoreService {
    private let response: AllDataResponse
    private var fetchCount = 0
    private var suspendedRefresh: CheckedContinuation<AllDataResponse, Error>?
    private var refreshWaiters: [CheckedContinuation<Void, Never>] = []

    init(response: AllDataResponse) {
        self.response = response
    }

    func fetchAllData() async throws -> AllDataResponse {
        fetchCount += 1
        if fetchCount == 1 { return response }
        refreshWaiters.forEach { $0.resume() }
        refreshWaiters.removeAll()
        return try await withCheckedThrowingContinuation { suspendedRefresh = $0 }
    }

    func waitForSuspendedRefresh() async {
        guard fetchCount < 2 else { return }
        await withCheckedContinuation { refreshWaiters.append($0) }
    }

    func completeSuspendedRefresh() {
        suspendedRefresh?.resume(returning: response)
        suspendedRefresh = nil
    }

    func deleteOuting(id _: String) async throws -> DexUpdateResponse { DexUpdateResponse(dexUpdates: []) }
    func updateOuting(id _: String, fields _: OutingUpdate) async throws -> Outing { fatalError() }
    func updateDexEntry(fields _: DexUpdate) async throws -> [DexEntry] { fatalError() }
    func rejectObservations(ids _: [String]) async throws -> DataService.ObservationsResponse { fatalError() }
    func searchSpecies(query _: String, limit _: Int) async throws -> [DataService.SpeciesSearchResult] { [] }
    func createObservations(_ observations: [BirdObservation]) async throws -> DataService.ObservationsResponse { fatalError() }
    func exportOutingCSV(outingId _: String) async throws -> Data { Data() }
    func importEBirdCSV(_ csvData: Data, profileTimezone: String?) async throws -> DataService.ImportResponse { fatalError() }
    func clearAllData() async throws {}
}

private actor SuspendedDeleteService: DataStoreService {
    private let response: AllDataResponse
    private var deleteCalls = 0
    private var deleteContinuation: CheckedContinuation<DexUpdateResponse, Error>?
    private var deleteWaiters: [CheckedContinuation<Void, Never>] = []

    init(response: AllDataResponse) {
        self.response = response
    }

    func fetchAllData() async throws -> AllDataResponse { response }

    func deleteOuting(id _: String) async throws -> DexUpdateResponse {
        deleteCalls += 1
        if deleteCalls > 1 {
            return DexUpdateResponse(dexUpdates: [])
        }
        deleteWaiters.forEach { $0.resume() }
        deleteWaiters.removeAll()
        return try await withCheckedThrowingContinuation { deleteContinuation = $0 }
    }

    func waitUntilDeleteStarts() async {
        guard deleteCalls == 0 else { return }
        await withCheckedContinuation { deleteWaiters.append($0) }
    }

    func completeDelete(
        with result: Result<DexUpdateResponse, Error> = .success(DexUpdateResponse(dexUpdates: []))
    ) {
        deleteContinuation?.resume(with: result)
        deleteContinuation = nil
    }

    func deleteCallCount() -> Int { deleteCalls }
    func updateOuting(id _: String, fields _: OutingUpdate) async throws -> Outing { fatalError() }
    func updateDexEntry(fields _: DexUpdate) async throws -> [DexEntry] { fatalError() }
    func rejectObservations(ids _: [String]) async throws -> DataService.ObservationsResponse { fatalError() }
    func searchSpecies(query _: String, limit _: Int) async throws -> [DataService.SpeciesSearchResult] { [] }
    func createObservations(_ observations: [BirdObservation]) async throws -> DataService.ObservationsResponse { fatalError() }
    func exportOutingCSV(outingId _: String) async throws -> Data { Data() }
    func importEBirdCSV(_ csvData: Data, profileTimezone: String?) async throws -> DataService.ImportResponse { fatalError() }
    func clearAllData() async throws {}
}

private actor AmbiguousDeleteService: DataStoreService {
    private let initial: AllDataResponse
    private let reconciled: AllDataResponse
    private var fetchCount = 0
    private var reconciliationWaiters: [CheckedContinuation<Void, Never>] = []

    init(initial: AllDataResponse, reconciled: AllDataResponse) {
        self.initial = initial
        self.reconciled = reconciled
    }

    func fetchAllData() async throws -> AllDataResponse {
        fetchCount += 1
        if fetchCount > 1 {
            reconciliationWaiters.forEach { $0.resume() }
            reconciliationWaiters.removeAll()
            return reconciled
        }
        return initial
    }

    func waitForReconciliationFetch() async {
        guard fetchCount < 2 else { return }
        await withCheckedContinuation { reconciliationWaiters.append($0) }
    }

    func deleteOuting(id _: String) async throws -> DexUpdateResponse {
        throw URLError(.timedOut)
    }

    func updateOuting(id _: String, fields _: OutingUpdate) async throws -> Outing { fatalError() }
    func updateDexEntry(fields _: DexUpdate) async throws -> [DexEntry] { fatalError() }
    func rejectObservations(ids _: [String]) async throws -> DataService.ObservationsResponse { fatalError() }
    func searchSpecies(query _: String, limit _: Int) async throws -> [DataService.SpeciesSearchResult] { [] }
    func createObservations(_ observations: [BirdObservation]) async throws -> DataService.ObservationsResponse { fatalError() }
    func exportOutingCSV(outingId _: String) async throws -> Data { Data() }
    func importEBirdCSV(_ csvData: Data, profileTimezone: String?) async throws -> DataService.ImportResponse { fatalError() }
    func clearAllData() async throws {}
}
