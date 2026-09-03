import PhotosUI
import SwiftUI

// MARK: - Collage Tuning Parameters

/// Size of each photo tile in points
private let collageTileSize: CGFloat = 130
/// Gap between tiles
private let collageSpacing: CGFloat = 5
/// Rotation angle in degrees (negative = counter-clockwise)
private let collageAngle: Double = -15
/// Number of horizontal rows of photos
private let collageRows = 8
/// Corner radius of each tile
private let collageCornerRadius: CGFloat = 10
/// Photo opacity (0 = invisible, 1 = full brightness)
private let collageOpacity: Double = 1

// -- Blur overlay parameters (same system as SignInView) --

/// Where the top blur finishes fading out (fraction of screen, 0 = no top blur)
private let collageTopBlurFadeEnd: Double = 0.05
/// How far down the screen remains unblurred (0 = top only, 1 = full screen)
private let collageBlurFadeEnd: Double = 0.5
/// Blur fade-in length as a fraction of screen height
private let collageBlurFadeLength: Double = 0.25

// MARK: - Photo Selection View

/// Photo selection step in the Add Photos flow.
///
/// Offers both photo library picker and camera capture - the standard iOS
/// pattern for image input. Camera-captured photos feed into the same
/// extraction -> clustering -> identification pipeline as library photos.
struct PhotoSelectionView: View {
    @Environment(AppNavigationModel.self) private var navigation
    @Bindable var viewModel: AddPhotosViewModel
    @State private var showLibrary = false
    @State private var showCamera = false
    @State private var showCameraUnavailable = false
    @State private var collageDrag: CGSize = .zero
    @State private var collageCache = CollageImageCache.shared
    @StateObject private var locationService = LocationService()

    var body: some View {
        GeometryReader { geo in
            let screenH = geo.size.height
        ZStack {
            // Base background
            Color.pageBg.ignoresSafeArea()

            // Diagonal photo collage -- full screen
            DiagonalPhotoCollage(imageNames: CollageImageCache.names, images: collageCache.images)
                .offset(collageDrag)
                .ignoresSafeArea()

            // Blur mask (shared shape, same system as SignInView)
            //
            // Top:    black -> clear over collageTopBlurFadeEnd
            // Middle: clear (unblurred) until collageBlurFadeEnd
            // Bottom: clear -> black over collageBlurFadeLength, then solid black
            let blurMask = VStack(spacing: 0) {
                LinearGradient(
                    colors: [.black, .clear] as [Color],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .frame(height: screenH * collageTopBlurFadeEnd)

                Color.clear
                    .frame(height: screenH * max(collageBlurFadeEnd - collageTopBlurFadeEnd, 0))

                LinearGradient(
                    colors: [.clear, .black] as [Color],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .frame(height: screenH * collageBlurFadeLength)

                Color.black
            }

            // Blur layer
            Rectangle()
                .fill(.ultraThinMaterial)
                .mask(blurMask)
                .ignoresSafeArea()

            // Fade to background color -- same mask so it follows the blur transition
            Color.pageBg
                .mask(blurMask)
                .opacity(0.60)
                .ignoresSafeArea()

            // Foreground content
            VStack(spacing: 0) {
                Spacer()

                VStack(spacing: 6) {
                    Text("Upload & Identify")
                        .font(.system(.title, design: .serif, weight: .semibold))
                        .foregroundStyle(Color.foregroundText)
                    Text("One bird per photo for accuracy\nClose-ups and side profiles work best")
                        .font(.subheadline)
                        .foregroundStyle(Color.mutedText)
                        .multilineTextAlignment(.center)
                }

                Spacer().frame(height: 28)

                VStack(spacing: 12) {
                    Button {
                        showLibrary = true
                    } label: {
                        Label("Choose from Library", systemImage: "photo.on.rectangle")
                            .font(.body.weight(.medium))
                            .frame(maxWidth: .infinity, minHeight: 50)
                    }
                    .buttonStyle(.glassProminent)
                    .buttonSizing(.flexible)

                    Button {
                        openCamera()
                    } label: {
                        Label("Take Photo", systemImage: "camera")
                            .font(.body.weight(.medium))
                            .frame(maxWidth: .infinity, minHeight: 50)
                    }
                    .buttonStyle(.glass)
                    .buttonSizing(.flexible)
                    .disabled(!UIImagePickerController.isSourceTypeAvailable(.camera))
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 24)
            }
        }
        .contentShape(Rectangle())
        .simultaneousGesture(
            DragGesture()
                .onChanged { value in
                    // Rubber-band function: maps unbounded input to bounded output.
                    // limit: max displacement in points
                    // resistance: how hard to drag (higher = stiffer). 1.0 = no resistance.
                    let rubberBand = { (v: CGFloat, limit: CGFloat, resistance: CGFloat) -> CGFloat in
                        limit * tanh(v / (limit * resistance))
                    }
                    let limit: CGFloat = 60   // max pixels the collage can move
                    let resistance: CGFloat = 16  // drag divisor (16 = very stiff)
                    collageDrag = CGSize(
                        width: rubberBand(value.translation.width, limit, resistance),
                        height: rubberBand(value.translation.height, limit, resistance)
                    )
                }
                .onEnded { _ in
                    // Spring back to center
                    // response: duration in seconds (lower = snappier)
                    // dampingFraction: 0 = infinite bounce, 1 = no bounce (critically damped)
                    withAnimation(.spring(response: 0.4, dampingFraction: 0.6)) {
                        collageDrag = .zero
                    }
                }
        )
        .toolbar(.hidden, for: .navigationBar)
        }
        .task { await collageCache.load() }
        .onChange(of: viewModel.selectedItems) {
            if !viewModel.selectedItems.isEmpty {
                Task { await viewModel.processSelectedPhotos() }
            }
        }
        .photosPicker(
            isPresented: $showLibrary,
            selection: $viewModel.selectedItems,
            matching: .images
        )
        .task(id: navigation.addPhotosLaunchRequest?.id) {
            guard let request = navigation.addPhotosLaunchRequest else { return }
            navigation.consumeAddPhotosLaunchRequest(id: request.id)
            switch request.action {
            case .library:
                showLibrary = true
            case .camera:
                if UIImagePickerController.isSourceTypeAvailable(.camera) {
                    openCamera()
                } else {
                    showCameraUnavailable = true
                }
            }
        }
        .alert("Camera Unavailable", isPresented: $showCameraUnavailable) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("This device does not have an available camera.")
        }
        .fullScreenCover(isPresented: $showCamera, onDismiss: {
            locationService.stop()
            if !viewModel.cameraPhotos.isEmpty {
                Task { await viewModel.processSelectedPhotos() }
            }
        }) {
            CameraCaptureView { image in
                let coord = locationService.latestCoordinate
                viewModel.addCameraPhoto(image, lat: coord?.lat, lon: coord?.lon)
            }
            .ignoresSafeArea()
        }
    }

    private func openCamera() {
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            showCameraUnavailable = true
            return
        }
        locationService.start()
        showCamera = true
    }

}

