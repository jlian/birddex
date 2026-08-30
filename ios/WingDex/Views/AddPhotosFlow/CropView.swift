import SwiftUI
import UIKit

/// Manual crop view for the Add Photos flow.
///
/// Drag to position the photo and pinch to zoom beneath a fixed crop square.
struct CropView: View {
    let imageData: Data
    let initialCropBox: CropBoxResult?
    var reason: String = "For best results, crop to one bird"
    let onBack: () -> Void
    let onSkip: () -> Void
    let onApply: (CropBoxResult) -> Void

    @State private var paddedInitialCrop: CropBoxResult
    @State private var currentCrop: CropBoxResult
    @State private var zoomRatio: CGFloat = 1
    @State private var viewportController = CropViewportController()
    @State private var cachedImage: UIImage?

    init(
        imageData: Data,
        initialCropBox: CropBoxResult?,
        reason: String = "For best results, crop to one bird",
        onBack: @escaping () -> Void,
        onSkip: @escaping () -> Void,
        onApply: @escaping (CropBoxResult) -> Void
    ) {
        self.imageData = imageData
        self.initialCropBox = initialCropBox
        self.reason = reason
        self.onBack = onBack
        self.onSkip = onSkip
        self.onApply = onApply

        let defaultCrop = CropBoxResult(x: 25, y: 25, width: 50, height: 50)
        let padded: CropBoxResult
        if let aiCrop = initialCropBox, let uiImage = UIImage(data: imageData) {
            let natW = uiImage.size.width
            let natH = uiImage.size.height
            let pixelCrop = CropService.paddedSquareCrop(
                from: CropService.CropBox(x: aiCrop.x, y: aiCrop.y, width: aiCrop.width, height: aiCrop.height),
                naturalWidth: natW, naturalHeight: natH
            )
            padded = CropBoxResult(
                x: pixelCrop.x / natW * 100, y: pixelCrop.y / natH * 100,
                width: pixelCrop.width / natW * 100, height: pixelCrop.height / natH * 100
            )
        } else {
            padded = defaultCrop
        }
        self._paddedInitialCrop = State(initialValue: padded)
        self._currentCrop = State(initialValue: padded)
    }

    @Environment(\.colorScheme) private var colorScheme

    private let cropInset: CGFloat = 8

