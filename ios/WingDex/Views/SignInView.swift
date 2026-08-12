import AuthenticationServices
import CoreMotion
import os
import SwiftUI

private let log = Logger(subsystem: Config.bundleID, category: "SignIn")

// MARK: - Sign-In Collage Parameters

private let signInTileSize: CGFloat = 175
private let signInSpacing: CGFloat = 5
private let signInAngle: Double = -20
private let signInRows = 6
private let signInCornerRadius: CGFloat = 10
/// 3D tilt angle (degrees) -- tilts the collage "into" the screen
private let signInPerspectiveTilt: Double = 30
private let signInPerspectiveAmount: CGFloat = 1.0
/// How many points the collage shifts per unit of device tilt
private let signInParallaxStrength: CGFloat = 20

// -- Blur overlay parameters (same system as PhotoSelectionView's collageFadeEnd/collageFadeLength) --

/// Where the top blur finishes fading out (fraction from top, 0 = no top blur)
private let signInTopBlurFadeEnd: Double = 0.10
/// How far down the screen photos remains crisp (0 = top only, 1 = full screen)
private let signInBlurFadeEnd: Double = 0.4
/// Blur fade-in length as a fraction of screen height
private let signInBlurFadeLength: Double = 0.2
/// Darkening tint in light mode (0 = none, 1 = solid black). Applied with same mask as blur.
private let signInDarkenLight: Double = 0.5
/// Darkening tint in dark mode
private let signInDarkenDark: Double = 0.7

