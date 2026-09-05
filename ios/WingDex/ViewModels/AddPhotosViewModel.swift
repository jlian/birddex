import Foundation
import Observation
import PhotosUI
import SwiftUI
import os

private let log = Logger(subsystem: Config.bundleID, category: "AddPhotos")

private enum PhotoPreparationInput: Sendable {
    case picker(PhotosPickerItem)
    case shared(IncomingSharedPhoto)
}

private struct PhotoPreparationOutcome: Sendable {
    let index: Int
    let photo: ProcessedPhoto?
    let rejectedSharedFileName: String?
}

private final class PhotoPreparationBatch: @unchecked Sendable {
    private let lock = NSLock()
    private var ownedURLs: Set<URL> = []
    private var preparedBytes = 0

    func registerOwned(_ url: URL) {
        _ = lock.withLock { ownedURLs.insert(url) }
    }

    func unregisterOwned(_ url: URL) {
        _ = lock.withLock { ownedURLs.remove(url) }
    }

    func reserve(_ byteCount: Int) -> Bool {
        lock.withLock {
            guard byteCount <= IncomingShareStore.maximumTotalBytes - preparedBytes else {
                return false
            }
            preparedBytes += byteCount
            return true
        }
    }

    func cleanupOwnedFiles() {
        let urls = lock.withLock {
            let urls = ownedURLs
            ownedURLs.removeAll()
            return urls
        }
        PhotoFlowStore.remove(urls)
    }

    func relinquishOwnedFiles() {
        lock.withLock { ownedURLs.removeAll() }
    }
}

/// ViewModel for the multi-step Add Photos wizard flow.
///
/// Flow: selectPhotos -> extracting -> outingReview -> photoProcessing ->
///       perPhotoConfirm -> (manualCrop) -> [next photo or save] -> done
///
/// Matches the web app's AddPhotosFlow.tsx state machine. Each photo is
/// confirmed individually (per-photo) rather than in a batch list.
@MainActor
@Observable
final class AddPhotosViewModel {

    enum IncomingShareImportResult: Equatable {
        case accepted
        case busy
        case empty
        case failed
        case cancelled
    }

    enum CropPromptContext: Equatable {
        case manualRecrop
        case lowConfidence

        var reasonText: String {
            switch self {
            case .manualRecrop, .lowConfidence:
                return "Crop to one bird."
            }
        }
    }

    // MARK: - Step State Machine

    /// All possible steps in the add-photos wizard.
    enum Step: Hashable {
        case selectPhotos
        case extracting
        case outingReview
        case photoProcessing
        case perPhotoConfirm
        case manualCrop
        case saving
        case done
    }

    var currentStep: Step = .selectPhotos
    private(set) var flowDismissalRequestID = UUID()
    private(set) var continuesShareQueueAfterDismissal = false
    private(set) var stoppedShareQueueAfterDismissal = false

    // MARK: - Photo Selection

    var selectedItems: [PhotosPickerItem] = []
    var processedPhotos: [ProcessedPhoto] = []

    /// Photos captured via the camera (UIImage + capture-time location, not from
    /// PhotosPicker). The in-app camera returns bare pixels with no EXIF GPS, so
    /// we carry the device location captured alongside each shot.
    var cameraPhotos: [(image: UIImage, lat: Double?, lon: Double?)] = []
    private var incomingSharedPhotos: [IncomingSharedPhoto] = []
    private var incomingShareID: String?

    // MARK: - Clustering

    var clusters: [PhotoCluster] = []
    var currentClusterIndex = 0

    // MARK: - GPS Context Toggle