    var body: some View {
        GeometryReader { geo in
            if let uiImage = cachedImage {
                let squareSide = geo.size.width - cropInset * 2
                // Total height including safe area (since we ignoresSafeArea)
                let totalHeight = geo.size.height + geo.safeAreaInsets.top + geo.safeAreaInsets.bottom
                let cropCenterY = totalHeight / 2

                ZStack {
                    Color.pageBg

                    CropScrollView(
                        image: uiImage,
                        initialCrop: paddedInitialCrop,
                        cropResult: $currentCrop,
                        zoomRatio: $zoomRatio,
                        controller: viewportController
                    )
                        .frame(width: squareSide, height: squareSide)
                        .position(x: geo.size.width / 2, y: cropCenterY)

                    #if DEBUG
                    if ProcessInfo.processInfo.arguments.contains("--ui-test-stub-low-confidence-identification") {
                        Color.clear
                            .frame(width: squareSide / 3, height: squareSide / 3)
                            .contentShape(Rectangle())
                            .position(
                                x: geo.size.width / 2 - squareSide / 3,
                                y: cropCenterY - squareSide / 3
                            )
                            .allowsHitTesting(false)
                            .accessibilityElement()
                            .accessibilityLabel("Upper-left crop gesture target")
                            .accessibilityValue(String(
                                format: "%.3f,%.3f",
                                currentCrop.x + currentCrop.width / 2,
                                currentCrop.y + currentCrop.height / 2
                            ))
                            .accessibilityIdentifier("crop.offCenterPinchTarget")
                    }
                    #endif

                    // Glass overlay with a rectangular cutout for the crop area
                    Rectangle()
                        .fill(.ultraThinMaterial)
                        .reverseMask {
                            Rectangle()
                                .frame(width: squareSide, height: squareSide)
                                .position(x: geo.size.width / 2, y: cropCenterY)
                        }
                            .allowsHitTesting(false)

                    // Crop border
                    Rectangle()
                        .stroke(colorScheme == .dark ? Color.white : Color.black, lineWidth: 1)
                        .frame(width: squareSide, height: squareSide)
                        .position(x: geo.size.width / 2, y: cropCenterY)
                        .allowsHitTesting(false)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .ignoresSafeArea()
                .overlay(alignment: .top) {
                    Text(reason)
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 24)
                        .padding(.top, 60)
                }
            } else {
                Color.pageBg
                    .overlay {
                        Image(systemName: "photo")
                            .font(.largeTitle)
                            .foregroundStyle(.tertiary)
                    }
            }
        }
        .task {
            cachedImage = normalizedImage(from: imageData)
        }
        .background(Color.clear)
        .navigationTitle("Crop Bird Photo")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.hidden, for: .navigationBar, .bottomBar)
        .toolbarBackground(.visible, for: .navigationBar, .bottomBar)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    onApply(currentCrop)
                } label: {
                    Image(systemName: "checkmark")
                }
                .buttonStyle(.borderedProminent)
                .disabled(cachedImage == nil)
            }
            ToolbarItemGroup(placement: .bottomBar) {
                Button {
                    onBack()
                } label: {
                    Image(systemName: "chevron.left")
                }
                .accessibilityIdentifier("crop.back")

                Spacer()

                Button {
                    viewportController.zoom(by: 0.8)
                } label: {
                    Image(systemName: "minus.magnifyingglass")
                }
                .disabled(zoomRatio <= 1.001)
                .accessibilityLabel("Zoom out")
                .accessibilityIdentifier("crop.zoomOut")

                Button {
                    viewportController.zoom(by: 1.25)
                } label: {
                    Image(systemName: "plus.magnifyingglass")
                }
                .disabled(zoomRatio >= 5.999)
                .accessibilityLabel("Zoom in")
                .accessibilityIdentifier("crop.zoomIn")

                Spacer()

                Menu {
                    Button {
                        viewportController.reset()
                    } label: {
                        Label("Reset Crop", systemImage: "arrow.counterclockwise")
                    }
                    Button(role: .destructive) {
                        onSkip()
                    } label: {
                        Label("Skip Photo", systemImage: "forward")
                    }
                } label: {
                    Image(systemName: "ellipsis")
                }
            }
        }
    }

    private func normalizedImage(from data: Data) -> UIImage? {
        guard let image = UIImage(data: data) else { return nil }
        if image.imageOrientation == .up { return image }
        let format = UIGraphicsImageRendererFormat()
        format.scale = image.scale
        return UIGraphicsImageRenderer(size: image.size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: image.size))
        }
    }

}

@MainActor
private final class CropViewportController {
    var zoomHandler: ((CGFloat) -> Void)?
    var resetHandler: (() -> Void)?

    func zoom(by factor: CGFloat) {
        zoomHandler?(factor)
    }

    func reset() {
        resetHandler?()
    }
}

struct CropViewportGeometry {
    struct Viewport {
        let zoomScale: CGFloat
        let contentOffset: CGPoint
    }

    static func minimumZoomScale(imageSize: CGSize, viewportSide: CGFloat) -> CGFloat {
        guard imageSize.width > 0, imageSize.height > 0, viewportSide > 0 else { return 1 }
        return max(viewportSide / imageSize.width, viewportSide / imageSize.height)
    }

    static func viewport(
        for crop: CropBoxResult,
        imageSize: CGSize,
        viewportSide: CGFloat,
        minimumZoomScale: CGFloat,
        maximumZoomScale: CGFloat
    ) -> Viewport {
        let cropWidth = max(1, imageSize.width * CGFloat(crop.width / 100))
        let proposedZoom = viewportSide / cropWidth
        let zoomScale = min(max(proposedZoom, minimumZoomScale), maximumZoomScale)
        let center = CGPoint(
            x: imageSize.width * CGFloat((crop.x + crop.width / 2) / 100),
            y: imageSize.height * CGFloat((crop.y + crop.height / 2) / 100)
        )
        let proposedOffset = CGPoint(
            x: center.x * zoomScale - viewportSide / 2,
            y: center.y * zoomScale - viewportSide / 2
        )
        return Viewport(
            zoomScale: zoomScale,
            contentOffset: clampedOffset(
                proposedOffset,
                imageSize: imageSize,
                viewportSide: viewportSide,
                zoomScale: zoomScale
            )
        )
    }

