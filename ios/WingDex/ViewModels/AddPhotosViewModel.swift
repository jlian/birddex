import CryptoKit
import Foundation
import Observation
import PhotosUI
import SwiftUI
import os

private let log = Logger(subsystem: Config.bundleID, category: "AddPhotos")

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

    enum CropPromptContext: Equatable {
        case manualRecrop
        case lowConfidence

        var reasonText: String {
            switch self {
            case .manualRecrop:
                return "For best results, crop to one bird"
            case .lowConfidence:
                return "Not sure about this one, crop to the bird"
            }
        }
    }

    // MARK: - Step State Machine

    /// All possible steps in the add-photos wizard.
    enum Step: Equatable {
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

    /// Location name from the most recent outing - used as default for new outings.
    var lastLocationName = ""

    /// The outing ID that the current cluster is being saved into.
    var currentOutingId = ""

    // MARK: - Per-Photo Identification State

    /// Index of the photo currently being processed/confirmed within the current cluster.
    var currentPhotoIndex = 0

    /// AI candidates for the photo currently being confirmed.
    var currentCandidates: [IdentifiedCandidate] = []

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
    private var errorRecovery: ErrorRecovery?
    private var preparedObservations: [BirdObservation]?

    var canRetryError: Bool { errorRecovery != nil }

    // MARK: - Duplicate Detection

    var pendingNewPhotos: [ProcessedPhoto] = []
    var pendingDuplicatePhotos: [ProcessedPhoto] = []
    var showDuplicateConfirm = false

    // MARK: - Results After Save

    /// Accumulated stats across all clusters in this upload session.
    var uploadSummary: UploadSummary?
    var savedOutingCount = 0
    var savedObservationCount = 0
    var newSpeciesCount = 0
    /// Display names of species newly added to the dex during this upload session.
    var newSpeciesNames: [String] = []

    // MARK: - Dependencies

    private var dataService: DataService?
    private var dataStore: DataStore?
    private var accountID: String?
    private var sessionGeneration = UUID()

    func configure(auth: AuthService, dataStore: DataStore) {
        let accountID = dataStore.activeAccountID
        if self.accountID != accountID {
            sessionGeneration = UUID()
        }
        self.accountID = accountID
        dataService = DataService(auth: auth, expectedAccountID: accountID)
        self.dataStore = dataStore
        // Initialize lastLocationName from the most recent outing
        if let mostRecent = dataStore.outings
            .sorted(by: { DateFormatting.sortDate($0.createdAt) > DateFormatting.sortDate($1.createdAt) })
            .first
        {
            lastLocationName = mostRecent.locationName
        }
    }

    func cancelSession() {
        sessionGeneration = UUID()
        accountID = nil
        dataService = nil
        dataStore = nil
    }

    func createOuting(_ outing: Outing) async throws -> Outing {
        let sessionID = try requireCurrentSession()
        guard let service = dataService else { throw AuthError.notAuthenticated }
        let saved = try await service.createOuting(outing)
        guard isCurrentSession(sessionID) else { throw CancellationError() }
        return saved
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

    func importIncomingShareIfAvailable() async {
        guard currentStep == .selectPhotos else { return }
        do {
            guard let snapshot = try IncomingShareStore.pendingShare() else { return }
            incomingShareID = snapshot.id
            incomingSharedPhotos = snapshot.photos
            await processSelectedPhotos()
        } catch {
            self.error = AppError.map(error, fallback: "Could not import the shared photos. Try again.")
        }
    }

    // MARK: - Step 1: Process Selected Photos

    /// Load photos from the picker and camera, extract EXIF, generate thumbnails, cluster.
    func processSelectedPhotos() async {
        guard !selectedItems.isEmpty || !cameraPhotos.isEmpty || !incomingSharedPhotos.isEmpty else { return }
        guard let sessionID = try? requireCurrentSession() else { return }
        isProcessing = true
        error = nil
        currentStep = .extracting
        totalCount = selectedItems.count + cameraPhotos.count + incomingSharedPhotos.count
        processedCount = 0
        extractionProgress = 0
        processingMessage = "Reading photo data..."

        // Reset accumulated stats for this upload session
        uploadSummary = nil
        newSpeciesNames = []

        var newPhotos: [ProcessedPhoto] = []
        var duplicatePhotos: [ProcessedPhoto] = []
        var rejectedSharedFileNames: [String] = []

        for item in selectedItems {
            do {
                guard let data = try await item.loadTransferable(type: Data.self) else { continue }
                guard isCurrentSession(sessionID) else {
                    cancelExtractionForSessionChange()
                    return
                }
                if let photo = makeProcessedPhoto(data: data, fileName: nil) {
                    appendByDuplicateStatus(photo, newPhotos: &newPhotos, duplicatePhotos: &duplicatePhotos)
                }
            } catch {
                log.error("Failed to load a selected photo")
            }
            processedCount += 1
            extractionProgress = Double(processedCount) / Double(totalCount) * 100
        }

        for sharedPhoto in incomingSharedPhotos {
            guard isCurrentSession(sessionID) else {
                cancelExtractionForSessionChange()
                return
            }
            do {
                let data = try await readSharedPhotoData(from: sharedPhoto.fileURL)
                if let photo = makeProcessedPhoto(data: data, fileName: sharedPhoto.fileName) {
                    appendByDuplicateStatus(photo, newPhotos: &newPhotos, duplicatePhotos: &duplicatePhotos)
                } else {
                    log.error("Shared photo could not be decoded: \(sharedPhoto.fileName, privacy: .private(mask: .hash))")
                    rejectedSharedFileNames.append(sharedPhoto.fileName)
                }
            } catch {
                log.error("Shared photo read failed after retry: \(sharedPhoto.fileName, privacy: .private(mask: .hash))")
                rejectedSharedFileNames.append(sharedPhoto.fileName)
            }
            processedCount += 1
            extractionProgress = Double(processedCount) / Double(totalCount) * 100
        }
        guard isCurrentSession(sessionID) else {
            cancelExtractionForSessionChange()
            return
        }
        if let incomingShareID {
            try? IncomingShareStore.completePendingShare(id: incomingShareID)
        }
        incomingShareID = nil
        incomingSharedPhotos = []

        // Process camera-captured photos (no EXIF GPS; use the device location
        // captured at shot time, and the processing time as the timestamp).
        for camera in cameraPhotos {
            let uiImage = camera.image
            let id = UUID().uuidString
            let compressed = PhotoService.compressImage(uiImage, quality: 0.7) ?? Data()
            let thumbnail = PhotoService.generateThumbnail(from: compressed, maxDimension: 200) ?? compressed
            let fileHash = computeFileHash(compressed)

            let photo = ProcessedPhoto(
                id: id,
                image: compressed,
                thumbnail: thumbnail,
                exifTime: Date(),
                gpsLat: camera.lat,
                gpsLon: camera.lon,
                fileHash: fileHash,
                fileName: "camera_\(id).jpg"
            )
            newPhotos.append(photo)
            processedCount += 1
            extractionProgress = Double(processedCount) / Double(totalCount) * 100
        }
        cameraPhotos = []

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

    private func readSharedPhotoData(from fileURL: URL) async throws -> Data {
        do {
            return try await readSharedPhotoDataOnce(from: fileURL, options: .mappedIfSafe)
        } catch {
            try Task.checkCancellation()
            try await Task.sleep(for: .milliseconds(100))
            return try await readSharedPhotoDataOnce(from: fileURL, options: [])
        }
    }

    private func readSharedPhotoDataOnce(
        from fileURL: URL,
        options: Data.ReadingOptions
    ) async throws -> Data {
        let readTask = Task.detached(priority: .userInitiated) {
            let data = try Data(contentsOf: fileURL, options: options)
            guard !data.isEmpty else { throw CocoaError(.fileReadCorruptFile) }
            return data
        }
        return try await withTaskCancellationHandler {
            try await readTask.value
        } onCancel: {
            readTask.cancel()
        }
    }

    private func cancelExtractionForSessionChange() {
        isProcessing = false
        currentStep = .selectPhotos
        processingMessage = ""
        processedCount = 0
        totalCount = 0
        extractionProgress = 0
    }

    private func makeProcessedPhoto(data: Data, fileName: String?) -> ProcessedPhoto? {
        guard let image = UIImage(data: data) else { return nil }
        let id = UUID().uuidString
        let (exifDate, lat, lon) = PhotoService.extractEXIF(from: data)
        let compressed = PhotoService.compressImage(image, quality: 0.7) ?? data
        let thumbnail = PhotoService.generateThumbnail(from: data, maxDimension: 200) ?? data
        return ProcessedPhoto(
            id: id,
            image: compressed,
            thumbnail: thumbnail,
            exifTime: exifDate,
            gpsLat: lat,
            gpsLon: lon,
            fileHash: computeFileHash(data),
            fileName: fileName ?? "photo_\(id).jpg"
        )
    }

    private func appendByDuplicateStatus(
        _ photo: ProcessedPhoto,
        newPhotos: inout [ProcessedPhoto],
        duplicatePhotos: inout [ProcessedPhoto]
    ) {
        let isDuplicate = dataStore?.photos.contains { $0.fileHash == photo.fileHash } ?? false
        if isDuplicate {
            duplicatePhotos.append(photo)
        } else {
            newPhotos.append(photo)
        }
    }

    /// Called after duplicate resolution - finalize extraction with the chosen photos.
    func handleDuplicateChoice(reimport: Bool) {
        showDuplicateConfirm = false
        let finalPhotos = reimport
            ? pendingNewPhotos + pendingDuplicatePhotos
            : pendingNewPhotos
        pendingNewPhotos = []
        pendingDuplicatePhotos = []

        if finalPhotos.isEmpty {
            selectedItems = []
            currentStep = .selectPhotos
            flowDismissalRequestID = UUID()
            return
        }

        currentStep = .extracting
        finishExtraction(photos: finalPhotos)
    }

    private func finishExtraction(photos: [ProcessedPhoto]) {
        processedPhotos = photos
        processingMessage = "Clustering into outings..."
        clusters = PhotoService.clusterPhotos(photos)

        // Photos without EXIF time go into a single "Unknown Date" cluster
        let noDate = photos.filter { $0.exifTime == nil }
        if !noDate.isEmpty && !clusters.contains(where: { $0.photos.contains(where: { $0.exifTime == nil }) }) {
            clusters.append(PhotoCluster(
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
    /// Creates photo metadata on the server immediately (matching web flow),
    /// then starts the per-photo AI identification loop.
    func outingConfirmed(outingId: String, locationName: String) {
        guard let sessionID = try? requireCurrentSession() else { return }
        let normalizedName = locationName.trimmingCharacters(in: .whitespacesAndNewlines)
        lastLocationName = normalizedName
        currentOutingId = outingId
        photoResults = []
        currentCandidates = []
        rangeAdjusted = false
        cropPromptContext = .manualRecrop
        currentPhotoIndex = 0

        // Save photo metadata to server BEFORE AI identification starts.
        // The observation table has a FK to photo(id), so photos must exist first.
        Task {
            do {
                try await createPhotoMetadata(outingId: outingId, sessionID: sessionID)
                await runSpeciesId(photoIndex: 0)
            } catch is CancellationError {
                return
            } catch {
                log.error("Failed to save photo metadata")
                self.error = AppError.map(error, fallback: "Could not save photo details. Try again.")
                errorRecovery = .photoMetadata
                processingMessage = "Photo details could not be saved"
                currentStep = .photoProcessing
            }
        }
    }

    /// Persist photo metadata for the current cluster to the server.
    /// Must be called before creating observations (FK constraint on representativePhotoId).
    private func createPhotoMetadata(outingId: String, sessionID: UUID) async throws {
        guard let service = dataService else {
            throw AppError.message("Photo service isn't available.")
        }
        let photos = clusterPhotos
        let formatter = ISO8601DateFormatter()
        let payloads = photos.map { photo in
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
        try await service.createPhotos(payloads)
        guard isCurrentSession(sessionID) else { throw CancellationError() }
        log.info("Saved \(payloads.count) photo metadata records for outing \(outingId)")
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
        let imageToSend = croppedImageData ?? photo.croppedImage ?? photo.image
        processingMessage = "Photo \(photoIndex + 1)/\(photos.count): Identifying species..."

        do {
            let location: (lat: Double, lon: Double)? = {
                guard useGeoContext, let lat = photo.gpsLat, let lon = photo.gpsLon else {
                    return nil
                }
                return (lat: lat, lon: lon)
            }()
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

            let candidates = results.map {
                IdentifiedCandidate(
                    species: $0.commonName,
                    confidence: $0.confidence,
                    wikiTitle: nil,
                    plumage: nil,
                    // rangeStatus is BirdLife vocabulary. The Bayesian prior has
                    // no notion of present or out-of-range, only a probability,
                    // so it is omitted rather than faked from a threshold.
                    rangeStatus: nil
                )
            }

            log.info("Found \(candidates.count) candidates for photo \(photoIndex + 1)")
            rangeAdjusted = results.contains { $0.logP != nil }
            currentCandidates = candidates

            // The classifier always returns candidates, so an empty list can
            // never mean "no bird". Low confidence is the only signal, and
            // cropping an already-cropped photo would loop forever because
            // confidence tracks SPECIES AMBIGUITY, not framing.
            if !isCropped, shouldPromptForCrop(candidates) {
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
            errorRecovery = .speciesIdentification(photoIndex: photoIndex, croppedImageData: croppedImageData)
            currentCandidates = []
            rangeAdjusted = false
            currentStep = .perPhotoConfirm
        }
    }

    // MARK: - Step 4: Per-Photo Confirmation

    /// User confirms species for the current photo with a certainty level.
    func confirmCurrentPhoto(species: String, confidence: Double, status: ObservationStatus, count: Int) {
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
    func removePhotoFromCurrentCluster(id: String) {
        guard currentClusterIndex < clusters.count else { return }
        clusters[currentClusterIndex].photos.removeAll { $0.id == id }
        processedPhotos.removeAll { $0.id == id }

        if clusters[currentClusterIndex].photos.isEmpty {
            clusters.remove(at: currentClusterIndex)
            if clusters.isEmpty {
                currentClusterIndex = 0
                selectedItems = []
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
        let nextIdx = currentPhotoIndex + 1
        if nextIdx < clusterPhotos.count {
            currentCandidates = []
            rangeAdjusted = false
            cropPromptContext = .manualRecrop
            Task { await runSpeciesId(photoIndex: nextIdx) }
        } else {
            Task { await saveCurrentCluster() }
        }
    }

    /// Save all confirmed observations for the current cluster,
    /// then advance to the next cluster or finish.
    private func saveCurrentCluster() async {
        guard let sessionID = try? requireCurrentSession() else { return }
        guard let service = dataService, let store = dataStore else { return }
        currentStep = .saving
        isProcessing = true
        processingMessage = "Saving..."
        error = nil
        errorRecovery = nil

        let confirmed = photoResults.filter { $0.status == .confirmed || $0.status == .possible }
        let existingSpecies = Set(store.dex.map(\.speciesName))

        // Group by species, sum counts
        var speciesMap: [String: (count: Int, status: ObservationStatus, photoId: String)] = [:]
        for r in confirmed {
            if let existing = speciesMap[r.species] {
                speciesMap[r.species] = (existing.count + r.count, existing.status, existing.photoId)
            } else {
                speciesMap[r.species] = (r.count, r.status, r.photoId)
            }
        }

        let observations = preparedObservations ?? speciesMap.map { species, info in
                BirdObservation(
                    id: "obs_\(UUID().uuidString)",
                    outingId: currentOutingId,
                    speciesName: species,
                    count: info.count,
                    certainty: info.status,
                    representativePhotoId: info.photoId,
                    notes: ""
                )
            }
        preparedObservations = observations

        do {
            if !observations.isEmpty {
                let response = try await service.createObservations(observations)
                guard isCurrentSession(sessionID) else { return }
                if let dexUpdates = response.dexUpdates {
                    store.dex = dexUpdates
                }
            }

            // Photo metadata was already created in outingConfirmed() before AI started

            // Count new species
            var clusterNewSpecies = 0
            for obs in observations where !existingSpecies.contains(obs.speciesName) {
                clusterNewSpecies += 1
                newSpeciesNames.append(getDisplayName(obs.speciesName))
            }
            newSpeciesCount += clusterNewSpecies
            savedOutingCount += 1
            savedObservationCount += observations.count

            // Accumulate upload summary
            let outingName = store.outings.first(where: { $0.id == currentOutingId })?.locationName ?? ""
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

            // Brief "saved" notice before advancing
            processingMessage = "Outing saved!"
            try? await Task.sleep(for: .milliseconds(1200))
            guard isCurrentSession(sessionID) else { return }

            // Move to next cluster or finish
            if currentClusterIndex < clusters.count - 1 {
                preparedObservations = nil
                currentClusterIndex += 1
                currentPhotoIndex = 0
                photoResults = []
                currentCandidates = []
                rangeAdjusted = false
                cropPromptContext = .manualRecrop
                currentStep = .outingReview
            } else {
                await store.loadAll()
                preparedObservations = nil
                currentStep = .done
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
        case .photoMetadata:
            Task {
                do {
                    let sessionID = try requireCurrentSession()
                    try await createPhotoMetadata(outingId: currentOutingId, sessionID: sessionID)
                    await runSpeciesId(photoIndex: currentPhotoIndex)
                } catch is CancellationError {
                    return
                } catch {
                    self.error = AppError.map(error, fallback: "Could not save photo details. Try again.")
                    errorRecovery = .photoMetadata
                }
            }
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
              dataStore?.hasLoadedAll == true
        else {
            throw AuthError.notAuthenticated
        }
        return sessionGeneration
    }

    private func isCurrentSession(_ sessionID: UUID) -> Bool {
        guard sessionGeneration == sessionID, let accountID else { return false }
        return dataStore?.activeAccountID == accountID && dataStore?.hasLoadedAll == true
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
        let thumbnail = PhotoService.generateThumbnail(from: imageData, maxDimension: 200) ?? imageData

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

    /// SHA-256 of first 64KB + size (matches web's computeFileHash approach).
    private func computeFileHash(_ data: Data) -> String {
        let prefix = data.prefix(65536)
        var hasher = SHA256()
        hasher.update(data: prefix)
        withUnsafeBytes(of: data.count) { hasher.update(bufferPointer: $0) }
        let digest = hasher.finalize()
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}

private enum ErrorRecovery {
    case photoMetadata
    case speciesIdentification(photoIndex: Int, croppedImageData: Data?)
    case saveCluster
}

// MARK: - Supporting Types

/// A photo after EXIF extraction and compression.
struct ProcessedPhoto: Identifiable {
    let id: String
    let image: Data        // Compressed JPEG for API submission
    var thumbnail: Data    // Small thumbnail for display
    let exifTime: Date?
    let gpsLat: Double?
    let gpsLon: Double?
    let fileHash: String
    let fileName: String
    /// AI-suggested crop box (percentage coordinates), stored after identification.
    var aiCropBox: CropBoxResult?
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
    let rangeStatus: String?
}

/// AI crop box in percentage coordinates (0-100).
struct CropBoxResult: Sendable {
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