/// Full-screen sign-in view.
struct SignInView: View {
    @Environment(AuthService.self) private var auth
    @Environment(DataStore.self) private var store

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .largeTitle) private var titleSize: CGFloat = 52

    @State private var isSigningIn = false
    @State private var errorMessage: String?
    @State private var parallaxOffset: CGSize = .zero
    @State private var collageCache = CollageImageCache.shared
    @State private var pendingSignIn: (() async throws -> Void)?
    @State private var showingDataWarning = false

    private var hasAnonymousData: Bool {
        auth.identity == .anonymous
            && (!store.hasLoadedAll || !store.outings.isEmpty || !store.observations.isEmpty)
    }

    var body: some View {
        GeometryReader { geo in
            let screenH = geo.size.height
        ZStack {
            // Base background
            Color.pageBg.ignoresSafeArea()

            // 3D perspective diagonal photo collage -- full screen
            SignInCollage(imageNames: CollageImageCache.names, images: collageCache.images)
                .offset(parallaxOffset)
                .ignoresSafeArea()
                .accessibilityHidden(true)

            // Blur + darkening mask (shared shape)
            //
            // Top:    black -> clear over signInTopBlurFadeEnd
            // Middle: clear (unblurred) until signInBlurFadeEnd
            // Bottom: clear -> black over signInBlurFadeLength, then solid black
            let blurMask = VStack(spacing: 0) {
                LinearGradient(
                    colors: [Color.black, .clear],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .frame(height: screenH * signInTopBlurFadeEnd)

                Color.clear
                    .frame(height: screenH * max(signInBlurFadeEnd - signInTopBlurFadeEnd, 0))

                LinearGradient(
                    colors: [.clear, Color.black],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .frame(height: screenH * signInBlurFadeLength)

                Color.black
            }

            // Blur layer
            Rectangle()
                .fill(.ultraThinMaterial)
                .environment(\.colorScheme, .dark)
                .mask(blurMask)
                .ignoresSafeArea()

            // Darkening layer -- same mask shape so dark tint follows the blur
            let darkenOpacity = colorScheme == .dark
                ? signInDarkenDark
                : signInDarkenLight
            Color.black
                .mask(blurMask)
                .opacity(darkenOpacity)
                .ignoresSafeArea()

            // Foreground content
            ScrollView {
            VStack(spacing: 0) {
                // Top bar
                HStack {
                    AppIconView()
                        .frame(width: 44, height: 44)
                    Spacer()
                }
                .padding(.horizontal, 28)
                .padding(.top, 8)

                Spacer()

                // Big left-aligned title
                VStack(alignment: .leading, spacing: 8) {
                    Text("Start your")
                        .font(.system(size: titleSize, weight: .bold, design: .serif))
                    Text("WingDex")
                        .font(.system(size: titleSize, weight: .bold, design: .serif))
                        .foregroundStyle(Color.accentColor)
                        .environment(\.colorScheme, .dark)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .foregroundStyle(.white)
                .padding(.horizontal, 28)
                .padding(.bottom, 32)

                if hasAnonymousData {
                    VStack(spacing: 6) {
                        Text("Keep your sightings")
                            .font(.title2.weight(.semibold))
                        Text("Your sightings are saved only on this device. They can disappear if the app's data is removed or you switch devices. An account keeps them and unlocks import and export. It takes one tap and no email.")
                            .font(.subheadline)
                            .multilineTextAlignment(.center)
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 28)
                    .padding(.bottom, 20)
                }

                // Social sign-in buttons
                let btnHeight: CGFloat = 44
                let iconSize: CGFloat = btnHeight * 0.32
                let glassLabelHeight: CGFloat = btnHeight - 14
                VStack(spacing: 12) {
                    // Apple -- native SignInWithAppleButton
                    SignInWithAppleButton(.continue) { request in
                        request.requestedScopes = [.fullName, .email]
                    } onCompletion: { result in
                        requestSignIn {
                            let authorization = try result.get()
                            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
                                throw URLError(.userAuthenticationRequired)
                            }
                            try await auth.signInWithApple(credential: credential)
                        }
                    }
                    .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
                    .id(colorScheme)
                    .frame(height: btnHeight)
                    .clipShape(Capsule())

                    // Google -- neutral style per branding guidelines
                    Button {
                        requestSignIn { try await auth.signInWithGoogle() }
                    } label: {
                        HStack(spacing: 6) {
                            Image("GoogleIcon")
                                .resizable()
                                .scaledToFit()
                                .frame(width: iconSize, height: iconSize)
                            Text("Continue with Google")
                                .font(.body.weight(.medium))
                        }
                        .frame(maxWidth: .infinity)
                        .frame(minHeight: glassLabelHeight)
                        .clipShape(Capsule())
                    }
                    .buttonStyle(.glass)
                    .colorScheme(colorScheme == .dark ? .light : .dark)
                    .background(Color.black.opacity(0.72), in: Capsule())

                    // GitHub -- neutral style matching Google
                    Button {
                        requestSignIn { try await auth.signInWithGitHub() }
                    } label: {
                        HStack(spacing: 6) {
                            Image("GitHubIcon")
                                .renderingMode(.template)
                                .resizable()
                                .scaledToFit()
                                .frame(width: iconSize, height: iconSize)
                            Text("Continue with GitHub")
                                .font(.body.weight(.medium))
                        }
                        .frame(maxWidth: .infinity)
                        .frame(minHeight: glassLabelHeight)
                        .clipShape(Capsule())
                    }
                    .buttonStyle(.glass)
                    .colorScheme(colorScheme == .dark ? .light : .dark)
                    .background(Color.black.opacity(0.72), in: Capsule())
                }
                .padding(.horizontal, 28)

                // OR divider
                HStack(spacing: 8) {
                    Rectangle().fill(.white.opacity(0.2)).frame(height: 1)
                    Text("OR")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.white)
                    Rectangle().fill(.white.opacity(0.2)).frame(height: 1)
                }
                .padding(.horizontal, 28)
                .padding(.vertical, 16)

                // Passkey section
                VStack(spacing: 12) {
                    Label {
                        Text("Continue with a Passkey")
                            .fixedSize(horizontal: false, vertical: true)
                    } icon: {
                        Image(systemName: "person.badge.key.fill")
                    }
                    .font(.body.weight(.medium))
                    .foregroundStyle(.white)

                    // Both controls use prominent material for reliable contrast
                    // over the moving collage; tint distinguishes login/signup.
                    HStack(spacing: 12) {
                        Button {
                            requestSignIn { try await auth.signInWithPasskey() }
                        } label: {
                            Text("Log in")
                                .font(.body.weight(.medium))
                                .frame(minHeight: glassLabelHeight)
                        }
                        .buttonStyle(.glassProminent)
                        .buttonSizing(.flexible)
                        .tint(Color(red: 0.0, green: 0.28, blue: 0.14))
                        .accessibilityIdentifier("auth.passkeyLogin")

                        Button {
                            signIn { try await auth.signUpWithPasskey() }
                        } label: {
                            Text("Sign up")
                                .font(.body.weight(.medium))
                                .frame(minHeight: glassLabelHeight)
                        }
                        .buttonStyle(.glassProminent)
                        .buttonSizing(.flexible)
                        .foregroundStyle(.white)
                        .tint(Color.black.opacity(0.82))
                    }
                }
                .padding(16)
                .background(
                    ZStack {
                        RoundedRectangle(cornerRadius: 22)
                            .fill(Color.black.opacity(0.78))
                        RoundedRectangle(cornerRadius: 22)
                            .fill(.ultraThinMaterial)
                            .environment(\.colorScheme, .dark)
                    }
                )
                .padding(.horizontal, 28)

                // Error message (stable layout)
                if let errorMessage {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                        .padding(.top, 8)
                }

                // Legal text
                Text("By continuing, you accept our [Terms of Use](https://wingdex.app/terms) and [Privacy Policy](https://wingdex.app/privacy).")
                    .font(.caption)
                    .foregroundStyle(.white.opacity(0.65))
                    .tint(.white.opacity(0.8))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 28)
                    .padding(.top, 4)
                    .padding(.bottom, 8)
            }
                    .frame(minHeight: screenH)
                    }
                    .scrollIndicators(.hidden)
                    .scrollBounceBehavior(.basedOnSize)
        }
        .disabled(isSigningIn)
        .overlay {
            if isSigningIn {
                ProgressView()
                    .frame(maxHeight: .infinity, alignment: .bottom)
                    .padding(.bottom, 40)
            }
        }
        .animation(.default, value: errorMessage)
        .sheet(isPresented: $showingDataWarning, onDismiss: {
            pendingSignIn = nil
        }) {
            SignInDataWarning {
                guard let action = pendingSignIn else { return }
                pendingSignIn = nil
                signIn(action: action)
            }
        }
        .task { await collageCache.load() }
        .onAppear {
            errorMessage = auth.consumeSignInMessage()
            startParallax()
        }
        .onChange(of: reduceMotion) { _, shouldReduceMotion in
            if shouldReduceMotion {
                stopParallax()
            } else {
                startParallax()
            }
        }
        .onDisappear { stopParallax() }
        }
    }

    // MARK: - Parallax Motion

    private static let motionManager = CMMotionManager()
    @State private var gravityBaseline: (x: Double, y: Double)?

    private func startParallax() {
        let manager = Self.motionManager
        guard !reduceMotion,
              manager.isDeviceMotionAvailable,
              !manager.isDeviceMotionActive
        else { return }
        gravityBaseline = nil
        // 30 Hz is deliberate: 60 Hz caused excess render churn, while 15 Hz
        // made the parallax visibly choppy.
        manager.deviceMotionUpdateInterval = 1.0 / 30.0
        manager.startDeviceMotionUpdates(to: .main) { motion, _ in
            guard let gravity = motion?.gravity else { return }
            if gravityBaseline == nil {
                gravityBaseline = (gravity.x, gravity.y)
            }
            let base = gravityBaseline!
            let dx = gravity.x - base.x
            let dy = -(gravity.y - base.y)
            let clamp = { (v: Double) -> Double in min(max(v, -1), 1) }
            let newOffset = CGSize(
                width: clamp(dx) * signInParallaxStrength,
                height: clamp(dy) * signInParallaxStrength
            )
            // Skip update if movement is below threshold (saves render cycles)
            let deltaW = abs(newOffset.width - parallaxOffset.width)
            let deltaH = abs(newOffset.height - parallaxOffset.height)
            if deltaW > 0.1 || deltaH > 0.1 {
                parallaxOffset = newOffset
            }
        }
    }

    private func stopParallax() {
        Self.motionManager.stopDeviceMotionUpdates()
        gravityBaseline = nil
        parallaxOffset = .zero
    }

    // MARK: - Sign-In Handler

    private func requestSignIn(action: @escaping () async throws -> Void) {
        guard hasAnonymousData else {
            signIn(action: action)
            return
        }
        pendingSignIn = action
        showingDataWarning = true
    }

    private func signIn(action: @escaping () async throws -> Void) {
        isSigningIn = true
        errorMessage = nil
        Task {
            do {
                try await action()
            } catch {
                errorMessage = AppError.map(error, fallback: "Authentication failed. Try again.")?.message
                log.debug("Sign-in attempt failed")
            }
            isSigningIn = false
        }
    }
}

