import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
    private let titleLabel = UILabel()
    private let statusLabel = UILabel()
    private let progressView = UIProgressView(progressViewStyle: .default)
    private let doneButton = UIButton(type: .system)
    private let cancelButton = UIButton(type: .system)
    private var stagingTask: Task<Void, Never>?
    /// Set once the batch reaches `pending`, which is the point of no return:
    /// the app will import it. Cancelling after that cannot unpublish it, so
    /// Cancel must stop reporting cancellation and close instead.
    private var hasPublishedBatch = false

    override func viewDidLoad() {
        super.viewDidLoad()
        configureUI()
        stagingTask = Task { await stageSharedPhotos() }
    }

    private func configureUI() {
        view.backgroundColor = .systemBackground

        titleLabel.text = "Share to WingDex"
        titleLabel.font = .preferredFont(forTextStyle: .title2)
        titleLabel.adjustsFontForContentSizeCategory = true
        titleLabel.textAlignment = .center

        statusLabel.text = "Preparing photos..."
        statusLabel.font = .preferredFont(forTextStyle: .body)
        statusLabel.adjustsFontForContentSizeCategory = true
        statusLabel.textColor = .secondaryLabel
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 0

        doneButton.configuration = .filled()
        doneButton.configuration?.title = "Done"
        doneButton.isHidden = true
        doneButton.addTarget(self, action: #selector(finish), for: .touchUpInside)

        cancelButton.configuration = .plain()
        cancelButton.configuration?.title = "Cancel"
        cancelButton.addTarget(self, action: #selector(cancel), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [
            titleLabel,
            statusLabel,
            progressView,
            doneButton,
            cancelButton,
        ])
        stack.axis = .vertical
        stack.spacing = 20
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            doneButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 50),
        ])
    }

    @MainActor
    private func stageSharedPhotos() async {
        do {
            let providers = inputProviders().filter {
                $0.hasItemConformingToTypeIdentifier(UTType.image.identifier)
            }
            guard !providers.isEmpty else { throw IncomingShareError.noPhotos }
            guard providers.count <= IncomingShareStore.maximumPhotoCount else {
                throw IncomingShareError.tooManyPhotos
            }

            var temporaryFiles: [URL] = []
            defer {
                for url in temporaryFiles {
                    try? FileManager.default.removeItem(at: url)
                }
            }

            var totalBytes = 0
            for (index, provider) in providers.enumerated() {
                try Task.checkCancellation()
                let copy = try await copyTemporaryFile(
                    from: provider,
                    remainingBytes: IncomingShareStore.maximumTotalBytes - totalBytes
                )
                temporaryFiles.append(copy.url)
                totalBytes += copy.size
                progressView.progress = Float(index + 1) / Float(providers.count)
                statusLabel.text = "Preparing photo \(index + 1) of \(providers.count)..."
            }

            try Task.checkCancellation()
            // Publication is the commit point. `stage` moves the batch into
            // `pending` atomically, so once it returns the app will import the
            // batch. Checking for cancellation after that point would report a
            // cancelled share while the batch stays queued, so the next check
            // is deliberately absent.
            try await IncomingShareStore.stage(fileURLs: temporaryFiles)
            hasPublishedBatch = true
            cancelButton.configuration?.title = "Close"
            if await openHostApp() {
                extensionContext?.completeRequest(returningItems: nil)
                return
            }
            statusLabel.text = providers.count == 1
                ? "Saved to WingDex. Tap Done, then open WingDex to continue."
                : "Saved \(providers.count) photos to WingDex. Tap Done, then open WingDex to continue."
            progressView.isHidden = true
            doneButton.isHidden = false
            cancelButton.isHidden = true
        } catch is CancellationError {
            return
        } catch {
            progressView.isHidden = true
            statusLabel.textColor = .systemRed
            statusLabel.text = (error as? IncomingShareError)?.localizedDescription
                ?? IncomingShareError.stagingFailed.localizedDescription
            cancelButton.configuration?.title = "Close"
        }
    }

    /// Matches the app's `CFBundleURLSchemes` entry and the `share-import` host it handles.
    private static let hostAppShareImportURL = URL(string: "wingdex://share-import")

    /// This works on current iOS releases but is undocumented for Share extensions,
    /// so the extension must keep the manual-open fallback when it fails.
    private func openHostApp() async -> Bool {
        guard let url = Self.hostAppShareImportURL else { return false }
        var responder: UIResponder? = self
        while let current = responder {
            if let scene = current as? UIScene {
                return await withCheckedContinuation { continuation in
                    scene.open(url, options: nil) { continuation.resume(returning: $0) }
                }
            }
            responder = current.next
        }
        return false
    }

    private func inputProviders() -> [NSItemProvider] {
        (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
            .flatMap { $0.attachments ?? [] }
    }

    private func copyTemporaryFile(
        from provider: NSItemProvider,
        remainingBytes: Int
    ) async throws -> (url: URL, size: Int) {
        let loadState = FileRepresentationLoadState()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                loadState.install(continuation)
                guard loadState.isActive else { return }
                let progress = provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { url, error in
                    guard loadState.isActive else { return }
                    do {
                        if let error { throw error }
                        guard let url else { throw IncomingShareError.noPhotos }
                        guard let sourceBytes = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
                            sourceBytes > 0
                        else { throw IncomingShareError.stagingFailed }
                        guard sourceBytes <= IncomingShareStore.maximumPhotoBytes else {
                            throw IncomingShareError.photoTooLarge
                        }
                        guard sourceBytes <= remainingBytes else {
                            throw IncomingShareError.shareTooLarge
                        }
                        let fileExtension = url.pathExtension.isEmpty ? "jpg" : url.pathExtension
                        let destination = FileManager.default.temporaryDirectory
                            .appendingPathComponent("wingdex-share-\(UUID().uuidString).\(fileExtension)")
                        try FileManager.default.copyItem(at: url, to: destination)
                        do {
                            guard let copiedBytes = try destination.resourceValues(forKeys: [.fileSizeKey]).fileSize,
                                    copiedBytes > 0
                            else { throw IncomingShareError.stagingFailed }
                            guard copiedBytes <= IncomingShareStore.maximumPhotoBytes else {
                                throw IncomingShareError.photoTooLarge
                            }
                            guard copiedBytes <= remainingBytes else {
                                throw IncomingShareError.shareTooLarge
                            }
                            if !loadState.complete(.success((destination, copiedBytes))) {
                                try? FileManager.default.removeItem(at: destination)
                            }
                        } catch {
                            try? FileManager.default.removeItem(at: destination)
                            throw error
                        }
                    } catch {
                        loadState.complete(.failure(error))
                    }
                }
                loadState.setProgress(progress as Progress?)
            }
        } onCancel: {
            loadState.cancel()
        }
    }

    @objc private func finish() {
        extensionContext?.completeRequest(returningItems: nil)
    }

    @objc private func cancel() {
        cancelInFlightWork()
        // The batch is already published and cannot be recalled, so reporting
        // cancellation here would tell the person the share was cancelled while
        // the app imports it anyway. Complete instead.
        guard !hasPublishedBatch else {
            extensionContext?.completeRequest(returningItems: nil)
            return
        }
        extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
    }

    private func cancelInFlightWork() {
        stagingTask?.cancel()
        stagingTask = nil
    }
}