    static func cropResult(
        imageSize: CGSize,
        viewportSide: CGFloat,
        zoomScale: CGFloat,
        contentOffset: CGPoint
    ) -> CropBoxResult {
        let visibleSide = viewportSide / max(zoomScale, .leastNonzeroMagnitude)
        let maxX = max(0, imageSize.width - visibleSide)
        let maxY = max(0, imageSize.height - visibleSide)
        let x = min(max(contentOffset.x / zoomScale, 0), maxX)
        let y = min(max(contentOffset.y / zoomScale, 0), maxY)
        return CropBoxResult(
            x: Double(x / imageSize.width * 100),
            y: Double(y / imageSize.height * 100),
            width: Double(min(visibleSide, imageSize.width) / imageSize.width * 100),
            height: Double(min(visibleSide, imageSize.height) / imageSize.height * 100)
        )
    }

    static func clampedOffset(
        _ proposed: CGPoint,
        imageSize: CGSize,
        viewportSide: CGFloat,
        zoomScale: CGFloat
    ) -> CGPoint {
        CGPoint(
            x: min(max(proposed.x, 0), max(0, imageSize.width * zoomScale - viewportSide)),
            y: min(max(proposed.y, 0), max(0, imageSize.height * zoomScale - viewportSide))
        )
    }
}

private final class CropUIScrollView: UIScrollView {
    var onLayout: (() -> Void)?

    override func layoutSubviews() {
        super.layoutSubviews()
        onLayout?()
    }
}

private struct CropScrollView: UIViewRepresentable {
    let image: UIImage
    let initialCrop: CropBoxResult
    @Binding var cropResult: CropBoxResult
    @Binding var zoomRatio: CGFloat
    let controller: CropViewportController

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> CropUIScrollView {
        let scrollView = CropUIScrollView()
        scrollView.delegate = context.coordinator
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.showsVerticalScrollIndicator = false
        scrollView.bounces = true
        scrollView.bouncesZoom = true
        scrollView.decelerationRate = .fast
        scrollView.clipsToBounds = true
        scrollView.accessibilityLabel = "Photo crop"
        scrollView.accessibilityIdentifier = "crop.viewport"

        context.coordinator.imageView.image = image
        scrollView.addSubview(context.coordinator.imageView)
        scrollView.onLayout = { [weak coordinator = context.coordinator, weak scrollView] in
            guard let coordinator, let scrollView else { return }
            coordinator.layout(scrollView)
        }
        controller.zoomHandler = { [weak coordinator = context.coordinator, weak scrollView] factor in
            guard let coordinator, let scrollView else { return }
            coordinator.zoom(by: factor, in: scrollView)
        }
        controller.resetHandler = { [weak coordinator = context.coordinator, weak scrollView] in
            guard let coordinator, let scrollView else { return }
            coordinator.reset(scrollView)
        }
        return scrollView
    }

    func updateUIView(_ scrollView: CropUIScrollView, context: Context) {
        context.coordinator.parent = self
        if context.coordinator.imageView.image !== image {
            context.coordinator.imageView.image = image
            context.coordinator.isConfigured = false
        }
        context.coordinator.layout(scrollView)
    }

    static func dismantleUIView(_ scrollView: CropUIScrollView, coordinator: Coordinator) {
        scrollView.onLayout = nil
        scrollView.delegate = nil
        coordinator.parent.controller.zoomHandler = nil
        coordinator.parent.controller.resetHandler = nil
    }

    final class Coordinator: NSObject, UIScrollViewDelegate {
        var parent: CropScrollView
        let imageView = UIImageView()
        var isConfigured = false
        private var isApplyingViewport = false
        private var lastViewportSize = CGSize.zero

        init(parent: CropScrollView) {
            self.parent = parent
            imageView.contentMode = .scaleToFill
            imageView.isAccessibilityElement = false
        }

        func viewForZooming(in scrollView: UIScrollView) -> UIView? {
            imageView
        }

        func scrollViewDidScroll(_ scrollView: UIScrollView) {
            publishViewport(scrollView)
        }

        func scrollViewDidZoom(_ scrollView: UIScrollView) {
            publishViewport(scrollView)
        }