// MARK: - Diagonal Photo Collage

/// Netflix-style diagonal scrolling photo grid background.
private struct DiagonalPhotoCollage: View {
    let imageNames: [String]
    let images: [String: UIImage]

    var body: some View {
        if imageNames.isEmpty { Color.clear } else {
        GeometryReader { geo in
            let pitch = collageTileSize + collageSpacing
            let extraWidth = geo.size.height * abs(sin(collageAngle * .pi / 180))
            let tilesPerRow = Int((geo.size.width + extraWidth) / pitch) + 2

            VStack(spacing: collageSpacing) {
                ForEach(0..<collageRows, id: \.self) { row in
                    HStack(spacing: collageSpacing) {
                        if !row.isMultiple(of: 2) {
                            Spacer().frame(width: pitch, height: collageTileSize)
                        }
                        ForEach(0..<tilesPerRow, id: \.self) { col in
                            let index = (row * tilesPerRow + col) % imageNames.count
                            let name = imageNames[index]
                            if let img = images[name] {
                                Image(uiImage: img)
                                    .resizable()
                                    .scaledToFill()
                                    .frame(width: collageTileSize, height: collageTileSize)
                                    .clipShape(RoundedRectangle(cornerRadius: collageCornerRadius))
                            } else {
                                Color.warmBorder.opacity(0.15)
                                    .frame(width: collageTileSize, height: collageTileSize)
                                    .clipShape(RoundedRectangle(cornerRadius: collageCornerRadius))
                            }
                        }
                    }
                }
            }
            .drawingGroup()
            .frame(width: geo.size.width + extraWidth)
            .rotationEffect(.degrees(collageAngle))
            .offset(x: -extraWidth / 2, y: -pitch)
            .opacity(collageOpacity)
        }
        }
    }
}

// MARK: - Camera Capture View

/// UIKit camera wrapper for SwiftUI. Uses UIImagePickerController which is
/// the standard iOS camera interface with built-in photo capture UI.
struct CameraCaptureView: UIViewControllerRepresentable {
    let onCapture: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onCapture: onCapture, dismiss: dismiss)
    }

    class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onCapture: (UIImage) -> Void
        let dismiss: DismissAction

        init(onCapture: @escaping (UIImage) -> Void, dismiss: DismissAction) {
            self.onCapture = onCapture
            self.dismiss = dismiss
        }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage {
                onCapture(image)
            }
            dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            dismiss()
        }
    }
}

// MARK: - Previews

#if DEBUG
#Preview {
    PreviewTabs(.add) {
        NavigationStack {
            PhotoSelectionView(viewModel: AddPhotosViewModel())
        }
    }
}
#endif
