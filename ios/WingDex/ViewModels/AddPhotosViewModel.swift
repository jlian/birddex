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

    /// Location name from the most recent outing - used as default for new outings.
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
    private var didCreatePhotos = false
    private var errorRecovery: ErrorRecovery?
    private var preparedObservations: [BirdObservation]?

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
    /// Display names of species newly added to the dex during this upload session.
    var newSpeciesNames: [String] = []

    // MARK: - Dependencies

    private var dataService: DataService?
    private var dataStore: DataStore?
    private var authService: AuthService?
    private var accountID: String?
    private var sessionGeneration = UUID()

    func configure(auth: AuthService, dataStore: DataStore) {
        let accountID = dataStore.activeAccountID
        if self.accountID != accountID {
            sessionGeneration = UUID()
        }
        self.accountID = accountID
        authService = auth
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
        authService = nil
        dataService = nil
        dataStore = nil
    }

    func stopShareQueueAfterDismissal() {
        continuesShareQueueAfterDismissal = false
        stoppedShareQueueAfterDismissal = true
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
        guard currentStep == .selectPhotos,
              !isProcessing,
              !showDuplicateConfirm,
              pendingNewPhotos.isEmpty,
              pendingDuplicatePhotos.isEmpty,
              incomingShareID == nil
        else { return .busy }
        do {
            guard let snapshot = try await IncomingShareStore.oldestPendingShare() else {
                return .empty
            }
            incomingShareID = snapshot.id
            incomingSharedPhotos = snapshot.photos
            await processSelectedPhotos()
            if incomingShareID == nil {
                continuesShareQueueAfterDismissal = true
                return .accepted
            }
            return .failed
        } catch is CancellationError {
            return .cancelled
        } catch {
            self.error = AppError.map(error, fallback: "Could not import the shared photos. Try again.")
            errorRecovery = .incomingShareImport
            return .failed
        }
    }

    // MARK: - Step 1: Process Selected Photos

    /// Load photos from the picker and camera, extract EXIF, generate thumbnails, cluster.
    func processSelectedPhotos() async {
        guard !selectedItems.isEmpty || !cameraPhotos.isEmpty || !incomingSharedPhotos.isEmpty else { return }
        guard !isProcessing else { return }
        isProcessing = true
        error = nil
        currentStep = .extracting
        totalCount = selectedItems.count + cameraPhotos.count + incomingSharedPhotos.count
        processedCount = 0
        extractionProgress = 0
        processingMessage = "Reading photo data..."
        async let preparedSession = prepareCurrentSession()

        // Reset accumulated stats for this upload session
        uploadSummary = nil
        newSpeciesNames = []

        var candidatePhotos: [ProcessedPhoto] = []
        var newPhotos: [ProcessedPhoto] = []
        var duplicatePhotos: [ProcessedPhoto] = []
        var rejectedSharedFileNames: [String] = []

        for item in selectedItems {
            do {
                guard let data = try await item.loadTransferable(type: Data.self) else { continue }
                if let photo = makeProcessedPhoto(data: data, fileName: nil) {
                    candidatePhotos.append(photo)
                }
            } catch {
                log.error("Failed to load a selected photo")
            }
            processedCount += 1
            extractionProgress = Double(processedCount) / Double(totalCount) * 100
        }

        for sharedPhoto in incomingSharedPhotos {
            do {
                let data = try await readSharedPhotoData(from: sharedPhoto.fileURL)
                if let photo = makeProcessedPhoto(data: data, fileName: sharedPhoto.fileName) {
                    candidatePhotos.append(photo)
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

        processingMessage = "Preparing your WingDex..."
        let sessionID: UUID
        do {
            sessionID = try await preparedSession
        } catch {
            self.error = AppError.map(error, fallback: "Could not start a WingDex session. Try again.")
            errorRecovery = .sessionPreparation
            isProcessing = false
            return
        }
        guard isCurrentSession(sessionID) else {
            cancelExtractionForSessionChange()
            return
        }
        for photo in candidatePhotos {
            appendByDuplicateStatus(photo, newPhotos: &newPhotos, duplicatePhotos: &duplicatePhotos)
        }
        if incomingShareID != nil, newPhotos.isEmpty, duplicatePhotos.isEmpty {
            error = .message("No shared photos could be read. Share them again in a supported image format.")
            errorRecovery = .sessionPreparation
            isProcessing = false
            return
        }
        if let incomingShareID {
            do {
                guard try await IncomingShareStore.accept(id: incomingShareID) else {
                    throw IncomingShareError.noLongerPending
                }
            } catch {
                self.error = AppError.map(
                    error,
                    fallback: "Could not finish importing the shared photos. Try again."
                )
                errorRecovery = .sessionPreparation
                isProcessing = false
                return
            }
        }
        guard isCurrentSession(sessionID) else {
            cancelExtractionForSessionChange()
            return
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
        let rejectedSharedPhotoCount = pendingRejectedSharedPhotoCount
        pendingRejectedSharedPhotoCount = 0

        if finalPhotos.isEmpty {
            selectedItems = []
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
        didCreatePhotos = false
        photoResults = []
        currentCandidates = []
        rangeAdjusted = false
        cropPromptContext = .manualRecrop
        currentPhotoIndex = 0

        Task { await runSpeciesId(photoIndex: 0) }
    }

    /// Create the outing and its photo rows, the first time the cluster has something to save.
    /// Order matters: observation has an FK to photo, and photo has one to outing.
    private func ensureOutingAndPhotosExist(sessionID: UUID) async throws {
        guard let service = dataService else { throw AuthError.notAuthenticated }
        if let outing = pendingOuting {
            _ = try await service.createOuting(outing)
            guard isCurrentSession(sessionID) else { throw CancellationError() }
            pendingOuting = nil
        }
        guard !didCreatePhotos else { return }
        try await createPhotoMetadata(outingId: currentOutingId, sessionID: sessionID)
        didCreatePhotos = true
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

            log.info("Found \(candidates.count) candidates for photo \(photoIndex + 1)\(abstained ? " (abstained on the bird probe)" : "")")
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
            errorRecovery = .speciesIdentification(photoIndex: photoIndex, croppedImageData: croppedImageData)
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
        guard let service = dataService, let store = dataStore else { return }
        currentStep = .saving
        isProcessing = true
        processingMessage = "Saving..."
        error = nil
        errorRecovery = nil

        let confirmed = sightingResults(photoResults)
        let existingSpecies = Set(store.dex.map(\.speciesName))

        // Group by species, sum counts
        var speciesMap: [String: (count: Int, status: ObservationStatus, photoId: String, confidences: [Double])] = [:]
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

        let observations = preparedObservations ?? speciesMap.map { species, info in
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
                try await ensureOutingAndPhotosExist(sessionID: sessionID)
                let response = try await service.createObservations(observations)
                guard isCurrentSession(sessionID) else { return }
                if let dexUpdates = response.dexUpdates {
                    store.dex = dexUpdates
                }

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
            }

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
              dataStore?.hasLoadedAll == true
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
        try await dataStore.ensureLoaded()
        configure(auth: authService, dataStore: dataStore)
        return try requireCurrentSession()
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