private final class FileRepresentationLoadState: @unchecked Sendable {
    typealias Output = (url: URL, size: Int)

    private let lock = NSLock()
    private var continuation: CheckedContinuation<Output, Error>?
    private var pendingResult: Result<Output, Error>?
    private var progress: Progress?
    private var isCompleted = false

    var isActive: Bool {
        lock.withLock { !isCompleted }
    }

    func install(_ continuation: CheckedContinuation<Output, Error>) {
        let pendingResult = lock.withLock { () -> Result<Output, Error>? in
            if let pendingResult = self.pendingResult {
                self.pendingResult = nil
                return pendingResult
            }
            self.continuation = continuation
            return nil
        }
        if let pendingResult {
            continuation.resume(with: pendingResult)
        }
    }

    func setProgress(_ progress: Progress?) {
        guard let progress else { return }
        let shouldCancel = lock.withLock {
            if isCompleted { return true }
            self.progress = progress
            return false
        }
        if shouldCancel { progress.cancel() }
    }

    @discardableResult
    func complete(_ result: Result<Output, Error>) -> Bool {
        let completion = lock.withLock { () -> (won: Bool, continuation: CheckedContinuation<Output, Error>?) in
            guard !isCompleted else { return (false, nil) }
            isCompleted = true
            let continuation = self.continuation
            self.continuation = nil
            if continuation == nil {
                pendingResult = result
            }
            return (true, continuation)
        }
        completion.continuation?.resume(with: result)
        return completion.won
    }

    func cancel() {
        let progress = lock.withLock { self.progress }
        progress?.cancel()
        complete(.failure(CancellationError()))
    }
}