        func layout(_ scrollView: CropUIScrollView) {
            guard !isApplyingViewport else { return }
            let side = min(scrollView.bounds.width, scrollView.bounds.height)
            let imageSize = parent.image.size
            guard side > 0, imageSize.width > 0, imageSize.height > 0 else { return }

            if !isConfigured || scrollView.bounds.size != lastViewportSize {
                let cropToRestore = isConfigured ? parent.cropResult : parent.initialCrop

                isApplyingViewport = true
                scrollView.minimumZoomScale = 1
                scrollView.maximumZoomScale = 1
                scrollView.setZoomScale(1, animated: false)
                imageView.frame = CGRect(origin: .zero, size: imageSize)
                scrollView.contentSize = imageSize
                let minimum = CropViewportGeometry.minimumZoomScale(
                    imageSize: imageSize,
                    viewportSide: side
                )
                scrollView.minimumZoomScale = minimum
                scrollView.maximumZoomScale = minimum * 6
                apply(cropToRestore, to: scrollView)
                lastViewportSize = scrollView.bounds.size
                isConfigured = true
                isApplyingViewport = false
                publishViewport(scrollView)
            }
        }

        private func apply(_ crop: CropBoxResult, to scrollView: UIScrollView) {
            let side = min(scrollView.bounds.width, scrollView.bounds.height)
            let viewport = CropViewportGeometry.viewport(
                for: crop,
                imageSize: parent.image.size,
                viewportSide: side,
                minimumZoomScale: scrollView.minimumZoomScale,
                maximumZoomScale: scrollView.maximumZoomScale
            )
            scrollView.setZoomScale(viewport.zoomScale, animated: false)
            scrollView.setContentOffset(viewport.contentOffset, animated: false)
        }

        func reset(_ scrollView: UIScrollView) {
            guard isConfigured else { return }
            isApplyingViewport = true
            apply(parent.initialCrop, to: scrollView)
            isApplyingViewport = false
            publishViewport(scrollView)
        }

        func zoom(by factor: CGFloat, in scrollView: UIScrollView) {
            guard isConfigured else { return }
            let side = min(scrollView.bounds.width, scrollView.bounds.height)
            let targetScale = min(
                max(scrollView.zoomScale * factor, scrollView.minimumZoomScale),
                scrollView.maximumZoomScale
            )
            let center = CGPoint(
                x: (scrollView.contentOffset.x + side / 2) / scrollView.zoomScale,
                y: (scrollView.contentOffset.y + side / 2) / scrollView.zoomScale
            )
            let targetOffset = CropViewportGeometry.clampedOffset(
                CGPoint(
                    x: center.x * targetScale - side / 2,
                    y: center.y * targetScale - side / 2
                ),
                imageSize: parent.image.size,
                viewportSide: side,
                zoomScale: targetScale
            )
            isApplyingViewport = true
            scrollView.setZoomScale(targetScale, animated: false)
            scrollView.setContentOffset(targetOffset, animated: false)
            isApplyingViewport = false
            publishViewport(scrollView)
        }

        private func publishViewport(_ scrollView: UIScrollView) {
            guard isConfigured, !isApplyingViewport else { return }
            let side = min(scrollView.bounds.width, scrollView.bounds.height)
            guard side > 0 else { return }
            parent.cropResult = CropViewportGeometry.cropResult(
                imageSize: parent.image.size,
                viewportSide: side,
                zoomScale: scrollView.zoomScale,
                contentOffset: scrollView.contentOffset
            )
            parent.zoomRatio = scrollView.zoomScale / scrollView.minimumZoomScale
            scrollView.accessibilityValue = String(format: "%.3f", parent.zoomRatio)
        }
    }
}

// MARK: - Reverse Mask

extension View {
    /// Apply a reverse mask: the masked content is cut out (transparent),
    /// and everything else remains visible.
    @ViewBuilder
    func reverseMask<Mask: View>(@ViewBuilder _ mask: () -> Mask) -> some View {
        self.mask {
            Rectangle()
                .overlay {
                    mask()
                        .blendMode(.destinationOut)
                }
        }
    }
}

#if DEBUG
#Preview("Default") {
    NavigationStack {
        CropView(
            imageData: PreviewData.placeholderImageData(systemName: "bird.fill", size: 400),
            initialCropBox: nil,
            onBack: {},
            onSkip: {}
        ) { _ in }
    }
}

#Preview("Multi-Bird") {
    NavigationStack {
        CropView(
            imageData: PreviewData.placeholderImageData(systemName: "bird.fill", size: 400),
            initialCropBox: CropBoxResult(x: 20, y: 30, width: 40, height: 40),
            reason: "Multiple birds detected, crop to one",
            onBack: {},
            onSkip: {}
        ) { _ in }
    }
}
#endif