    /// When true, send GPS and date context to the AI for better identification.
    /// Persisted in UserDefaults so it survives between sessions and is editable from Settings.
    var useGeoContext: Bool {
        get { UserDefaults.standard.object(forKey: "useGeoContext") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "useGeoContext") }
    }

    // MARK: - Outing Review State

    /// Last confirmed name, retained for pending-upload recovery only.
    var lastLocationName = ""

    /// The outing ID that the current cluster is being saved into.
    var currentOutingId = ""

    /// Coordinates confirmed during outing review. Per-photo GPS normally wins,
    /// but a searched location is an explicit correction and takes precedence.
    private var outingInferenceLocation: (lat: Double, lon: Double)?
    private var outingOverridesPhotoGPS = false

    /// The exact coordinates used by the range prior for the current photo.
    /// The confirmation UI reuses this value so its rarity mark cannot describe
    /// a different location from the one that ranked the candidates.
    var currentInferenceLocation: (lat: Double, lon: Double)? {
        guard let photo = currentPhoto else { return nil }
        return inferenceLocation(for: photo)
    }

    // MARK: - Per-Photo Identification State

    /// Index of the photo currently being processed/confirmed within the current cluster.
    var currentPhotoIndex = 0

    /// AI candidates for the photo currently being confirmed.
    var currentCandidates: [IdentifiedCandidate] = []
    private(set) var activeImageData: Data?
    private var activeImagePhotoID: String?

    /// Whether range-prior data was used to adjust confidence.
    var rangeAdjusted = false

    /// Why the crop UI is being shown. This is driven by the same AI response
    /// conditions as the web flow rather than inferred from currentCandidates.
    var cropPromptContext: CropPromptContext = .manualRecrop

    /// Per-photo results accumulated during the per-photo confirmation loop.
    var photoResults: [PhotoResult] = []

    // MARK: - Processing State

    var isProcessing = false
    var processingMessage = ""
    var processedCount = 0
    var totalCount = 0
    var extractionProgress: Double = 0
    var error: AppError?
    /// The outing for the current cluster, held here until the cluster turns out to have a
    /// sighting worth saving. Nil when merging into an outing that already exists.
    private var pendingOuting: Outing?
    private var errorRecovery: ErrorRecovery?
    private var preparedObservations: [BirdObservation]?
  private var preparedUpload: PendingPhotoUpload?

    var canRetryError: Bool { errorRecovery != nil }

    // MARK: - Duplicate Detection

    var pendingNewPhotos: [ProcessedPhoto] = []
    var pendingDuplicatePhotos: [ProcessedPhoto] = []
    private var pendingRejectedSharedPhotoCount = 0
    var showDuplicateConfirm = false

    // MARK: - Results After Save

    /// Accumulated stats across all clusters in this upload session.
    var uploadSummary: UploadSummary?
    var savedOutingCount = 0
    var savedObservationCount = 0
    var newSpeciesCount = 0
  private var sessionQueuedUploadIDs = Set<String>()
  var queuedUploadCount: Int {
    guard let dataStore else { return 0 }
    let pendingIDs = Set(dataStore.pendingUploads.map(\.id))
    return sessionQueuedUploadIDs.intersection(pendingIDs).count
  }
    /// Display names of species newly added to the dex during this upload session.
    var newSpeciesNames: [String] = []

    // MARK: - Dependencies

    private var dataStore: DataStore?
    private var authService: AuthService?
    private var accountID: String?
    private var sessionGeneration = UUID()

    func configure(auth: AuthService, dataStore: DataStore) {
        let accountID = auth.userId
        if self.accountID != accountID {
            if self.accountID != nil {
                sessionGeneration = UUID()
                resetFlowForAccountChange()
            }
        }
        self.accountID = accountID
        authService = auth
        self.dataStore = dataStore
        lastLocationName = ""
    }

    func cancelSession() async {
        sessionGeneration = UUID()
        await releaseIncomingShare()
        cleanupPhotoFiles()
        accountID = nil
        authService = nil
        dataStore = nil
    }

    func stopShareQueueAfterDismissal() {
        continuesShareQueueAfterDismissal = false
        stoppedShareQueueAfterDismissal = true
    }

    func discardSession() async {
        await finalizeDiscardedShare()
        error = nil
        errorRecovery = nil
        currentStep = .selectPhotos
    }

    // MARK: - Convenience

    /// Photos belonging to the current cluster.
    var clusterPhotos: [ProcessedPhoto] {
        guard currentClusterIndex < clusters.count else { return [] }
        return clusters[currentClusterIndex].photos
    }

    /// The full ProcessedPhoto for the current photo index.
    var currentPhoto: ProcessedPhoto? {
        let photos = clusterPhotos
        guard currentPhotoIndex < photos.count else { return nil }
        return photos[currentPhotoIndex]
    }

    // MARK: - Camera Support

    /// Add a photo captured from the camera, with the device location at capture
    /// time (nil if location was unavailable or permission was denied).
    func addCameraPhoto(_ image: UIImage, lat: Double?, lon: Double?) {
        cameraPhotos.append((image: image, lat: lat, lon: lon))
    }

    func importIncomingShareIfAvailable() async -> IncomingShareImportResult {
        guard canStartIncomingShareImport else { return .busy }
        do {
            guard let snapshot = try await IncomingShareStore.oldestPendingShare() else {
                return .empty
            }
            guard canStartIncomingShareImport else { return .busy }
            guard let claimed = try await IncomingShareStore.claim(id: snapshot.id) else {
                throw IncomingShareError.noLongerPending
            }
            guard canStartIncomingShareImport else {
                do {
                    try await IncomingShareStore.returnClaim(id: claimed.id)
                } catch {
                    incomingShareID = claimed.id
                    incomingSharedPhotos = claimed.photos
                    log.error(
                        "Could not return busy incoming share \(claimed.id, privacy: .public): \(error.localizedDescription, privacy: .public)"
                    )
                }
                return .busy
            }
            incomingShareID = claimed.id
            incomingSharedPhotos = claimed.photos
            await processSelectedPhotos()
            if currentStep == .outingReview || showDuplicateConfirm {
                continuesShareQueueAfterDismissal = true
                return .accepted
            }
            return .failed
        } catch is CancellationError {
            return .cancelled
        } catch IncomingShareError.containerUnavailable {
            // Without the app group there is no queue to read, so there is also
            // nothing the person shared and nothing to report. Unsigned builds,
            // which the simulator test job produces, always land here.
            return .empty
        } catch let importError {
      log.error(
        "Could not import incoming shared photos: \(importError.localizedDescription, privacy: .public)"
      )
      self.error = AppError.map(
        importError, fallback: "Could not import the shared photos. Try again.")
            errorRecovery = .incomingShareImport
            return .failed
        }
    }

    private var canStartIncomingShareImport: Bool {
        currentStep == .selectPhotos
            && !isProcessing
            && !showDuplicateConfirm
            && selectedItems.isEmpty
            && cameraPhotos.isEmpty
            && pendingNewPhotos.isEmpty
            && pendingDuplicatePhotos.isEmpty
            && incomingShareID == nil
            && incomingSharedPhotos.isEmpty
    }

    // MARK: - Step 1: Process Selected Photos

    /// Load photos from the picker and camera, extract EXIF, generate thumbnails, cluster.
    func processSelectedPhotos() async {
    guard !selectedItems.isEmpty || !cameraPhotos.isEmpty || !incomingSharedPhotos.isEmpty else {
      return
    }
        guard !isProcessing else { return }
        isProcessing = true
        error = nil
        currentStep = .extracting
        totalCount = selectedItems.count + cameraPhotos.count + incomingSharedPhotos.count
        processedCount = 0
        extractionProgress = 0
        processingMessage = "Preparing photos..."
        let extractionGeneration = sessionGeneration
        async let preparedSession = prepareCurrentSession()

        // Reset accumulated stats for this upload session
        uploadSummary = nil
        newSpeciesNames = []

        var candidatePhotos: [ProcessedPhoto] = []
        var newPhotos: [ProcessedPhoto] = []
        var duplicatePhotos: [ProcessedPhoto] = []
        var rejectedSharedFileNames: [String] = []

    let preparationInputs =
      selectedItems.map(PhotoPreparationInput.picker)
            + incomingSharedPhotos.map(PhotoPreparationInput.shared)
        let preparationOutcomes: [PhotoPreparationOutcome]
        do {
            preparationOutcomes = try await preparePhotos(preparationInputs)
        } catch is CancellationError {
            cancelExtractionForSessionChange()
            return
        } catch let error as IncomingShareError {
            await releaseIncomingShare()
            self.error = .message(error.localizedDescription)
            currentStep = .selectPhotos
            isProcessing = false
            return
        } catch {
            await releaseIncomingShare()
      self.error = AppError.map(
        error, fallback: "Could not prepare the selected photos. Try again.")
            currentStep = .selectPhotos
            isProcessing = false
            return
        }
        for outcome in preparationOutcomes {
            if let photo = outcome.photo {
                candidatePhotos.append(photo)
            }
            if let fileName = outcome.rejectedSharedFileName {
                rejectedSharedFileNames.append(fileName)
            }
        }

        let preparedBytes = candidatePhotos.reduce(0) { $0 + $1.byteCount }
        guard preparedBytes <= IncomingShareStore.maximumTotalBytes else {
            PhotoFlowStore.remove(candidatePhotos.filter(\.cleanupOriginal).map(\.originalURL))
            await releaseIncomingShare()
            self.error = .message(IncomingShareError.shareTooLarge.localizedDescription)
            currentStep = .selectPhotos
            isProcessing = false
            return
        }

        processingMessage = "Preparing your WingDex..."
        let sessionID: UUID
        do {
            sessionID = try await preparedSession
        } catch {
            PhotoFlowStore.remove(candidatePhotos.filter(\.cleanupOriginal).map(\.originalURL))
            self.error = AppError.map(error, fallback: "Could not start a WingDex session. Try again.")
            errorRecovery = .sessionPreparation
            isProcessing = false
            return
        }
        guard sessionGeneration == extractionGeneration else {
            PhotoFlowStore.remove(candidatePhotos.filter(\.cleanupOriginal).map(\.originalURL))
            cancelExtractionForSessionChange()
            return
        }
        guard isCurrentSession(sessionID) else {
            PhotoFlowStore.remove(candidatePhotos.filter(\.cleanupOriginal).map(\.originalURL))
            cancelExtractionForSessionChange()
            return
        }
        if incomingShareID != nil, candidatePhotos.isEmpty {
            // Every photo in the batch failed to decode. The staged files are
            // immutable, so a retry reads the same bytes and fails again, and
            // leaving the batch pending blocks every newer batch behind it in
            // the FIFO queue. Accept it to drop it from the queue, and ask for
            // a fresh share instead of offering a retry that cannot succeed.
            await releaseIncomingShare()
      error = .message(
        "No shared photos could be read. Share them again in a supported image format.")
            errorRecovery = nil
            isProcessing = false
            // Close is disabled while the step is `.extracting`, so return to a
            // dismissible step. Otherwise dismissing the message strands the
            // person on an idle extraction screen they cannot leave.
            currentStep = .selectPhotos
            continuesShareQueueAfterDismissal = true
            return
        }
        guard isCurrentSession(sessionID) else {
            cancelExtractionForSessionChange()
            return
        }

        // Process camera-captured photos (no EXIF GPS; use the device location
        // captured at shot time, and the processing time as the timestamp).
        var totalPreparedBytes = candidatePhotos.reduce(0) { $0 + $1.byteCount }
        for camera in cameraPhotos {
            let uiImage = camera.image
            let id = UUID().uuidString
            let compressed = PhotoService.compressImage(uiImage, quality: 0.7) ?? Data()
            do {
                let fileURL = try PhotoFlowStore.writeCameraData(compressed)
                guard let prepared = PhotoService.preparePhoto(at: fileURL) else {
                    PhotoFlowStore.remove([fileURL])
                    continue
                }
        candidatePhotos.append(
          ProcessedPhoto(
                    id: id,
                    originalURL: fileURL,
                    cleanupOriginal: true,
                    thumbnail: prepared.thumbnail,
                    exifTime: Date(),
                    gpsLat: camera.lat,
                    gpsLon: camera.lon,
                    fileHash: prepared.fileHash,
                    fileName: "camera_\(id).jpg",
                    byteCount: prepared.byteCount
                ))
                guard prepared.byteCount <= IncomingShareStore.maximumTotalBytes - totalPreparedBytes else {
                    PhotoFlowStore.remove(candidatePhotos.filter(\.cleanupOriginal).map(\.originalURL))
                    await releaseIncomingShare()
                    cameraPhotos = []
                    error = .message(IncomingShareError.shareTooLarge.localizedDescription)
                    currentStep = .selectPhotos
                    isProcessing = false
                    return
                }
                totalPreparedBytes += prepared.byteCount
            } catch {
                PhotoFlowStore.remove(candidatePhotos.filter(\.cleanupOriginal).map(\.originalURL))
                await releaseIncomingShare()
                cameraPhotos = []
        self.error =
          if let error = error as? IncomingShareError {
                    .message(error.localizedDescription)
                } else {
                    AppError.map(error, fallback: "Could not prepare the captured photo.")
                }
                currentStep = .selectPhotos
                isProcessing = false
                return
            }
            processedCount += 1
            extractionProgress = Double(processedCount) / Double(totalCount) * 100
        }
        cameraPhotos = []
        guard isCurrentSession(sessionID) else {
            PhotoFlowStore.remove(candidatePhotos.filter(\.cleanupOriginal).map(\.originalURL))
            cancelExtractionForSessionChange()
            return
        }

        guard totalPreparedBytes <= IncomingShareStore.maximumTotalBytes else {
            PhotoFlowStore.remove(candidatePhotos.filter(\.cleanupOriginal).map(\.originalURL))
            await releaseIncomingShare()
            error = .message(IncomingShareError.shareTooLarge.localizedDescription)
            currentStep = .selectPhotos
            isProcessing = false
            return
        }
        for photo in candidatePhotos {
            appendByDuplicateStatus(photo, newPhotos: &newPhotos, duplicatePhotos: &duplicatePhotos)
        }

        if newPhotos.isEmpty && duplicatePhotos.isEmpty {
            error = .message("No photos to process.")
            currentStep = .selectPhotos
            isProcessing = false
            return
        }

        // Handle duplicates
        if !duplicatePhotos.isEmpty {
            pendingNewPhotos = newPhotos
            pendingDuplicatePhotos = duplicatePhotos
            pendingRejectedSharedPhotoCount = rejectedSharedFileNames.count
            currentStep = .selectPhotos
            isProcessing = false
            showDuplicateConfirm = true
            return
        }

        finishExtraction(photos: newPhotos)
        if !rejectedSharedFileNames.isEmpty {
            let count = rejectedSharedFileNames.count
            error = .message(
                count == 1
                    ? "One shared photo could not be read. Share it again in a supported image format."
                    : "\(count) shared photos could not be read. Share them again in a supported image format."
            )
        }
    }

  private func preparePhotos(_ inputs: [PhotoPreparationInput]) async throws
    -> [PhotoPreparationOutcome]
  {
        guard !inputs.isEmpty else { return [] }
        let concurrencyLimit = min(4, inputs.count)
        let batch = PhotoPreparationBatch()

        do {
            let outcomes = try await withThrowingTaskGroup(
                of: PhotoPreparationOutcome.self,
                returning: [PhotoPreparationOutcome].self
            ) { group in
                for index in 0..<concurrencyLimit {
                    let input = inputs[index]
                    group.addTask {
                        try await Self.preparePhoto(input, index: index, batch: batch)
                    }
                }

                var nextIndex = concurrencyLimit
        var ordered = [PhotoPreparationOutcome?](repeating: nil, count: inputs.count)
                while let outcome = try await group.next() {
                    ordered[outcome.index] = outcome
                    processedCount += 1
                    extractionProgress = Double(processedCount) / Double(totalCount) * 100

                    if nextIndex < inputs.count {
                        try Task.checkCancellation()
                        let index = nextIndex
                        let input = inputs[index]
                        group.addTask {
                            try await Self.preparePhoto(input, index: index, batch: batch)
                        }
                        nextIndex += 1
                    }
                }
                return ordered.compactMap { $0 }
            }
            batch.relinquishOwnedFiles()
            return outcomes
        } catch {
            batch.cleanupOwnedFiles()
            throw error
        }
    }

    private nonisolated static func preparePhoto(
        _ input: PhotoPreparationInput,
        index: Int,
        batch: PhotoPreparationBatch
    ) async throws -> PhotoPreparationOutcome {
        try Task.checkCancellation()
        switch input {
    case .picker(let item):
            var importedURL: URL?
            do {
                guard let imported = try await item.loadTransferable(type: ImportedPhotoFile.self) else {
                    return PhotoPreparationOutcome(index: index, photo: nil, rejectedSharedFileName: nil)
                }
                importedURL = imported.url
                batch.registerOwned(imported.url)
                try Task.checkCancellation()
        guard
          let photo = makeProcessedPhoto(
                    fileURL: imported.url,
                    fileName: nil,
                    cleanupOriginal: true
          )
        else {
                    PhotoFlowStore.remove([imported.url])
                    batch.unregisterOwned(imported.url)
                    return PhotoPreparationOutcome(index: index, photo: nil, rejectedSharedFileName: nil)
                }
                guard batch.reserve(photo.byteCount) else {
                    throw IncomingShareError.shareTooLarge
                }
                return PhotoPreparationOutcome(
                    index: index,
                    photo: photo,
                    rejectedSharedFileName: nil
                )
            } catch is CancellationError {
                if let importedURL {
                    PhotoFlowStore.remove([importedURL])
                    batch.unregisterOwned(importedURL)
                }
                throw CancellationError()
            } catch IncomingShareError.shareTooLarge {
                throw IncomingShareError.shareTooLarge
            } catch let error as IncomingShareError {
                throw error
            } catch {
                if let importedURL {
                    PhotoFlowStore.remove([importedURL])
                    batch.unregisterOwned(importedURL)
                }
                log.error("Failed to load a selected photo")
                return PhotoPreparationOutcome(index: index, photo: nil, rejectedSharedFileName: nil)
            }
    case .shared(let sharedPhoto):
            do {
                try Task.checkCancellation()
        guard
          let photo = makeProcessedPhoto(
                    fileURL: sharedPhoto.fileURL,
                    fileName: sharedPhoto.fileName,
                    cleanupOriginal: false
          )
        else {
          log.error(
            "Shared photo could not be decoded: \(sharedPhoto.fileName, privacy: .private(mask: .hash))"
          )
                    return PhotoPreparationOutcome(
                        index: index,
                        photo: nil,
                        rejectedSharedFileName: sharedPhoto.fileName
                    )
                }
                guard batch.reserve(photo.byteCount) else {
                    throw IncomingShareError.shareTooLarge
                }
                return PhotoPreparationOutcome(index: index, photo: photo, rejectedSharedFileName: nil)
            } catch is CancellationError {
                throw CancellationError()
            } catch IncomingShareError.shareTooLarge {
                throw IncomingShareError.shareTooLarge
            } catch {
        log.error(
          "Shared photo read failed after retry: \(sharedPhoto.fileName, privacy: .private(mask: .hash))"
        )
                return PhotoPreparationOutcome(
                    index: index,
                    photo: nil,
                    rejectedSharedFileName: sharedPhoto.fileName
                )
            }
        }
    }

    private func cancelExtractionForSessionChange() {
        cleanupPhotoFiles()
        isProcessing = false
        currentStep = .selectPhotos
        processingMessage = ""
        processedCount = 0
        totalCount = 0
        extractionProgress = 0
    }

    private nonisolated static func makeProcessedPhoto(
        fileURL: URL,
        fileName: String?,
        cleanupOriginal: Bool
    ) -> ProcessedPhoto? {
        guard let prepared = PhotoService.preparePhoto(at: fileURL) else { return nil }
        let id = UUID().uuidString
        return ProcessedPhoto(
            id: id,
            originalURL: fileURL,
            cleanupOriginal: cleanupOriginal,
            thumbnail: prepared.thumbnail,
            exifTime: prepared.exifTime,
            gpsLat: prepared.gpsLat,
            gpsLon: prepared.gpsLon,
            fileHash: prepared.fileHash,
            fileName: fileName ?? fileURL.lastPathComponent,
            byteCount: prepared.byteCount
        )
    }

    private func appendByDuplicateStatus(
        _ photo: ProcessedPhoto,
        newPhotos: inout [ProcessedPhoto],
        duplicatePhotos: inout [ProcessedPhoto]
    ) {
        let isDuplicate = dataStore?.containsPhoto(fileHash: photo.fileHash) ?? false
        if isDuplicate {
            duplicatePhotos.append(photo)
        } else {
            newPhotos.append(photo)
        }
    }

    /// Called after duplicate resolution - finalize extraction with the chosen photos.
    func handleDuplicateChoice(reimport: Bool) async {
        showDuplicateConfirm = false
        if !reimport {
            PhotoFlowStore.remove(pendingDuplicatePhotos.filter(\.cleanupOriginal).map(\.originalURL))
        }
    let finalPhotos =
      reimport
            ? pendingNewPhotos + pendingDuplicatePhotos
            : pendingNewPhotos
        pendingNewPhotos = []
        pendingDuplicatePhotos = []
        let rejectedSharedPhotoCount = pendingRejectedSharedPhotoCount
        pendingRejectedSharedPhotoCount = 0

        if finalPhotos.isEmpty {
            selectedItems = []
            await finalizeDiscardedShare()
            currentStep = .selectPhotos
            if rejectedSharedPhotoCount > 0 {
                error = .message(
                    rejectedSharedPhotoCount == 1
                        ? "One shared photo could not be read. Share it again in a supported image format."
                        : "\(rejectedSharedPhotoCount) shared photos could not be read. Share them again in a supported image format."
                )
            } else {
                flowDismissalRequestID = UUID()
            }
            return
        }

        currentStep = .extracting
        finishExtraction(photos: finalPhotos)
        if rejectedSharedPhotoCount > 0 {
            error = .message(
                rejectedSharedPhotoCount == 1
                    ? "One shared photo could not be read. Share it again in a supported image format."
                    : "\(rejectedSharedPhotoCount) shared photos could not be read. Share them again in a supported image format."
            )
        }
    }

    private func finishExtraction(photos: [ProcessedPhoto]) {
        processedPhotos = photos
        processingMessage = "Clustering into outings..."
        clusters = PhotoService.clusterPhotos(photos)

        // Photos without EXIF time go into a single "Unknown Date" cluster
        let noDate = photos.filter { $0.exifTime == nil }
    if !noDate.isEmpty
      && !clusters.contains(where: { $0.photos.contains(where: { $0.exifTime == nil }) })
    {
      clusters.append(
        PhotoCluster(
                photos: noDate,
                startTime: Date(),
                endTime: Date(),
                centerLat: nil,
                centerLon: nil
            ))
        }

        log.info("Processed \(photos.count) photos into \(self.clusters.count) clusters")
        isProcessing = false
        currentClusterIndex = 0
        currentStep = .outingReview
    }

    // MARK: - Step 2: Outing Confirmed -> Start Per-Photo Loop

    /// Called when the user confirms the outing in OutingReviewView.
    /// Stages the outing and photo metadata, then starts the per-photo AI identification loop.
    /// Server writes occur only after the prepared upload synchronizes.
    /// Pass `outing` for a new outing, or nil when merging into one that already exists.
    /// Nothing is written until the cluster produces at least one sighting.
    func outingConfirmed(
        outing: Outing?,
        outingId: String,
        locationName: String,
        lat: Double?,
        lon: Double?,
        outingOverridesPhotoGPS: Bool
    ) {
        guard (try? requireCurrentSession()) != nil else { return }
        let normalizedName = locationName.trimmingCharacters(in: .whitespacesAndNewlines)
        lastLocationName = normalizedName
        currentOutingId = outingId
        outingInferenceLocation = if let lat, let lon { (lat: lat, lon: lon) } else { nil }
        self.outingOverridesPhotoGPS = outingOverridesPhotoGPS
        pendingOuting = outing
    preparedUpload = nil
        photoResults = []
        currentCandidates = []
        rangeAdjusted = false
        cropPromptContext = .manualRecrop
        currentPhotoIndex = 0

        Task { await runSpeciesId(photoIndex: 0) }
    }

  private func photoMetadata(outingId: String) -> [DataService.PhotoPayload] {
        let formatter = ISO8601DateFormatter()
    return clusterPhotos.map { photo in
            DataService.PhotoPayload(
                id: photo.id,
                outingId: outingId,
                exifTime: photo.exifTime.map { formatter.string(from: $0) },
                gps: (photo.gpsLat != nil && photo.gpsLon != nil)
                    ? DataService.PhotoPayload.PhotoGPS(lat: photo.gpsLat!, lon: photo.gpsLon!)
                    : nil,
                fileHash: photo.fileHash,
                fileName: photo.fileName
            )
        }
    }

    // MARK: - Step 3: Species Identification (on-device)

    /// Identify a single photo with the bundled WingCLIP model.
    ///
    /// Runs entirely on device, so there is no network call, no rate limit and
    /// no fast/strong escalation: there is one model and it takes milliseconds.
    ///
    /// Three things the server used to return and a classifier cannot: a crop
    /// box (it sees the whole frame and localises nothing), a multiple-birds
    /// flag (nothing here counts birds), and an empty candidate list. The
    /// classifier ALWAYS returns 25 ranked species, so "no bird found" is not
    /// expressible and the confidence gate replaces it.
    func runSpeciesId(photoIndex: Int, croppedImageData: Data? = nil) async {
        guard let sessionID = try? requireCurrentSession() else { return }
        let photos = clusterPhotos
        guard photoIndex < photos.count else { return }
        let photo = photos[photoIndex]

        currentPhotoIndex = photoIndex
        error = nil
        errorRecovery = nil
        currentStep = .photoProcessing

        let isCropped = croppedImageData != nil || photo.croppedImage != nil
        processingMessage = "Photo \(photoIndex + 1)/\(photos.count): Identifying species..."

        let originalImageData: Data
        do {
            if activeImagePhotoID == photo.id, let activeImageData {
                originalImageData = activeImageData
            } else {
                originalImageData = try await Task.detached(priority: .userInitiated) {
                    try Data(contentsOf: photo.originalURL, options: .mappedIfSafe)
                }.value
                guard isCurrentSession(sessionID), currentPhotoIndex == photoIndex else { return }
                activeImageData = originalImageData
                activeImagePhotoID = photo.id
            }
        } catch is CancellationError {
            return
        } catch {
            guard isCurrentSession(sessionID), currentPhotoIndex == photoIndex else { return }
            self.error = .message("Could not read this photo. Try again or skip it.")
      errorRecovery = .speciesIdentification(
        photoIndex: photoIndex, croppedImageData: croppedImageData)
            currentCandidates = []
            rangeAdjusted = false
            currentStep = .perPhotoConfirm
            return
        }
        let imageToSend = croppedImageData ?? photo.croppedImage ?? originalImageData

        #if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
      let stubConfidence: Double? =
        if arguments.contains("--ui-test-stub-low-confidence-identification") {
            0.5
        } else if arguments.contains("--ui-test-stub-identification") {
            0.95
        } else {
            nil
        }
        if let stubConfidence {
        currentCandidates = [
          IdentifiedCandidate(
                species: "Great Blue Heron (Ardea herodias)",
                confidence: stubConfidence,
                wikiTitle: nil,
                plumage: nil
          )
        ]
            rangeAdjusted = false
            if !isCropped, shouldPromptForCrop(currentCandidates) {
                cropPromptContext = .lowConfidence
                currentStep = .manualCrop
            } else {
                currentStep = .perPhotoConfirm
            }
            return
        }
        #endif

        do {
            let location = inferenceLocation(for: photo)
            // 1-12. The old server API took 0-11, so this deliberately does NOT
            // subtract one: a 0 would be rejected by the v3 prior and silently
            // drop back to vision-only.
            let month: Int? = {
                guard useGeoContext, let date = photo.exifTime else { return nil }
                return Calendar.current.component(.month, from: date)
            }()

            let results = try await BirdIdEngine.shared.identify(
                imageData: imageToSend,
                location: location,
                month: month
            )
            guard isCurrentSession(sessionID) else { return }

            let mapped = results.map {
                IdentifiedCandidate(
                    species: "\($0.commonName) (\($0.scientificName))",
                    confidence: $0.confidence,
                    wikiTitle: nil,
                    plumage: nil
                )
            }

            // ABSTENTION. Below the probe threshold this is very likely not a
            // bird, so the candidates are DROPPED and the flow falls through to
            // the no-candidates empty state. Mirrors identifyBirdLocally in
            // src/lib/bird-id-local-adapter.ts, so both platforms abstain on
            // exactly the same photos.
            //
            // The ranked species are discarded rather than shown at a low
            // confidence: at P_cal 0.37 the top species is still a
            // confident-looking guess at what KIND of bird it would be if it
            // were one, and dogs come back as African Penguin. Offering that
            // list would invite the user to pick from it.
            let pBird = results.first?.pBird
            let abstained = pBird.map { $0 < BirdIdEngine.birdProbeThreshold } ?? false
            let candidates = abstained ? [] : mapped

      log.info(
        "Found \(candidates.count) candidates for photo \(photoIndex + 1)\(abstained ? " (abstained on the bird probe)" : "")"
      )
            rangeAdjusted = !abstained && results.contains { $0.logP != nil }
            currentCandidates = candidates

            // An abstention already routes to the empty state, which offers
            // Crop & Retry as its primary action. Prompting for a crop here as
            // well would send it to the manual-crop step instead and the empty
            // state would never be seen. Otherwise low confidence is the only
            // signal, and cropping an already-cropped photo would loop forever
            // because confidence tracks SPECIES AMBIGUITY, not framing.
            if !isCropped, !abstained, shouldPromptForCrop(candidates) {
                cropPromptContext = .lowConfidence
                currentStep = .manualCrop
            } else {
                cropPromptContext = .manualRecrop
                currentStep = .perPhotoConfirm
            }
        } catch is CancellationError {
            return
        } catch {
            log.error("Species identification failed for photo index \(photoIndex + 1)")
            self.error = AppError.map(
                error,
                fallback: "Could not identify this photo. Try again or skip it."
            )
      errorRecovery = .speciesIdentification(
        photoIndex: photoIndex, croppedImageData: croppedImageData)
            currentCandidates = []
            rangeAdjusted = false
            currentStep = .perPhotoConfirm
        }
    }

    /// Select location context for the range prior.
    ///
    /// A searched outing location is an explicit correction and wins. Without
    /// one, per-photo GPS is more precise, while the outing coordinate remains
    /// a useful fallback for cameras that do not record GPS.
    static func resolveInferenceLocation(
        useGeoContext: Bool,
        photoLat: Double?,
        photoLon: Double?,
        outingLocation: (lat: Double, lon: Double)?,
        outingOverridesPhotoGPS: Bool
    ) -> (lat: Double, lon: Double)? {
        guard useGeoContext else { return nil }
        if outingOverridesPhotoGPS, let outingLocation { return outingLocation }
        if let photoLat, let photoLon { return (lat: photoLat, lon: photoLon) }
        return outingLocation
    }

    private func inferenceLocation(for photo: ProcessedPhoto) -> (lat: Double, lon: Double)? {
        Self.resolveInferenceLocation(
            useGeoContext: useGeoContext,
            photoLat: photo.gpsLat,
            photoLon: photo.gpsLon,
            outingLocation: outingInferenceLocation,
            outingOverridesPhotoGPS: outingOverridesPhotoGPS
        )
    }

    // MARK: - Step 4: Per-Photo Confirmation

    /// User confirms species for the current photo with a certainty level.
  func confirmCurrentPhoto(
    species: String, confidence: Double, status: ObservationStatus, count: Int
  ) {
        let result = PhotoResult(
            photoId: currentPhoto?.id ?? "",
            species: species,
            confidence: confidence,
            status: status,
            count: count
        )
        photoResults.append(result)
        advanceToNextPhoto()
    }

    /// Skip the current photo (exclude from save).
    func skipCurrentPhoto() {
        advanceToNextPhoto()
    }

    /// Go back to the previous photo, removing its result so the user can re-decide.
    func goBackToPreviousPhoto() {
        guard currentPhotoIndex > 0 else { return }
        if !photoResults.isEmpty {
            photoResults.removeLast()
        }
        currentCandidates = []
        rangeAdjusted = false
        Task { await runSpeciesId(photoIndex: currentPhotoIndex - 1) }
    }

    /// Trigger manual crop, then re-identify with the cropped image.
    func requestManualCrop() {
        cropPromptContext = .manualRecrop
        currentStep = .manualCrop
    }

    /// Run identification again for the current photo using its latest crop, if any.
    func reidentifyCurrentPhoto() {
        Task { await runSpeciesId(photoIndex: currentPhotoIndex) }
    }

    /// Remove a photo before identification and keep the cluster state valid.
    func removePhotoFromCurrentCluster(id: String) async {
        guard currentClusterIndex < clusters.count else { return }
        if let photo = processedPhotos.first(where: { $0.id == id }), photo.cleanupOriginal {
            PhotoFlowStore.remove([photo.originalURL])
        }
        clusters[currentClusterIndex].photos.removeAll { $0.id == id }
        processedPhotos.removeAll { $0.id == id }

        if clusters[currentClusterIndex].photos.isEmpty {
            clusters.remove(at: currentClusterIndex)
            if clusters.isEmpty {
                currentClusterIndex = 0
                selectedItems = []
                await finalizeDiscardedShare()
                currentStep = .selectPhotos
                flowDismissalRequestID = UUID()
            } else if currentClusterIndex >= clusters.count {
                currentClusterIndex = clusters.count - 1
            }
        }
    }

    /// After user crops, re-identify the cropped image.
    func handleCropComplete(croppedImageData: Data) {
        storeCroppedImage(photoId: currentPhoto?.id, imageData: croppedImageData)
        Task { await runSpeciesId(photoIndex: currentPhotoIndex, croppedImageData: croppedImageData) }
    }

    /// Cancel crop -> go to confirm screen with current (possibly empty) candidates.
    func cancelCrop() {
        rangeAdjusted = false
        currentStep = .perPhotoConfirm
    }

    // MARK: - Advance / Save

    /// Move to the next photo or save when all photos in the cluster are done.
    private func advanceToNextPhoto() {
        activeImageData = nil
        activeImagePhotoID = nil
        let nextIdx = currentPhotoIndex + 1
        if nextIdx < clusterPhotos.count {
            currentCandidates = []
            rangeAdjusted = false
            cropPromptContext = .manualRecrop
            // Leave the confirm screen in the same update that clears the candidates, or it
            // renders its empty state for a frame and flashes a question mark.
            currentStep = .photoProcessing
            Task { await runSpeciesId(photoIndex: nextIdx) }
        } else {
            currentStep = .saving
            Task { await saveCurrentCluster() }
        }
    }

    /// Save all confirmed observations for the current cluster,
    /// then advance to the next cluster or finish.
    private func saveCurrentCluster() async {
        guard let sessionID = try? requireCurrentSession() else { return }
    guard let store = dataStore, let accountID else { return }
        currentStep = .saving
        isProcessing = true
        processingMessage = "Saving..."
        error = nil
        errorRecovery = nil

        let confirmed = sightingResults(photoResults)
        // Compare on the dex key, not the display name. DexEntry.id is the
        // code-or-name key, so a bird saved under a different spelling of a
        // species already in the dex is no longer announced as new.
        let existingSpecies = Set(store.dex.map(\.id))

        // Group by species, sum counts
    var speciesMap:
      [String: (count: Int, status: ObservationStatus, photoId: String, confidences: [Double])] =
        [:]
        for r in confirmed {
            if let existing = speciesMap[r.species] {
                speciesMap[r.species] = (
                    existing.count + r.count,
                    existing.status,
                    existing.photoId,
                    existing.confidences + [r.confidence]
                )
            } else {
                speciesMap[r.species] = (r.count, r.status, r.photoId, [r.confidence])
            }
        }

    let observations =
      preparedObservations
      ?? speciesMap.map { species, info in
                BirdObservation(
                    id: "obs_\(UUID().uuidString)",
                    outingId: currentOutingId,
                    speciesName: species,
                    count: info.count,
                    certainty: info.status,
                    representativePhotoId: info.photoId,
                    // An observation covers every photo of the species, so average their scores.
                    aiConfidence: info.confidences.reduce(0, +) / Double(info.confidences.count),
                    notes: ""
                )
            }
        preparedObservations = observations

        do {
            if !observations.isEmpty {
        let existingOuting =
          pendingOuting == nil ? store.outings.first { $0.id == currentOutingId } : nil
        let upload =
          preparedUpload
          ?? PendingPhotoUpload(
            id: "upload_\(UUID().uuidString)",
            accountID: accountID,
            createdAt: .now,
            locationName: pendingOuting?.locationName ?? existingOuting?.locationName ?? lastLocationName,
            outing: pendingOuting,
            outingRecoverySnapshot: existingOuting,
            photos: photoMetadata(outingId: currentOutingId),
            observations: observations
          )
        preparedUpload = upload
        let saveResult = try await store.savePhotoUpload(upload)
                guard isCurrentSession(sessionID) else { return }
        pendingOuting = nil

                // Count new species by diffing the recomputed dex against the
                // snapshot taken before the save. The observations built above
                // omit speciesCode, so keying them would read as name:<name>
                // while the dex keys as code:<code>, flagging existing species
                // as new after almost every save. The server resolves codes and
                // returns the authoritative dex, so a key diff is exact.
        let newDexEntries: [DexEntry] =
          switch saveResult {
          case .synced:
            store.dex.filter { !existingSpecies.contains($0.id) }
          case .queued:
            []
          }
                let clusterNewSpecies = newDexEntries.count
                for entry in newDexEntries {
                    newSpeciesNames.append(getDisplayName(entry.speciesName))
                }
                newSpeciesCount += clusterNewSpecies
                savedOutingCount += 1
                savedObservationCount += observations.count
        if case .queued = saveResult {
          sessionQueuedUploadIDs.insert(upload.id)
        }

                // Accumulate upload summary
        let outingName = upload.locationName
                let uniqueSpecies = Set(confirmed.map(\.species)).count
                let totalCount = confirmed.reduce(0) { $0 + $1.count }
                if var summary = uploadSummary {
                    summary.newSpecies += clusterNewSpecies
                    summary.outings += 1
                    summary.totalSpecies += uniqueSpecies
                    summary.totalCount += totalCount
                    if !outingName.isEmpty && !summary.locationNames.contains(outingName) {
                        summary.locationNames.append(outingName)
                    }
                    uploadSummary = summary
                } else {
                    uploadSummary = UploadSummary(
                        newSpecies: clusterNewSpecies,
                        outings: 1,
                        totalSpecies: uniqueSpecies,
                        totalCount: totalCount,
                        locationNames: outingName.isEmpty ? [] : [outingName]
                    )
                }

        processingMessage =
          switch saveResult {
          case .synced: "Outing saved!"
          case .queued: "Saved on this device"
          }
                try? await Task.sleep(for: .milliseconds(1200))
                guard isCurrentSession(sessionID) else { return }
            }

            // Move to next cluster or finish
            if currentClusterIndex < clusters.count - 1 {
                preparedObservations = nil
        preparedUpload = nil
                currentClusterIndex += 1
                currentPhotoIndex = 0
                photoResults = []
                currentCandidates = []
                rangeAdjusted = false
                cropPromptContext = .manualRecrop
                currentStep = .outingReview
            } else {
                preparedObservations = nil
        preparedUpload = nil
                await finishCompletedFlow()
            }
        } catch is CancellationError {
            return
        } catch {
            self.error = AppError.map(error, fallback: "Could not save this outing. Try again.")
            errorRecovery = .saveCluster
            log.error("Failed to save the current photo cluster")
        }
        isProcessing = false
    }

    func retryCurrentError() {
        let recovery = errorRecovery
        error = nil
        errorRecovery = nil
        switch recovery {
        case .incomingShareImport:
            Task { _ = await importIncomingShareIfAvailable() }
        case .sessionPreparation:
            Task { await processSelectedPhotos() }
        case .speciesIdentification(let photoIndex, let croppedImageData):
            Task { await runSpeciesId(photoIndex: photoIndex, croppedImageData: croppedImageData) }
        case .saveCluster:
            Task { await saveCurrentCluster() }
        case nil:
            break
        }
    }

    private func requireCurrentSession() throws -> UUID {
        guard let accountID,
              dataStore?.activeAccountID == accountID,
      dataStore?.hasReadableData == true
        else {
            throw AuthError.notAuthenticated
        }
        return sessionGeneration
    }

    private func prepareCurrentSession() async throws -> UUID {
        guard let authService, let dataStore else { throw AuthError.notAuthenticated }
        try await authService.ensureAnonymousSession()
        guard let resolvedAccountID = authService.userId else { throw AuthError.notAuthenticated }

        if dataStore.activeAccountID != resolvedAccountID {
            dataStore.activate(accountID: resolvedAccountID)
        }
    try await dataStore.ensureReadableData()
        configure(auth: authService, dataStore: dataStore)
        return try requireCurrentSession()
    }

    private func isCurrentSession(_ sessionID: UUID) -> Bool {
        guard sessionGeneration == sessionID, let accountID else { return false }
    return dataStore?.activeAccountID == accountID && dataStore?.hasReadableData == true
    }

    // MARK: - Helpers

    /// Compress a UIImage to 640px max and encode as a data URL for the API.
    /// Should the app ask the user to crop?
    ///
    /// Only when the top candidate is below threshold. The caller also guards
    /// on `isCropped`, because confidence tracks species ambiguity rather than
    /// framing (Pearson 0.051 against relative bird area), so a crop often does
    /// not raise it and prompting again would never resolve.
    private func shouldPromptForCrop(_ candidates: [IdentifiedCandidate]) -> Bool {
        guard let top = candidates.first else { return true }
        return top.confidence < BirdIdEngine.confidencePromptThreshold
    }

    /// Store a crop box on a photo for later use in CropView.

    private func storeCroppedImage(photoId: String?, imageData: Data) {
        guard let photoId else { return }
        let thumbnail = PhotoService.generateThumbnail(from: imageData) ?? imageData

        if let idx = processedPhotos.firstIndex(where: { $0.id == photoId }) {
            processedPhotos[idx].croppedImage = imageData
            processedPhotos[idx].thumbnail = thumbnail
        }

        for ci in clusters.indices {
            for pi in clusters[ci].photos.indices where clusters[ci].photos[pi].id == photoId {
                clusters[ci].photos[pi].croppedImage = imageData
                clusters[ci].photos[pi].thumbnail = thumbnail
            }
        }
    }

    private func cleanupPhotoFiles() {
    let photos =
      processedPhotos
            + pendingNewPhotos
            + pendingDuplicatePhotos
            + clusters.flatMap(\.photos)
        PhotoFlowStore.remove(photos.filter(\.cleanupOriginal).map(\.originalURL))
        activeImageData = nil
        activeImagePhotoID = nil
        incomingSharedPhotos = []
    }

    private func finalizeDiscardedShare() async {
        sessionGeneration = UUID()
        await releaseIncomingShare()
        cleanupPhotoFiles()
    }

    private func resetFlowForAccountChange() {
        cleanupPhotoFiles()
        selectedItems = []
        processedPhotos = []
        cameraPhotos = []
        clusters = []
        currentClusterIndex = 0
        currentPhotoIndex = 0
        currentCandidates = []
        photoResults = []
        currentOutingId = ""
        outingInferenceLocation = nil
        outingOverridesPhotoGPS = false
        pendingOuting = nil
        preparedObservations = nil
    preparedUpload = nil
        pendingNewPhotos = []
        pendingDuplicatePhotos = []
        pendingRejectedSharedPhotoCount = 0
        showDuplicateConfirm = false
        isProcessing = false
        processingMessage = ""
        processedCount = 0
        totalCount = 0
        extractionProgress = 0
        error = nil
        errorRecovery = nil
        uploadSummary = nil
        savedOutingCount = 0
        savedObservationCount = 0
        newSpeciesCount = 0
    sessionQueuedUploadIDs.removeAll()
        newSpeciesNames = []
        continuesShareQueueAfterDismissal = false
        stoppedShareQueueAfterDismissal = true
        currentStep = .selectPhotos
        flowDismissalRequestID = UUID()
        Task { await releaseIncomingShare() }
    }

    private func releaseIncomingShare() async {
        guard let incomingShareID else { return }
        do {
            try await IncomingShareStore.releaseClaim(id: incomingShareID)
            guard self.incomingShareID == incomingShareID else { return }
            self.incomingShareID = nil
            incomingSharedPhotos = []
        } catch {
            log.error(
                "Could not clean incoming share \(incomingShareID, privacy: .public): \(error.localizedDescription, privacy: .public)"
            )
        }
    }

    private func finishCompletedFlow() async {
        await releaseIncomingShare()
        error = nil
        errorRecovery = nil
        currentStep = .done
    }

}