private struct SignInDataWarning: View {
    @Environment(AuthService.self) private var auth
    @Environment(\.dismiss) private var dismiss
    @State private var exportItem: ExportFileItem?
    @State private var exportError: AppError?
    @State private var isExporting = false

    let onContinue: () -> Void

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Your sightings stay on this device")
                        .font(.headline)
                    Text("They belong to this device, not to the account you are about to log in to, so they will not show up there. Export them first if you want a copy.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Text("Signing up instead keeps them: it turns this device's sightings into an account.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(Color.yellow.opacity(0.12), in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.yellow.opacity(0.45)))

                Button {
                    Task { await exportSightings() }
                } label: {
                    Label(isExporting ? "Exporting..." : "Export sightings as CSV", systemImage: "square.and.arrow.up")
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.glass)
                .buttonSizing(.flexible)
                .disabled(isExporting)

                Button("Continue to log in") {
                    dismiss()
                    onContinue()
                }
                .buttonStyle(.glassProminent)
                .buttonSizing(.flexible)
                .frame(maxWidth: .infinity)

                Button("Back", role: .cancel) { dismiss() }
                    .buttonStyle(.glass)
                    .buttonSizing(.flexible)
                    .frame(maxWidth: .infinity)

                if let exportError {
                    Text(exportError.message)
                        .font(.caption)
                        .foregroundStyle(.red)
                }

                Spacer()
            }
            .padding(20)
            .background(Color.pageBg.ignoresSafeArea())
            .navigationTitle("Before You Log In")
            .navigationBarTitleDisplayMode(.inline)
            .sheet(item: $exportItem) { item in
                ActivityView(item: item)
            }
        }
    }

    private func exportSightings() async {
        isExporting = true
        exportError = nil
        defer { isExporting = false }
        do {
            let data = try await DataService(
                auth: auth,
                expectedAccountID: auth.userId
            ).exportSightingsCSV()
            exportItem = try ExportFileFactory.sightings(data: data)
        } catch {
            exportError = AppError.map(error, fallback: "Could not export sightings. Try again.")
        }
    }
}

