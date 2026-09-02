# WingDex iOS

Native SwiftUI companion app for [WingDex](https://wingdex.app). Shares the same Cloudflare REST API as the web app - the server owns all business logic, so the iOS app is a thin UI client.

**Target:** iOS 26+ / Xcode 26+ / Swift 6

## Architecture

- **SwiftUI lifecycle** with tab bar navigation (Home, WingDex, Outings) and a detached upload button
- **OpenAPI-generated client** via `swift-openapi-generator` from the shared `openapi.yaml`
- **Auth:** anonymous sessions, passkeys (WebAuthn), and social OAuth (GitHub, Google, Apple) via Better Auth bearer tokens
- **Strict concurrency** (`SWIFT_STRICT_CONCURRENCY: complete`)

## Prerequisites

- Xcode 26.3+
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`)
- Apple Developer account (for device builds and Sign in with Apple)

## Setup

```bash
cd ios
xcodegen generate
open WingDex.xcodeproj
```

The Xcode project is generated from `project.yml`. SPM dependencies (swift-openapi-runtime, KeychainAccess) resolve automatically on first build.

The app connects to the web API. For local development, start the web backend first:

```bash
# From the repo root
npm run dev
```

Then run the iOS app in the simulator pointing at `http://localhost:5000`.

## Debug sign-in

Automatic anonymous sign-in is available in Debug builds only.

In Xcode:

1. Select the `Dev` scheme and an iPhone Simulator.
2. Open **Product > Scheme > Edit Scheme > Run > Arguments**.
3. Add and enable `--auto-sign-in`.
4. Run the app.

`--auto-sign-in` creates an anonymous account against `https://dev.wingdex.app`.
Use the `Localhost` scheme instead if the local backend is running.

The equivalent command-line launch for an already-built Debug app is:

```bash
xcrun simctl launch --terminate-running-process booted app.wingdex \
	--auto-sign-in
```

Build and install the `Dev Debug` configuration first when the Simulator does not
already contain the current app. Release and Production builds intentionally ignore
these arguments.

## Project structure

| Path | Purpose |
|------|---------|
| `App/` | App entry point (`WingDexApp.swift`) |
| `Views/` | SwiftUI views (Home, WingDex, Outings, Settings, Species, etc.) |
| `ViewModels/` | View models and state management |
| `Models/` | Data models (mirrors TypeScript types + OpenAPI schema) |
| `Services/` | AuthService, DataService, DataStore |
| `Extensions/` | Swift extensions |
| `Resources/` | App icon, assets |
| `scripts/` | Build helpers (version bump, icon fix, git info generation) |

## Build scripts

| Script | Purpose |
|--------|---------|
| `scripts/gen-git-info.sh` | Generate `GitInfo.swift` with commit hash and branch |
| `scripts/bump-version.sh` | Bump marketing version or build number |
| `scripts/fix-icon-ref.sh` | Fix Xcode project icon references after generation |

## CI

iOS builds and tests run via `.github/workflows/ios.yml` on PRs that touch `ios/`, `openapi.yaml`, or `functions/`. Releases are handled by `.github/workflows/ios-release.yml`.

To publish a deliberate milestone version without marking a commit as breaking, dispatch the release workflow with an exact version:

```bash
gh workflow run ios-release.yml --ref main -f release_version=1.0.0
```

The override must be greater than the latest `ios-v*` tag. It keeps the existing successful-iOS-check gate and rebuilds the archive with the requested marketing version.
