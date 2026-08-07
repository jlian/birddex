import SwiftUI

/// Manual crop view for the Add Photos flow.
///
/// Drag to move the crop box, pinch to resize. Corner handles provide
/// visual affordance for resizing. The area outside the crop is dimmed.
/// Background matches page color for consistent chrome appearance.
struct CropView: View {
    let imageData: Data
    let initialCropBox: CropBoxResult?
    var reason: String = "For best results, crop to one bird"
    let onBack: () -> Void
    let onSkip: () -> Void
    let onApply: (CropBoxResult) -> Void

    @State private var paddedInitialCrop: CropBoxResult
    @State private var photoScale: CGFloat = 1.0
    @State private var committedScale: CGFloat = 1.0
    @State private var photoOffset: CGSize = .zero
    @State private var committedOffset: CGSize = .zero
    @State private var initialScale: CGFloat = 1.0
    @State private var initialOffset: CGSize = .zero
    @State private var didInitializeTransform = false
    @State private var squareSide: CGFloat = 0
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
    }

    @Environment(\.colorScheme) private var colorScheme

    private let cropInset: CGFloat = 8

    var body: some View {
        GeometryReader { geo in
            if let uiImage = cachedImage {
                let squareSide = geo.size.width - cropInset * 2
                let fillInfo = fillImageInfo(for: uiImage, squareSide: squareSide)
                // Total height including safe area (since we ignoresSafeArea)
                let totalHeight = geo.size.height + geo.safeAreaInsets.top + geo.safeAreaInsets.bottom
                let cropCenterY = totalHeight / 2

                ZStack {
                    // Full-view photo layer behind everything
                    Image(uiImage: uiImage)
                        .resizable()
                        .frame(width: fillInfo.renderedW, height: fillInfo.renderedH)
                        .scaleEffect(photoScale)
                        .offset(photoOffset)
                        .position(x: geo.size.width / 2, y: cropCenterY)

                    // Glass overlay with a rectangular cutout for the crop area
                    Rectangle()
                        .fill(.ultraThinMaterial)
                        .reverseMask {
                            Rectangle()
                                .frame(width: squareSide, height: squareSide)
                                .position(x: geo.size.width / 2, y: cropCenterY)
                        }

                    // Crop border
                    Rectangle()
                        .stroke(colorScheme == .dark ? Color.white : Color.black, lineWidth: 1)
                        .frame(width: squareSide, height: squareSide)
                        .position(x: geo.size.width / 2, y: cropCenterY)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .gesture(photoManipulationGesture(fillInfo: fillInfo))
                .overlay(alignment: .top) {
                    Text(reason)
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 24)
                        .padding(.top, 60)
                }
                .onAppear {
                    self.squareSide = squareSide
                    configureInitialTransformIfNeeded(fillInfo: fillInfo)
                }
                .onChange(of: geo.size.width) {
                    self.squareSide = geo.size.width - cropInset * 2
                    didInitializeTransform = false
                    configureInitialTransformIfNeeded(fillInfo: fillInfo)
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
                    if let cropResult = currentCropResult() {
                        onApply(cropResult)
                    }
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

                Menu {
                    Button {
                        photoScale = initialScale
                        committedScale = initialScale
                        photoOffset = initialOffset
                        committedOffset = initialOffset
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

    private struct FillImageInfo {
        let squareSide: CGFloat
        let naturalW: CGFloat
        let naturalH: CGFloat
        let baseScale: CGFloat
        let renderedW: CGFloat
        let renderedH: CGFloat
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

    private func fillImageInfo(for image: UIImage, squareSide: CGFloat) -> FillImageInfo {
        let naturalW = image.size.width
        let naturalH = image.size.height
        let baseScale = max(squareSide / naturalW, squareSide / naturalH)
        return FillImageInfo(
            squareSide: squareSide,
            naturalW: naturalW,
            naturalH: naturalH,
            baseScale: baseScale,
            renderedW: naturalW * baseScale,
            renderedH: naturalH * baseScale
        )
    }

    private func configureInitialTransformIfNeeded(fillInfo: FillImageInfo) {
        guard !didInitializeTransform else { return }

        let cropWidthPx = fillInfo.naturalW * CGFloat(paddedInitialCrop.width / 100)
        let cropCenterX = fillInfo.naturalW * CGFloat((paddedInitialCrop.x + paddedInitialCrop.width / 2) / 100)
        let cropCenterY = fillInfo.naturalH * CGFloat((paddedInitialCrop.y + paddedInitialCrop.height / 2) / 100)

        let desiredScale = max(1, min(6, fillInfo.squareSide / max(cropWidthPx, 1) / fillInfo.baseScale))
        let proposedOffset = CGSize(
            width: -(cropCenterX - fillInfo.naturalW / 2) * fillInfo.baseScale * desiredScale,
            height: -(cropCenterY - fillInfo.naturalH / 2) * fillInfo.baseScale * desiredScale
        )
        let clamped = clampedOffset(proposedOffset, fillInfo: fillInfo, scale: desiredScale)

        initialScale = desiredScale
        initialOffset = clamped
        photoScale = desiredScale
        committedScale = desiredScale
        photoOffset = clamped
        committedOffset = clamped
        didInitializeTransform = true
    }

    private func clampedOffset(_ proposed: CGSize, fillInfo: FillImageInfo, scale: CGFloat) -> CGSize {
        let scaledW = fillInfo.renderedW * scale
        let scaledH = fillInfo.renderedH * scale
        let maxX = max(0, (scaledW - fillInfo.squareSide) / 2)
        let maxY = max(0, (scaledH - fillInfo.squareSide) / 2)
        return CGSize(
            width: min(max(proposed.width, -maxX), maxX),
            height: min(max(proposed.height, -maxY), maxY)
        )
    }

    private func photoManipulationGesture(fillInfo: FillImageInfo) -> some Gesture {
        SimultaneousGesture(
            DragGesture()
                .onChanged { value in
                    let proposed = CGSize(
                        width: committedOffset.width + value.translation.width,
                        height: committedOffset.height + value.translation.height
                    )
                    photoOffset = clampedOffset(proposed, fillInfo: fillInfo, scale: photoScale)
                }
                .onEnded { _ in
                    committedOffset = photoOffset
                },
            MagnificationGesture()
                .onChanged { value in
                    let newScale = max(1, min(6, committedScale * value))
                    photoScale = newScale
                    photoOffset = clampedOffset(photoOffset, fillInfo: fillInfo, scale: newScale)
                }
                .onEnded { _ in
                    committedScale = photoScale
                    committedOffset = clampedOffset(committedOffset, fillInfo: fillInfo, scale: photoScale)
                    photoOffset = committedOffset
                }
        )
    }

    private func currentCropResult() -> CropBoxResult? {
        guard squareSide > 0 else { return nil }
        guard let uiImage = cachedImage else { return nil }
        let side = squareSide
        let fillInfo = fillImageInfo(for: uiImage, squareSide: side)
        let totalScale = fillInfo.baseScale * photoScale
        let visibleSidePx = side / totalScale
        let centerX = fillInfo.naturalW / 2 - photoOffset.width / totalScale
        let centerY = fillInfo.naturalH / 2 - photoOffset.height / totalScale
        let xPx = max(0, min(fillInfo.naturalW - visibleSidePx, centerX - visibleSidePx / 2))
        let yPx = max(0, min(fillInfo.naturalH - visibleSidePx, centerY - visibleSidePx / 2))

        return CropBoxResult(
            x: Double(xPx / fillInfo.naturalW * 100),
            y: Double(yPx / fillInfo.naturalH * 100),
            width: Double(visibleSidePx / fillInfo.naturalW * 100),
            height: Double(visibleSidePx / fillInfo.naturalH * 100)
        )
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