// MARK: - 3D Perspective Photo Collage

/// Diagonal photo grid with 3D perspective tilt for a cinematic background.
private struct SignInCollage: View {
    let imageNames: [String]
    let images: [String: UIImage]

    var body: some View {
        if imageNames.isEmpty { Color.clear } else {
        GeometryReader { geo in
            let pitch = signInTileSize + signInSpacing
            let extraWidth = geo.size.height * abs(sin(signInAngle * .pi / 180))
            let tilesPerRow = Int((geo.size.width + extraWidth) / pitch) + 4

            VStack(spacing: signInSpacing) {
                ForEach(0..<signInRows, id: \.self) { row in
                    HStack(spacing: signInSpacing) {
                        if !row.isMultiple(of: 2) {
                            Spacer().frame(width: pitch, height: signInTileSize)
                        }
                        ForEach(0..<tilesPerRow, id: \.self) { col in
                            let index = (row * tilesPerRow + col) % imageNames.count
                            let name = imageNames[index]
                            if let img = images[name] {
                                Image(uiImage: img)
                                    .resizable()
                                    .scaledToFill()
                                    .frame(width: signInTileSize, height: signInTileSize)
                                    .clipShape(RoundedRectangle(cornerRadius: signInCornerRadius))
                            } else {
                                Color.black.opacity(0.15)
                                    .frame(width: signInTileSize, height: signInTileSize)
                                    .clipShape(RoundedRectangle(cornerRadius: signInCornerRadius))
                            }
                        }
                    }
                }
            }
            .drawingGroup()
            .frame(width: geo.size.width + extraWidth)
            .rotationEffect(.degrees(signInAngle))
            .offset(x: -extraWidth / 2, y: -pitch)
            // 3D perspective
            .rotation3DEffect(
                .degrees(signInPerspectiveTilt),
                axis: (x: 1, y: 1, z: -0.5),
                anchor: .center,
                perspective: signInPerspectiveAmount
            )
        }
        }
    }
}

#if DEBUG
#Preview("Sign In - Light") {
    SignInView()
        .environment(AuthService())
        .environment(previewStore(empty: true))
        .preferredColorScheme(.light)
}

#Preview("Sign In - Dark") {
    SignInView()
        .environment(AuthService())
        .environment(previewStore(empty: true))
        .preferredColorScheme(.dark)
}
#endif