/// Photos that count as a sighting. A cluster with none of these earned no outing, so it is
/// neither written nor counted towards the upload summary.
func sightingResults(_ results: [PhotoResult]) -> [PhotoResult] {
    results.filter { $0.status == .confirmed || $0.status == .possible }
}

private enum ErrorRecovery {
    case incomingShareImport
    case sessionPreparation
    case speciesIdentification(photoIndex: Int, croppedImageData: Data?)
    case saveCluster
}

// MARK: - Supporting Types

/// A photo after metadata extraction and thumbnail generation.
struct ProcessedPhoto: Identifiable, Sendable {
    let id: String
    let originalURL: URL
    let cleanupOriginal: Bool
    var thumbnail: Data    // Small thumbnail for display
    let exifTime: Date?
    let gpsLat: Double?
    let gpsLon: Double?
    let fileHash: String
    let fileName: String
    let byteCount: Int
    /// User-confirmed cropped image used for re-analysis and preview, matching web croppedDataUrl.
    var croppedImage: Data? = nil
}

/// A group of photos clustered into a single outing by time and GPS proximity.
struct PhotoCluster: Identifiable {
    let id = UUID()
    var photos: [ProcessedPhoto]
    var startTime: Date
    var endTime: Date
    var centerLat: Double?
    var centerLon: Double?
}

/// Result from the AI bird identification endpoint.
struct IdentificationResult {
    let candidates: [IdentifiedCandidate]
    let cropBox: CropBoxResult?
    let multipleBirds: Bool
}

/// A single AI candidate species with confidence score.
struct IdentifiedCandidate {
    let species: String
    let confidence: Double
    let wikiTitle: String?
    let plumage: String?
}

/// AI crop box in percentage coordinates (0-100).
struct CropBoxResult: Equatable, Sendable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

/// Result of per-photo confirmation by the user.
struct PhotoResult {
    let photoId: String
    let species: String
    let confidence: Double
    let status: ObservationStatus
    let count: Int
}

/// Accumulated stats for the upload summary screen.
struct UploadSummary {
    var newSpecies: Int
    var outings: Int
    var totalSpecies: Int
    var totalCount: Int
    var locationNames: [String]
}
