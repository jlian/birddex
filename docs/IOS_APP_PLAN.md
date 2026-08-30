# Native iOS App (SwiftUI) - Plan & Tracker

> Source: [Issue #131](https://github.com/jlian/wingdex/issues/131) - Last updated: 2026-03-04
>
> **Legend**: ✅ Done - ⏳ In Progress - _(unchecked)_ Not started
>
> **Source of truth**: The web app code is the sole source of truth for feature parity. There is no separate PRD.

---

## Overview

A native SwiftUI iOS app that shares the Cloudflare REST API with the web SPA. The server owns all business logic (bird ID, taxonomy search, eBird import, dex computation), so the iOS app is a thin UI client with zero business-logic duplication.

**Target**: iOS 26+ / Xcode 26+ / Swift 6 / SwiftUI lifecycle

---

## Design Principles

The app should feel fully iOS-native, not a web wrapper. Key guidelines:

- **Apple HIG first** - follow the [Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/) for layout, navigation, typography, and interaction patterns
- **Liquid Glass** - use the iOS 26 liquid glass material system: standard SwiftUI components (TabView, NavigationStack, toolbars, sheets) adopt glass automatically when built with the iOS 26 SDK
- **Bottom tab bar** - three content tabs (Home, WingDex, Outings) clustered left, plus a detached "+" upload button on the right (Apple Music-style layout); no Settings tab (settings accessed via avatar button in top-right navigation bar)
- **System typography** - use SF Pro / SF Rounded via SwiftUI's `.font()` modifiers; no custom fonts unless branding requires it
- **SF Symbols** - prefer Apple's symbol library over custom icons; use symbol effects (bounce, pulse) where appropriate
- **Native controls** - use system pickers, sheets, confirmations, and alerts rather than custom implementations
- **Dark mode** - full support via SwiftUI's automatic color scheme handling, semantic colors, and a user-facing Light/Dark/System toggle
- **Dynamic Type** - all text should scale with the user's preferred text size
- **Accessibility** - VoiceOver labels on all interactive elements; large content viewer support for key metrics
- **Match web vibe, not pixels** - same warm palette (beige page bg, green accent, muted borders) and overall feel as the web app, but using native controls and idioms rather than pixel-perfect clones
- **Shared color palette** - Xcode color assets derived from the web app's computed RGB values; if the web palette changes, update `Assets.xcassets` color sets to match
- **No custom button chrome** - use `.buttonStyle(.bordered)` / `.borderedProminent` and system tints instead of hand-drawn outlines or custom shapes

---

## Navigation Architecture

The app uses a tab bar + navigation bar layout inspired by Apple Music:

```text
┌─────────────────────────────────────────────────┐
│  ◀ Back    Page Title           [Avatar Button] │  <- Navigation bar (per-tab NavigationStack)
│                                                 │
│                 Content Area                    │
│                                                 │
├──────────────────────────────┬──────────────────┤
│  🏠 Home  🐦 WingDex  🔭 Outings │     [＋]      │  <- Tab bar: 3 tabs left, + button right
└──────────────────────────────┴──────────────────┘
```

### Tab Bar

- **Three content tabs clustered left**: Home, WingDex, Outings - these are standard `Tab` items in a `TabView`
- **Detached "+" button on the right**: An "Upload & Identify" action button visually separated from the three nav tabs (like Apple Music's "+" or Spotify's "Create" button). Tapping opens the Add Photos flow as a full-screen `.sheet`. This is NOT a tab destination - it triggers an action
- **No Settings tab**: Settings is accessed from the avatar button in the navigation bar, not from the tab bar

### Avatar / Settings Button

- **Position**: Top-right of the navigation bar (visible on all tabs), matching the web app's header layout and Apple Music's profile button
- **Appearance**: User's avatar image (emoji or social provider photo) rendered as a small circular button (~28pt). If no avatar, show a default person icon
- **Tap action**: Opens a card-style sheet (`.presentationDetents([.medium, .large])`) containing all settings content - Apple Music-style profile card that slides up from the bottom
- **Content**: The existing SettingsView content (account, avatar selection, appearance toggle, import/export, passkeys, data management, sign out) presented inside this card sheet rather than as a tab destination

### Files

- `WingDexApp.swift` - TabView with 3 tabs + toolbar avatar button + sheet for settings
- `SettingsView.swift` - content presented inside the avatar card sheet (no longer a tab)

---

## Prerequisites

- [x] Cloudflare migration (#74) - server-side bird ID, taxonomy search, eBird import
- [x] `openapi.yaml` at repo root describing all API endpoints + schemas
- [x] Apple Developer account ($99/yr)
- [x] Sign in with Apple configured (backend already handles Apple OAuth)
- [x] Register App ID (`app.wingdex`) in Apple Developer portal
- [x] Xcode project in `ios/` directory

### Apple Developer Portal Checklist

- [x] **Register App ID** - `app.wingdex` registered (Team Z8LQS5S492)
- [ ] **Create provisioning profile** - for Development (automatic signing handles simulator; explicit profiles needed for CI)
- [x] **Configure Associated Domains** - AASA file at `public/.well-known/apple-app-site-association`, entitlements with `webcredentials:wingdex.pages.dev`
- [ ] **App Store Connect** - create the app listing when ready for TestFlight

---

## Auth Strategy

The backend uses cookie-based sessions via Better Auth for the web app. For the iOS app, we use Better Auth's official `bearer()` plugin (`better-auth/plugins`) which natively accepts `Authorization: Bearer <session_token>` headers - no cookie translation middleware needed. The session token is obtained via OAuth redirect flow or passkey ceremony and stored securely in iOS Keychain.

### Server-Side

- [x] `bearer()` plugin added to Better Auth - natively accepts `Authorization: Bearer` headers (Phase 3.1)
- [x] `GET /api/auth/mobile/callback` - bridge endpoint reads session after OAuth, redirects to `wingdex://auth/callback?token=...`
- [x] `GET /api/auth/mobile/start` - GET proxy for ASWebAuthenticationSession, internally POSTs to Better Auth sign-in/social
- [x] Remove legacy middleware cookie translation (Phase 3.1)
- [x] `GET /api/auth/mobile/callback` - bridge endpoint reads session cookie after OAuth, redirects to `wingdex://auth/callback?token=...`
- [x] `GET /api/auth/mobile/start` - GET proxy for ASWebAuthenticationSession, internally POSTs to Better Auth sign-in/social

### iOS Client (done)

- [x] `ASWebAuthenticationSession` for GitHub and Apple OAuth
- [x] Native Apple Sign-In via `ASAuthorizationAppleIDProvider`
- [x] Passkey sign-in and registration via `ASAuthorizationPlatformPublicKeyCredentialProvider`
- [x] Session token stored in Keychain, auto-restored on launch
- [x] Sign out clears Keychain + resets app state

---

## Architecture

```text
ios/
  WingDex/
    App/                    <- SwiftUI App entry, TabView, navigation
    Views/
      HomeView.swift
      OutingsView.swift
      OutingDetailView.swift
      WingDexView.swift
      SpeciesDetailView.swift
      SettingsView.swift    <- Presented in avatar card sheet, not a tab
      SignInView.swift
      PasskeyManagementView.swift
      AddPhotosFlow/        <- Multi-step wizard (sheet)
        PhotoSelectionView.swift
        OutingReviewView.swift  <- reverse geocode, place search, outing matching
        PerPhotoConfirmView.swift <- per-photo confirm with Wikipedia ref
        CropView.swift
    ViewModels/
      AddPhotosViewModel.swift
    Models/
      AppModels.swift
    Services/
      AuthService.swift
      DataService.swift
      DataStore.swift
      PhotoService.swift
      CropService.swift
      PasskeyService.swift
    Extensions/
      Theme.swift
      DateFormatting.swift
      Data+Base64URL.swift
    Resources/
      taxonomy.json
```

### What changes are "free" (no app release needed)

| Change type | iOS work |
| --- | --- |
| New API field (e.g., add `notes` to Observation) | Zero - update Codable model |
| Backend logic change (e.g., better clustering, prompt tweak) | Zero |
| AI prompt improvement | Zero |
| Taxonomy update | Zero (server-side search); app bundle update for offline typeahead |

### What needs a native build

| Change type | iOS work |
| --- | --- |
| New data view (e.g., statistics chart) | Build SwiftUI view |
| New flow (e.g., social sharing) | Build SwiftUI flow + API calls |
| UI/UX changes | SwiftUI view updates |

---

## Phase 0 - Project Scaffold ✅

- [x] Write `openapi.yaml` covering all 20+ API endpoints
- [x] Create Xcode project with SwiftUI App lifecycle
- [x] Configure SPM dependencies (`swift-openapi-runtime`, `swift-openapi-urlsession`, `KeychainAccess`)
- [x] Create `TabView` shell with placeholder views
- [x] Stub all views, ViewModels, and services
- [x] Bundle `taxonomy.json` for offline typeahead
- [x] Add `.gitignore` and GitHub Actions CI (`ios.yml`)

---

## Phase 1 - Auth ✅

- [x] `AuthService` - ASWebAuthenticationSession OAuth for GitHub and Apple
- [x] Token management - Keychain storage, auto-restore, sign out
- [x] `SignInView` - GitHub + Apple + Passkey buttons with mode toggle (sign up / log in)
- [x] Native Apple Sign-In via `ASAuthorizationAppleIDProvider`
- [x] Passkey sign-in, registration, and management (`PasskeyManagementView`)
- [x] SettingsView auth UI - user info, sign out, delete data confirmations
- [x] **401 handling** - intercept 401 in DataService, auto-signout to show login screen

---

## Phase 2 - Core Data Views ✅

- [x] `HomeView` - species count, recent species cards (horizontal scroll, gradient overlay), recent outings list, "Upload & Identify" CTA, pull-to-refresh, empty state
- [x] `OutingsView` - chronological outing list with search, sort (date/species/name), mini map previews (MapKit), pull-to-refresh
- [x] `OutingDetailView` - stats cards, MapKit map, confirmed/possible species sections, editable notes, delete outing
- [x] `WingDexView` - species life list with `.searchable`, sort by date/count/name, center-cropped thumbnails, image cache (200 limit)
- [x] `SpeciesDetailView` - hero image with progressive load (blurred thumbnail -> full-res), Wikipedia extract + CC BY-SA attribution, external links (Wikipedia, eBird, All About Birds), sightings list
- [x] Data layer - `DataService` + `DataStore` backed by `/api/data/all`, environment injection

---

## Phase 2.5 - Styling & Layout ✅

- [x] Color assets - PageBackground, CardBackground, AccentColor from web's computed RGB values
- [x] Theme extension - `Color.pageBg`, `.cardBg`, `.mutedText`, `.foregroundText`, `.warmBorder`
- [x] Edge-to-edge layout - `UILaunchScreen: {}` for full-screen rendering
- [x] Native `List` + `.listStyle(.plain)` + `.scrollContentBackground(.hidden)` + `UITableViewCell.appearance().backgroundColor` = themed backgrounds with native press highlights
- [x] SignInView - native buttons with consistent height, mode toggle
- [x] Tab bar icon - separate `BirdTab` image set for liquid glass rendering

---

## Phase 3 - Add Photos Flow (Initial) ✅

Basic flow implemented, but needs significant rework to match web app (see Phase 3-R).

- [x] `PhotoSelectionView` - `PhotosPicker` multi-select, load images
- [x] `PhotoService` - EXIF extraction (date/GPS), JPEG compression, thumbnail generation, SHA-256 hash, Haversine clustering (2hr/3km)
- [x] `ReviewView` - AI identification results per photo, confirm/reject (removed in Phase 3-R, replaced by PerPhotoConfirmView)
- [x] `CropView` - crop interaction with `CropService` math
- [x] `ConfirmView` - final review + save to API (removed in Phase 3-R, done screen moved to AddPhotosFlow)
- [x] `AddPhotosViewModel` - orchestrate flow, manage state between steps

---

## Phase 3.1 - Auth Rework: Migrate to Better Auth Bearer Plugin

The current auth implementation hand-rolls cookie name management, resulting in 19 hardcoded cookie strings, fragile `__Secure-` prefix logic, and a middleware hack that translates Bearer tokens to cookies. This phase replaces all of that with Better Auth's official `bearer()` plugin, which natively accepts `Authorization: Bearer <token>` - no cookie translation needed.

**Decision**: Use Better Auth's first-party `bearer()` plugin (`better-auth/plugins`, already in dependencies). This is the standard pattern for native mobile clients authenticating against Better Auth.

### 3.1.1: Server - Add Bearer Plugin ✅

- [x] **Add bearer plugin**: In `functions/lib/auth.ts`, add `bearer()` to the plugins array: `import { bearer } from 'better-auth/plugins'` then `plugins: [anonymous(), passkey({...}), bearer()]`
- [x] **Remove middleware cookie translation**: Deleted the entire Bearer-to-cookie injection block from `functions/_middleware.ts`. `getSession` now accepts `Authorization: Bearer` natively
- [x] **Verify getSession works with Bearer**: Verified via unit test and API smoke test
- [x] **Keep mobile/start and mobile/callback**: Kept, simplified callback to use `session.session.token` directly

**Files**: `functions/lib/auth.ts`, `functions/_middleware.ts`

### 3.1.2: Server - Fix Mobile Callback Token Extraction ✅

- [x] **Use raw session token**: Callback now uses `session.session.token` directly - no Set-Cookie parsing needed
- [x] **Remove manual cookie name parsing**: Deleted all `better-auth.session_token` and `__Secure-` string splitting

**Files**: `functions/api/auth/mobile/callback.ts`

### 3.1.3: iOS - Clean Up AuthService ✅

- [x] **fetchUserInfo - use Bearer header**: Replaced cookie header with `Authorization: Bearer` header
- [x] **processTokenResponse - simplify**: Now reads `set-auth-token` response header (bearer plugin), falls back to JSON `token` field. Deleted all Set-Cookie parsing
- [x] **Remove all hardcoded cookie name strings**: Zero `better-auth.session_token` or `__Secure-` strings in iOS codebase
- [x] **Keychain storage stays**: Unchanged

**Files**: `ios/WingDex/Services/AuthService.swift`

### 3.1.4: iOS - Clean Up PasskeyService ✅

- [x] **Registration options request**: Uses `Authorization: Bearer` header
- [x] **Registration verify request**: Uses `Authorization: Bearer` header. Challenge cookie forwarding kept (separate from session auth)
- [x] **Authentication verify - token extraction**: Reads `set-auth-token` header, falls back to JSON `session.token`
- [x] **Challenge cookie forwarding**: Kept as-is (uses `extractCookieHeader` and `HTTPCookie.cookies`)
- [x] **Remove all session cookie name strings**: Zero cookie name strings in PasskeyService

**Files**: `ios/WingDex/Services/PasskeyService.swift`

### 3.1.5: Security Hardening ✅

- [x] **Keychain accessibility**: Changed to `.accessibility(.whenPasscodeSetThisDeviceOnly)`
- [x] **Token not in logs**: Audited - no token values in log statements (only length/presence)
- [x] **Remove DEBUG cookie logging**: Removed (cookie translation deleted entirely)

**Files**: `ios/WingDex/Services/AuthService.swift`, `ios/WingDex/Services/PasskeyService.swift`, `ios/WingDex/Services/DataService.swift`, `functions/_middleware.ts`

### 3.1.6: Investigate Frequent get-session Polling

- [x] **Identify source**: The `[wrangler:info] GET /api/auth/get-session 200 OK (2ms)` every second observed in Wrangler logs needs investigation. Determine if this is from the web app's `useSession` hook polling, the iOS app, or a browser extension
- [x] **Fix if excessive**: If it's the web app, ensure `useSession` is not over-polling. Better Auth's `useSession` hook should only poll based on `updateAge` config, not every second

### 3.1.7: Verification

Test all auth flows end-to-end after migration:

- [x] **GitHub OAuth (physical device)**: Same flow on device pointing to `localhost.wingdex.app`
- [x] **Apple Sign-In**: Blocked on local dev - `.dev.vars` does not have `APPLE_CLIENT_ID`/`APPLE_CLIENT_SECRET`. Works on production/preview deployments where Apple credentials are configured in Cloudflare Pages dashboard. Native `ASAuthorizationAppleIDProvider` flow (bypasses web redirect) should work when credentials are present. **Skipped for local dev**
- [x] **Passkey sign-in**: Existing passkey -> Face ID -> data loads with correct user name/email (not guest)
- [x] **Passkey registration**: Fixed - passkey plugin endpoints require cookie-only auth (signed session token as cookie, no Bearer header). `AuthenticatedRequest.withCookieOnly()` used for all passkey endpoints
- [x] **Session persistence**: Kill app, relaunch -> session restored from Keychain -> data loads without re-auth. Stale cookies cleared on restore to prevent 401
- [x] **Sign out**: Clear state, return to sign-in screen, verify Keychain is empty
- [x] **Load demo data**: After sign-in, load demo data from settings -> data appears. Confirmation dialog added
- [x] **Token not in logs**: Check Xcode console and Wrangler terminal for any token values in log output

### 3.1.10: Remaining Issues from Manual Testing ✅

All critical issues resolved. Remaining items deferred or skipped.

- [x] **Passkey registration**: Fixed - all passkey endpoints now use `AuthenticatedRequest.withCookieOnly()` with signed session token. Challenge cookie properly forwarded between options and verify steps
- [x] **Passkey management list/delete**: Fixed - also switched to cookie-only auth
- [ ] **Passkey name/label mismatch**: Deferred - current behavior acceptable, may be affected by merged account situations
- [x] **Apple Sign-In not configured locally**: Skipped for local dev - works on deployed environments
- [x] **Load demo data - add confirmation**: Done - `.confirmationDialog` added
- [x] **Google Sign-In button**: Done - added to SignInView using same OAuth flow as GitHub. Note: Google OAuth fails on local dev (`localhost.wingdex.app`) because the redirect URI is not in Google Cloud Console's authorized list. Add `https://localhost.wingdex.app/api/auth/callback/google` to authorized redirect URIs in Google Cloud Console, or test on deployed environment only

### 3.1.8: Automated Tests

Server-side tests verifying Bearer token auth works end-to-end.

- [x] **Unit test - bearer plugin registered**: In `src/__tests__/auth-config.test.ts`, verifies bearer plugin is in plugins list
- [x] **API smoke test - Bearer auth CRUD**: In `e2e/api-smoke.spec.ts`, full CRUD with Bearer headers, 401 on invalid token
- [x] **API smoke test - get-session via Bearer**: Verifies `get-session` returns user with Bearer header
- [x] **API smoke test - mobile callback**: Sign in via cookies, hit `GET /api/auth/mobile/callback`, verify redirect contains token that works as Bearer
- [x] **Regression test - cookie auth still works**: Cookie auth verified for data endpoints and get-session

### 3.1.9: iOS Tests ✅

XCTest target exists with unit tests and integration tests for auth logic.

#### Unit Tests (no server needed)

- [x] **Create XCTest target**: `WingDexTests` target in `project.yml` with XCTest framework
- [x] **AuthService token parsing**: Tests for `parseCallbackURL` with valid URLs, missing params, invalid dates, URL-encoded values, real-world GitHub callback URLs
- [ ] **AuthService session restore**: Test `restoreSession()` reads from Keychain, validates expiry, signs out if expired (requires Keychain mocking)
- [ ] **PasskeyService token extraction**: Test that `set-auth-token` header is preferred over JSON body token (covered by integration tests)
- [x] **Config URL tiers**: Tests for `Config.apiBaseURL`, `bundleID`, `oauthCallbackScheme`, `rpID`, `aiDailyRateLimit`
- [x] **Date formatting edge cases**: ISO8601 with/without fractional seconds, timezone offsets, invalid strings, empty strings

#### Integration Tests (require running dev server)

- [x] **Anonymous sign-in + Bearer data fetch**: POST `/api/auth/sign-in/anonymous`, extract token, GET `/api/data/all` with Bearer, verify 200
- [x] **Bearer token rejection**: Invalid token returns 401, no auth returns 401
- [x] **Session validation via Bearer**: GET `/api/auth/get-session` with Bearer, verify `user.id`
- [x] **Data CRUD via Bearer**: Create outing, verify in `/api/data/all`, delete, verify gone
- [ ] **Sign-out clears Keychain**: Call `AuthService.signOut()`, verify `validToken()` throws (requires Keychain mocking)
- [ ] **Expired session handling**: Store expired token, verify `validToken()` throws (requires Keychain mocking)

**Files**: `ios/WingDexTests/AuthServiceTests.swift`, `ios/WingDexTests/AuthIntegrationTests.swift`

## Phase 3.5 - Navigation & SignIn Rework

The current iOS app uses a 4-tab layout (Home, WingDex, Outings, Settings) with an "Upload" button in the top-right nav bar. This needs to migrate to the new navigation architecture defined above, and the SignInView needs significant rework to match the web's auth modal.

### 3.5.1: Tab Bar & Navigation Migration

Migrate from the current 4-tab layout to the new architecture: 3 tabs left + detached add button right + avatar settings sheet.

- [x] **Remove Settings tab**: Deleted 4th tab. Three content tabs remain: Home, WingDex, Outings
- [x] **Cluster tabs left**: Three tabs grouped in `TabSection`, clustered left
- [x] **Add detached camera button**: `Tab(role: .search)` with `camera.fill` icon, visually detached on the right (Apple Music Search button pattern). Opens AddPhotosFlow as a tab destination
- [x] **Avatar button in nav bar**: 34pt circular avatar in toolbar (`.topBarTrailing`), renders emoji avatars from SVG data URLs with colored backgrounds, falls back to name initial then person icon. `.glassEffect(.regular.interactive())` hugs circular shape. Sort button stacks to its left. Tapping presents SettingsView as `.sheet` via `showSettings` environment action
- [x] **NavigationStack moved to MainTabView**: Each tab wraps its content in NavigationStack; removed from child views (HomeView, WingDexView, OutingsView, AddPhotosFlow)
- [x] **Custom SF Symbols**: `wingdex.bird.fill` (BirdTab) and `wingdex.bird` (BirdLogo) exported from SF Symbols app, replacing old Phosphor bird SVGs

**Files**: `WingDexApp.swift`, `SettingsView.swift`, `AddPhotosFlow.swift`, `HomeView.swift`, `WingDexView.swift`, `OutingsView.swift`, `Theme.swift`

### 3.5.2: SignInView Rework ✅

- [x] **Remove ScrollView**: Centered VStack layout, no scroll
- [x] **Title**: "Start your WingDex" when empty, "Keep your WingDex" when anonymous data exists (matching web)
- [x] **Social buttons**: GitHub, Apple, Google at top (all working)
- [x] **Passkey section with border**: Bordered container with muted fill, key icon header
- [x] **Two passkey buttons side-by-side**: "Log in" (filled) + "Sign up" (outlined)
- [x] **Remove mode toggle**: Removed entirely
- [x] **Error display**: Red error text below passkey section
- [x] **Demo data button** (DEBUG only): "Try with Demo Data" button that signs in anonymously and loads demo data
- [x] **Loading state**: ProgressView + disabled buttons when signing in
- [x] **Perf**: userImage now persisted in Keychain; session restores instantly without network

**Files**: `SignInView.swift`, `AuthService.swift`

## 3.5.3 - Polish & Parity

- [x] Custom SF Symbols: `wingdex.bird.fill` (BirdTab) and `wingdex.bird` (BirdLogo) exported from SF Symbols app, replacing old Phosphor bird SVGs
- [x] Empty state views: added `frame(maxWidth: .infinity, maxHeight: .infinity)` to fix white bars on empty WingDex/Outings views
- [x] Context menus: species rows show preview + Open in eBird/Wikipedia/Copy Name; outing rows show preview + Delete Outing; detail view rows also have context menus
- [x] Font size: bumped species/outing row text from 14/12px to 16/13px, darkened subtitle opacity
- [x] Home: species count + "species observed" in horizontal layout
- [x] Settings: "Log Out" (no confirmation), "Delete All Data" (with confirmation attached to button)
- [x] Associated domains: added `dev.wingdex.app` for passkeys on dev preview
- [x] Apple Sign-In: added `appBundleIdentifier` to server config for native iOS identity token verification
- [x] Config: restored simulator vs physical device URL split
- [x] Font weight adjustments (deferred - minor polish)
- [x] Flat circle avatar like Apple Music
- [x] Left justify the main view headers? I guess big is fine
- [x] Ebird Links don't work in details - should check web app we've fixed this bug before
- [x] Missing 3D Touch for homepage recent species
- [x] Missing chevron on homepage to go to Wingdex and outings lists (with sort)
- [x] Clickable maps? To Apple Maps?
- [x] Inconsistent font in outings detail view ("species") and species detail view (fix in web app as well)
- [x] Can probably just remove the all about birds link (fix in web app too)
- [x] Dark tint icon
- [x] Spacing for avatar and toolbar
- [x] Manage passkeys doesn't work when logged in via GitHub and Google weird
- [x] Auth page jank with loading wheel and error messages shifting page content. And also it shifts down when opened via log out
- [x] Improve `#Preview` data with more realistic data like demo data
- [x] Comments in the swift UI views

---

## Phase 3.6 - Dark Mode ✅

Follows system appearance automatically (no toggle needed, like Apple's own apps).

### 3.6.1: Move Hardcoded Colors to Asset Catalog ✅

- [x] **MutedText colorset**: light: rgb(70, 90, 105), dark: rgb(155, 152, 142) - oklch(0.65 0.03 85)
- [x] **ForegroundText colorset**: light: rgb(26, 37, 29), dark: rgb(228, 226, 220) - oklch(0.92 0.01 85)
- [x] **WarmBorder colorset**: light: rgb(196, 189, 176), dark: rgb(62, 72, 65) - oklch(0.32 0.02 155)
- [x] **Theme.swift**: all colors now use `Color("AssetName")` for automatic adaptation

### 3.6.2: System Appearance ✅

- [x] Follows system Light/Dark setting automatically - no toggle needed
- [x] All semantic colors adapt via asset catalog dark variants

### 3.6.3: Visual Audit ✅

- [x] Verified in simulator: dark forest green background, light text, adapted borders
- [x] UICollectionViewListCell appearance override works (uses Color refs)
- [x] Species card gradient overlays legible (white text on dark gradient)

---

## Phase 3-R - Add Photos Flow Rework

The iOS flow is ~60% feature-complete vs the web app. The web wizard is a 9-step flow with per-photo confirmation, two-tier AI, crop retry, and outing review. The iOS flow needs fundamental restructuring to match.

**Web flow**: upload -> extracting -> outing-review -> photo-processing -> \[manual-crop\] -> photo-confirm -> \[multi-cluster loop\] -> save -> done

**Current iOS flow**: selectPhotos -> processing -> review (batch) -> confirm -> done

**Target iOS flow**: selectPhotos -> extracting -> outingReview -> photoProcessing -> perPhotoConfirm (with crop-retry loop) -> save -> done

### 3-R.1: Outing Review Step

Does not exist on iOS. This is a NEW step inserted after photo extraction/clustering and BEFORE AI identification.

After photos are extracted and clustered, the user reviews each cluster as a potential outing:

- [x] **Reverse geocoding**: Call Nominatim API with cluster center coordinates to detect location name (priority: parks/reserves -> natural features -> neighborhoods -> cities)
- [x] **Location display**: Show detected location name with GPS coordinates, or "Unknown Location" if no GPS
- [x] **Date/time display**: Show cluster start time extracted from EXIF, formatted with timezone
- [x] **Manual date/time override**: User can tap date/time to edit via native `DatePicker`
- [x] **Place search**: Nominatim autocomplete - user can search for any location name, select from suggestions to override coordinates and location name
- [x] **State/country extraction**: Automatically extract ISO 3166-2 state/province code and country code from geocoding result (stored on the outing for eBird compatibility)
- [x] **Existing outing matching**: Check if cluster overlaps an existing outing (time +/-2 hours, distance <=3 km; relaxed to 50 km if times nearly match <=30 min). If match found, show "Add to existing outing?" toggle. If adding to existing, expand outing's time range and fill missing fields
- [x] **Per-cluster navigation**: If multiple clusters, navigate between them (e.g., "Outing 1 of 3" with next/prev)

**New file**: `OutingReviewView.swift` in `AddPhotosFlow/`
**Updates**: `AddPhotosViewModel.swift` - new step in flow state machine, Nominatim API calls, `findMatchingOuting` logic
**Reference**: `src/components/flows/OutingReview.tsx`, `src/lib/clustering.ts` (`findMatchingOuting`, `clusterPhotosIntoOutings`)

### 3-R.2: Two-Tier AI Identification

iOS currently sends one `model: "fast"` request per photo. The web uses a fast-then-strong escalation strategy.

- [x] **Fast model first**: Send each photo to `POST /api/identify-bird` with `model: "fast"` (~1.2s timeout)
- [x] **Escalation logic**: If confidence of top candidate < 0.75, OR gap between top-2 candidates < 0.15, re-send the same photo with `model: "strong"` (~4.4s timeout)
- [x] **User feedback**: Show status messages during processing - "Identifying species..." for fast model, "Re-analyzing with enhanced model..." when escalating to strong
- [x] **Progress**: Show "Photo X of N" counter with progress bar (exponential animation to ~90% before completion)

**Updates**: `AddPhotosViewModel.swift` - `identifySpecies` method needs escalation logic
**Reference**: `src/lib/ai-inference.ts` (`identifyBirdInPhoto` function with fast/strong model switching)

### 3-R.3: Per-Photo Confirmation UI

iOS currently batch-confirms all photos. The web does per-photo confirmation with a rich comparison UI.

Replace the current batch `ReviewView` with a sequential per-photo confirmation flow:

- [x] **Side-by-side comparison**: Display the user's photo next to a Wikipedia reference image of the identified species (fetched via Wikimedia Summary API). This lets users visually verify the AI's suggestion
- [x] **Color-coded confidence bar**: Horizontal progress bar showing AI confidence percentage. Green (>=80%), yellow (50-79%), red (<50%)
- [x] **High confidence (>=80%)**: Auto-select the top candidate. Show "Confirm" (primary) and "Possible" (secondary) buttons. User can tap "Confirm" to mark as confirmed, or "Possible" if uncertain
- [x] **Low confidence (<80%)**: Show all candidates as a tappable list. No auto-selection. User must choose a candidate or skip
- [x] **"Back" button**: Navigate to the previous photo's decision to revise it (undo previous confirmation and re-show that photo)
- [x] **"Crop & Retry" button**: Opens `CropView` for manual cropping, then re-submits the cropped image to the AI. Use AI-suggested `cropBox` as the initial crop position when available
- [x] **"Skip" button**: Reject this photo entirely (certainty = "rejected", excluded from final save)
- [x] **Alternative candidates**: List of all AI candidates with confidence percentages. Tap any candidate to select it instead of the top suggestion
- [ ] **Count field**: Allow user to adjust observation count (default 1) if multiple individuals of same species visible

**New file**: `PerPhotoConfirmView.swift` in `AddPhotosFlow/`
**Updates**: `AddPhotosViewModel.swift` - per-photo state machine, back navigation, crop-retry loop
**Reference**: `src/components/flows/AddPhotosFlow.tsx` (`PerPhotoConfirm` component)

### 3-R.4: Crop & Retry Integration

`CropView` and `CropService` exist but are disconnected from the AI retry pipeline.

Wire the existing crop UI into the identification retry flow:

- [x] **Auto-prompt on multi-bird**: When AI returns `multipleBirds: true`, automatically open `CropView` and prompt: "Multiple birds detected - crop to one bird"
- [x] **Auto-prompt on no detection**: When AI returns 0 candidates from the full image, automatically open `CropView` and prompt: "No bird detected - try cropping to the bird"
- [x] **Manual crop from confirm UI**: "Crop & Retry" button in `PerPhotoConfirmView` opens `CropView` at any time
- [x] **AI cropBox as initial position**: When the AI response includes a `cropBox` (percentage coordinates), use it as the initial crop rectangle position with padding (0.65x ratio, matching web's `paddedSquareCrop`)
- [x] **Re-identification after crop**: After user confirms crop, generate a new compressed JPEG from the cropped region and re-submit to `POST /api/identify-bird`. Do NOT re-prompt for crop after a user-initiated crop (prevent infinite loop)

**Updates**: Wire `CropView.swift` and `CropService.swift` into the `PerPhotoConfirmView` flow
**Reference**: `src/components/flows/ImageCropDialog.tsx`

### 3-R.5: Certainty Level Support

iOS currently marks ALL confirmed photos as `certainty: "confirmed"`.

- [x] **"Confirm" button**: Sets observation `certainty` to `"confirmed"` - species is added to WingDex
- [x] **"Possible" button**: Sets observation `certainty` to `"possible"` - species is recorded but NOT added to WingDex (matches web behavior where only confirmed species appear in the dex)
- [x] **"Skip" button**: Sets `certainty` to `"rejected"` or excludes the photo entirely from the final save
- [x] **Auto-selection rule**: Only auto-select the top candidate when confidence >= 0.80 - but the user must still tap "Confirm" or "Possible" to proceed (no silent auto-confirmation)

**Updates**: `AddPhotosViewModel.swift`, `PerPhotoConfirmView.swift`

### 3-R.6: GPS Context Toggle

The web has a "Use GPS & date for better ID" toggle that controls whether location context is sent to the AI.

- [x] **Toggle location**: Add a toggle to the photo selection step or the outing review step
- [x] **When enabled**: Send `lat`, `lon`, `month`, and `locationName` fields in the `POST /api/identify-bird` request body alongside the image
- [x] **When disabled**: Send only the `imageDataUrl`, `imageWidth`, `imageHeight` fields (no location context)
- [x] **Default**: Enabled (GPS context improves accuracy significantly)

**Updates**: `PhotoSelectionView.swift` or `AddPhotosViewModel.swift`

### 3-R.7: Duplicate Photo Detection UI

SHA-256 file hash computation exists in `PhotoService`, but there is no UI to handle detected duplicates.

- [x] **Hash comparison**: After extracting EXIF and computing file hashes, compare each hash against existing photos in `DataStore.photos`
- [x] **Duplicate found**: Show a confirmation dialog: "This photo was previously uploaded. Reimport or skip?"
- [x] **"Reimport"**: Process the photo normally (creates new observation)
- [x] **"Skip"**: Exclude the photo from the current batch
- [x] **Batch handling**: If multiple duplicates found, show them together or one-by-one with a "Skip All Duplicates" option

**Updates**: `AddPhotosViewModel.swift`, `DataStore.swift` (lookup by file hash)

### Phase 3-R Bug Bash

- [x] When the progress bar happens, use the full image aspect-fit instead of a square crop of the user photo
- [x] The liquid glass buttons use default system color, not accent tint - removed global `.tint(Color.accentColor)` from WindowGroup
- [x] Immediately start the wizard after photo selection - removed "Continue" button, processing starts on `.onChange(of: selectedItems)`
- [x] Candidate list rows use bigger text (`.body` instead of `.subheadline`), more spacing, and full-row tap target via `.contentShape(Rectangle())`
- [x] The upload tab is now a real tab destination, not a sheet - uses `showHome()` environment action instead of `dismiss()`
- [x] Brief "Outing saved!" notice with checkmark shown for ~1.2s between clusters before advancing
- [ ] After doing real tab, can we have a cool tab expansion animation like Apple Music's search tab where the icon expands to fill the screen as the new view appears? And instead of the search it would morph into two liquid glass big buttons (take photo and library) at the bottom where in apple music the search bar appears

### 3-R Verification

Select 5+ photos from library -> see outing review with reverse-geocoded location and date -> AI identifies one-at-a-time with fast model, escalates to strong when uncertain -> per-photo confirm shows user photo alongside Wikipedia reference image with confidence bar -> can tap Back to revisit previous photo -> crop & retry auto-prompts on multi-bird and works manually -> certainty selection (Confirm/Possible/Skip) -> GPS toggle works -> duplicates detected -> save creates correct outings with state/country codes and proper certainty values.

---

## Phase 4 - Settings & Profile Parity ✅

Settings is now accessed via the avatar button in the navigation bar (not a tab) per Phase 3.5. Content is presented in a card-style sheet (Apple Music-style). All features below match the web's SettingsPage.

### 4.1: Display Name Editing ✅

iOS shows the name read-only. The web has an inline pencil edit button.

- [x] **Pencil icon**: Show a pencil (SF Symbol `pencil`) button next to the "Welcome, {name}" text
- [x] **Edit flow**: Tap pencil -> present an alert with a `TextField` pre-filled with the current name (or use inline editing with Save/Cancel buttons)
- [x] **Save**: Call the profile update API with the new name. Immediately refresh the UI including the avatar button in the nav bar
- [x] **Validation**: Trim whitespace, reject empty names

**Files**: `SettingsView.swift`
**Reference**: `SettingsPage.tsx` (name editing section with `window.prompt()`)

### 4.2: Random Bird Nickname Generator ✅

Does not exist on iOS. The web has a circular arrows button that generates a bird-themed display name + emoji avatar.

- [x] **Button**: Circular arrows icon (SF Symbol `arrow.clockwise`) next to the name
- [x] **Logic**: Port `generateBirdName()` from `src/lib/fun-names.ts` - combines bird adjectives + species names (e.g., "Cheerful Kingfisher") and picks a random emoji avatar from the 8-emoji set
- [x] **Auto-save**: Immediately saves the generated name + emoji avatar to the profile API
- [x] **New file**: `FunNames.swift` utility with the bird name/adjective arrays and generation logic

**Files**: `SettingsView.swift`, new `FunNames.swift`
**Reference**: `src/lib/fun-names.ts` (`generateBirdName`, `BIRD_ADJECTIVES`, `BIRD_NOUNS`, `BIRD_EMOJIS`)

### 4.3: Avatar Emoji Selection ✅

Does not exist on iOS. The web has a row of 8 emoji buttons.

- [x] **Emoji grid**: Row of 8 circular buttons: 🐦 🦉 🦜 🐧 🦆 🦩 🦅 🐤
- [x] **Selected state**: Currently selected emoji gets a highlighted ring (accent color border + background)
- [x] **Tap selected emoji**: Restore the original social provider avatar (or clear to default)
- [x] **Tap unselected emoji**: Apply that emoji as the avatar + auto-save to profile API
- [x] **Avatar format**: Store as emoji data-URL to match web format (the web encodes emojis as small canvas-rendered data URLs)
- [x] **Background color**: AvatarView already renders emoji avatars with per-emoji background colors
- [x] **Disabled during save**: All buttons disabled while profile save is in flight

**Files**: `SettingsView.swift`, `FunNames.swift`
**Reference**: `SettingsPage.tsx` (avatar section)

### 4.5: eBird CSV Import with Timezone Picker ✅

Stub exists (button present, marked TODO). Needs full implementation matching the web's import flow.

- [x] **Import button**: Opens a sheet with the timezone selection + file picker flow
- [x] **Timezone dropdown**: Picker with 15 preset timezones + "None (times already local)" option. Each timezone shows its current DST-aware UTC offset (e.g., "UTC-10:00 - Hawaii", "UTC-05:00 - Eastern"). The timezone list matches the web's `TIMEZONE_PRESETS` array exactly
- [x] **Help section**: Collapsible "How to export from eBird" with 3-step instructions via DisclosureGroup
- [x] **File picker**: `.fileImporter` with `.csv` UTType. On file selection, read the CSV data
- [x] **Preview API**: Call `POST /api/import/ebird-csv` with the CSV content and selected timezone. Server returns preview with conflict detection (new / duplicate / update_dates)
- [x] **Conflict display**: Show duplicates from existing data. Auto-select non-duplicate previews
- [x] **Confirm import**: Call `POST /api/import/ebird-csv/confirm` with selected preview IDs
- [ ] **Success feedback**: Toast with counts ("Imported eBird data across N outings") + confetti animation if new species were added (confetti deferred to Phase 7)

**Files**: `SettingsView.swift`, new `EBirdImportView.swift` sheet, `DataService.swift` (import API calls)
**Reference**: `SettingsPage.tsx` (import section), `functions/api/import/`

### 4.6: Export Sightings CSV ✅

Stub exists (button present, marked TODO). Needs implementation.

- [x] **Export button**: Disabled if `dex.length == 0`. Tap triggers `GET /api/export/sightings`
- [x] **Save**: Present `UIActivityViewController` (share sheet) with the downloaded CSV data
- [x] **Filename**: `wingdex-sightings-YYYY-MM-DD.csv`
- [x] **Feedback**: Share sheet presented on success

**Files**: `SettingsView.swift`, `DataService.swift` (export API call)

### 4.7: Data Privacy Card ✅

Does not exist on iOS.

- [x] **Static informational section** matching the web's "Data Storage & Privacy" section with photos, records, and third-party disclosures
- [x] **Links**: Tappable links to Privacy Policy and Terms of Use via native Link views

**Files**: `SettingsView.swift`

### 4.8: Delete Account & All Data (Two-Stage Confirmation) ✅

iOS only has "Delete All Data" (single confirmation). The web has a separate "Delete Account & All Data" with a two-stage confirmation flow.

- [x] **Placement**: Single "Delete Data..." NavigationLink in settings opens DataManagementView with both options
- [x] **First confirmation**: Alert titled "Delete your entire account?" listing what gets deleted
- [x] **Second confirmation**: Alert titled "Are you absolutely sure?" with destructive button "Delete my account forever"
- [x] **Execution**: Calls Better Auth's delete-user endpoint, clears all local state, signs out
- [x] **Feedback**: Auto-signs out and returns to sign-in screen

**Files**: `SettingsView.swift`, new `DataManagementView.swift`, `AuthService.swift`

### 4.9: Remove "Saved Locations" Stub ✅

iOS has a placeholder "No saved locations" section that references a feature the web app removed.

- [x] Delete the "Saved Locations" section from `SettingsView.swift` entirely

**Files**: `SettingsView.swift`

### Phase 4 Verification

Edit name (pencil), generate nickname (arrows), pick emoji avatar (8 grid) -> import eBird CSV with timezone picker works end-to-end with conflict display -> export sightings CSV via share sheet -> privacy card shows correct disclosures -> delete account requires 2 confirmations then signs out -> no "Saved Locations" section.

---

## Phase 5 - Outing Detail Editing Parity

The iOS `OutingDetailView` is read-only except for notes editing and outing deletion. The web supports full editing. Five capabilities are missing.

### 5.1: Edit Location Name

iOS shows the location name as a static title. The web has a pencil icon that opens an autocomplete input.

- [x] **Pencil icon**: SF Symbol `pencil` in the header area next to the location name
- [x] **Edit mode**: Tap pencil -> replace the title with a `TextField` pre-filled with the current name. Show Save and Cancel buttons
- [x] **Autocomplete**: As the user types, show suggestions filtered from all existing outing location names (client-side filter from `DataStore.outings`)
- [x] **Save**: Call `PATCH /api/data/outings/{id}` with the new `locationName`. Update local state immediately
- [x] **Empty name**: Resets to the default geocoded location name (or "Unknown Location")

**Files**: `OutingDetailView.swift`
**Reference**: `OutingsPage.tsx` (edit location name section)

### 5.2: Delete Individual Species/Observation

iOS can only delete entire outings. The web has per-species delete with confirmation.

- [x] **Delete trigger**: Trailing swipe action on each species row with a destructive trash action; removal happens immediately and rolls back if the request fails
- [ ] **Undo (deferred)**: Evaluate native Shake to Undo as a separate change with serialized server mutations and account-safe retry handling
- [x] **Execution**: Call `PATCH /api/data/observations` to mark the observation as `certainty: "rejected"` (soft delete matching web behavior)
- [x] **UI update**: Remove the species from the visible list immediately

**Files**: `OutingDetailView.swift`
**Reference**: `OutingsPage.tsx` (delete observation section)

### 5.3: Add Species Manually

Does not exist on iOS. The web has an "+ Add Species" button with taxonomy autocomplete.

- [x] **"+ Add Species" button**: Toggle button in the species list section header. When active, shows an inline form; when inactive, shows the button label
- [x] **Species name input**: Text field with autocomplete dropdown powered by server-side taxonomy search (`GET /api/species/search?q=...&limit=8`). Debounce input by 150ms before sending search request
- [x] **Add action**: Tap "Add" creates a new observation with `count: 1`, `certainty: "confirmed"`, linked to this outing
- [x] **Feedback**: Clear input and close the form after the species appears in the list; failures use a native alert
- [x] **Keyboard navigation**: Autocomplete results navigable with tap (no hardware keyboard expected on iOS, but support standard list selection)

**Files**: `OutingDetailView.swift`, `DataService.swift` (species search API call)
**Reference**: `OutingsPage.tsx` (add species section)

### 5.4: Export Individual Outing as eBird CSV

Does not exist on iOS. The web has an "Export eBird CSV" button per outing.

- [x] **Button**: "Export eBird CSV" with download icon, placed in the action buttons area at the bottom of the detail view
- [x] **Disabled state**: Greyed out if the outing has no confirmed observations
- [x] **Execution**: Fetch `GET /api/export/outing/{id}`, receive CSV data
- [x] **Save**: Present `UIActivityViewController` (share sheet) with the CSV file
- [x] **Feedback**: Present the native share sheet after export; failures use a native alert

**Files**: `OutingDetailView.swift`, `DataService.swift`

### 5.5: Tappable Map Link

iOS shows an embedded MapKit view that opens the outing location in Apple Maps.

- [x] **Tappable map**: Tap the embedded map to open the outing location externally
- [x] **Tap action**: Open in Apple Maps via `MKMapItem.openMaps()` with the outing coordinates

**Files**: `OutingDetailView.swift`

### Phase 5 Verification

Tap outing -> edit location name with autocomplete from past outings -> add species via taxonomy search -> delete species (swipe, confirmation, soft delete) -> export outing eBird CSV via share sheet -> tap coordinates opens Apple Maps.

---

## Phase 6 - Species Detail & WingDex Parity

Five gaps between the iOS and web species/WingDex views.

### 6.2: Certainty Badges in Sightings List

iOS shows sightings without any certainty indicator. The web shows "confirmed" or "possible" badges.

- [x] **Certainty metadata**: Show "Confirmed" or "Possible" in each sighting row
- [x] **Styling**: "Possible" uses the system warning color; confirmed uses existing muted metadata styling

**Files**: `SpeciesDetailView.swift`

### 6.3: Observation Count in Sightings

iOS doesn't show the count per sighting. The web shows `xN` when count > 1.

- [x] **Count display**: Show `x{count}` in each sighting row when the observation count is greater than 1

**Files**: `SpeciesDetailView.swift`

### 6.4: Species Notes Display

iOS doesn't display notes for species. The web shows a "Notes" section at the bottom of the species detail view.

- [x] **Notes section**: If `dexEntry.notes` is non-empty, show a "Notes" section heading with the notes text below in italic
- [x] **Read-only**: Notes are displayed but not editable from the species detail view (they can be edited on the web)

**Files**: `SpeciesDetailView.swift`

### 6.5: WingDex Family Sort

iOS has 3 sort options (date, count, name). The web has a 4th: Family (taxonomic).

- [x] **New sort option**: Add "Family" sort (leaf icon, SF Symbol `leaf`) to the sort menu in `WingDexView`
- [x] **Taxonomy order data**: Reuse the bundled `taxonomy.json` array index as taxonomic sequence, matching `src/lib/taxonomy-order.ts`
- [x] **Sort behavior**: Sort species by taxonomic sequence. Default direction: ascending; unknown species sort by name at the end

**Files**: `WingDexView.swift`
**Reference**: `WingDexPage.tsx` (family sort), `src/lib/taxonomy-order.ts`

### Phase 6 Verification

Species detail eBird link opens correct species page (API-verified code) -> sightings show "confirmed"/"possible" badges + count when > 1 -> notes section visible when present -> WingDex Family sort groups species by taxonomic family.

---

## Phase 7 - Celebrations & Feedback

The web shows confetti + lifer toasts when new species are added. iOS has none of this.

### 7.1: Confetti Animation

- [x] **Trigger**: Fire confetti animation when `newSpeciesCount > 0` after AddPhotos save, or after eBird import adds new species
- [x] **Implementation**: Native SwiftUI Canvas + TimelineView confetti burst, ~1.4s, closed-form projectile motion
- [x] **Reduce Motion**: When `accessibilityReduceMotion` is on, skip confetti and fade the banner in (opacity-only transition)

**Files**: New `CelebrationOverlay.swift` (`LiferCelebration` + `.celebration()` modifier), applied in `AddPhotosFlow` (done screen) and `SettingsView` (after eBird import)

### 7.2: Lifer Toast

- [x] **Message**: Banner lists the new species names ("+N more" past three), falling back to a count ("N new species added to your WingDex")
- [x] **Implementation**: SwiftUI banner overlay via the `.celebration()` modifier, auto-dismisses after ~3 seconds
- [x] **Haptic**: Paired with `.sensoryFeedback(.success)` on trigger
- [x] **Accessibility**: Posts a VoiceOver announcement with the banner message

**Files**: `CelebrationOverlay.swift` (reusable `.celebration()` view modifier)

### 7.3: Haptic Feedback

- [x] **Success haptic** (`.sensoryFeedback(.success)`): Fires on the new-species celebration (AddPhotos save, eBird import)
- [x] **Selection haptic**: On WingDex sort field/direction changes

**Files**: `CelebrationOverlay.swift`, `WingDexView.swift`

### Phase 7 Verification

Add photos with a new species -> confetti animation fires + lifer toast with haptic -> import eBird CSV with new species -> confetti fires -> no confetti when Reduce Motion is on.

---

## Phase 8 - Appearance & Session Hardening

### 8.1: System Appearance Foundations

WingDex follows the iOS system appearance. A separate appearance toggle is intentionally out of scope.

- [x] **Adaptive palette**: All WingDex named color assets include light and dark variants
- [x] **System mode**: No `preferredColorScheme`, `UIUserInterfaceStyle`, or window-scene override forces an appearance
- [x] **Semantic color audit**: Custom UI uses adaptive/semantic colors; intentional black/white values are limited to controlled image overlays

**Files**: `Theme.swift`, `Assets.xcassets` color sets, representative views

### 8.2: Light & Dark Visual Audit

- [x] **Map thumbnails**: `MiniMapSnapshot` renders with the active appearance and refreshes when the system scheme changes
- [x] **Attribution contrast**: Wikipedia attribution uses the readable adaptive muted color without compounded opacity
- [x] **Representative flows**: Existing previews and simulator flows were audited in both appearances, including Sign In, Home, WingDex, Outings, Settings, detail views, Add Photos, and celebration
- [x] **UIKit surfaces**: List cells, menus, alerts, pickers, sheets, and global tint adapt correctly
- [x] **Image and card legibility**: Image overlays, Sign In foreground content, and Outing Detail card hierarchy remain legible

**Files**: `SharedComponents.swift`, `SpeciesDetailView.swift`, representative view previews

### 8.3: Bearer Authentication Baseline

The API now uses Better Auth's bearer plugin. The older middleware dual-cookie workaround is no longer the API authentication path; signed cookies remain only for passkey endpoints.

- [x] **Bearer API calls**: `DataService` attaches the raw session token via `Authorization: Bearer`
- [x] **Passkey isolation**: Signed cookie handling remains separate and passkey-cookie failures do not blindly invalidate bearer auth
- [x] **Mobile callback compatibility**: Callback extraction accepts secure and non-secure Better Auth cookie names

### 8.4: Token-Aware 401 Handling

- [x] **Intercept**: Protected API 401 responses invalidate the rejected bearer session
- [x] **Race safety**: A delayed 401 from an old token cannot sign out a replacement session
- [x] **Account isolation**: Clear account-owned in-memory data on logout/session rejection and ignore stale in-flight bulk loads
- [x] **Stale mutation guard**: Delayed profile updates cannot mutate a replacement session
- [x] **Re-authentication UX**: Return to Sign In with a one-time session-expired message; explicit logout stays silent
- [x] **No automatic mutation replay**: Do not retry arbitrary requests after sign-in until idempotency and retry policy are designed

**Files**: `AuthService.swift`, `DataService.swift`, `DataStore.swift`, `WingDexApp.swift`, `SignInView.swift`, `SettingsView.swift`

### 8.5: Session Expiry Handling

- [x] **Startup validation**: Treat Better Auth `200 null`, HTTP 401, and malformed successful session payloads as rejected sessions
- [x] **Outage tolerance**: Preserve cached auth on transport failures and server 5xx responses
- [x] **Foreground validation**: Silently validate the active session when the app returns to the foreground
- [x] **Local expiry**: Expired cached tokens use the same session-expired path
- [ ] **End-to-end verification**: Exercise startup rejection, foreground rejection, explicit logout, and account-data clearing in the simulator

**Files**: `AuthService.swift`, `WingDexApp.swift`, session tests

### 8.7: Error Handling Overhaul (iOS)

Errors are mapped at presentation boundaries while transport/domain errors retain status, retry, and cancellation context. Persistent failures use native empty states, and action failures use native alerts or existing inline form feedback.

- [x] **Typed error mapping**: `AppError` maps connectivity, timeout, auth, passkey, safe API status, decoding, and cancellation cases without flattening domain errors prematurely
- [x] **Native user feedback**: Action failures use SwiftUI alerts; forms/import/passkeys retain inline feedback; failed initial loads use `ContentUnavailableView` with Retry
- [x] **Network error handling**: Offline, timeout, server, invalid-response, and cancellation cases have safe distinct behavior; cached data remains visible on refresh failure
- [x] **Rate limit feedback**: Bird identification 429 responses retain `Retry-After` and show the configured request limit from `Config.aiDailyRateLimit`; unrelated 429 responses use generic retry copy
- [x] **Passkey error messages**: Cancellation is silent, unavailable/not-handled uses neutral production copy, and failed authorization is actionable
- [x] **Pull-to-refresh retry**: Home, WingDex, and Outings preserve refresh gestures, show failure state, and expose explicit Retry when the initial load has no data
- [x] **Workflow recovery**: Add Photos stops on metadata failure, preserves state across identify/save retries, distinguishes failures from no-candidate results, and uses stable idempotent photo/observation IDs
- [x] **Native presentation decision**: Use system alerts and `ContentUnavailableView` rather than a global or hand-rolled toast/banner framework

**Files**: New `AppError.swift`, update `SignInView.swift`, `DataStore.swift`, `SettingsView.swift`, all views with error states

### 8.8: Logging Overhaul (iOS + Server)

Part of [#222](https://github.com/jlian/wingdex/issues/222). Ensure consistent, structured logging across all layers.

- [x] **iOS Logger audit**: Services use categorized `Logger` calls; expected 4xx responses are warnings, 5xx/transport failures are errors, and routine request timing is debug-level
- [x] **iOS request/response timing**: `DataService` logs elapsed time and response size for API calls
- [x] **Server structured format**: Request-scoped structured logging and trace propagation are defined in `OBSERVABILITY.md` and implemented by the shared logger/responder
- [x] **Web client debug logger**: `debugLog()` is gated on `import.meta.env.DEV`
- [x] **No credentials or user content in logs**: OAuth callback URLs, tokens/cookies, response bodies, filenames, locations, species arrays, passkey IDs, provider/database exception text, and user-authored content are excluded; `OBSERVABILITY.md` defines the safe metadata allowlist
- [x] **End-to-end trace propagation**: iOS data/auth/passkey requests and first-party web fetches emit W3C `traceparent`; iOS logs safe duration/status/byte metadata and middleware rejection/completion logs include duration
- [x] **Route compliance**: Species lookup handlers use the shared route responder and no longer rely on observability-test exemptions

**Files**: All service files (iOS), all `functions/api/*.ts` files (server), new web debug utility

### Phase 8 Verification

Switch the iOS system between Light and Dark -> representative screens and native error UI render correctly -> valid bearer API calls succeed -> rejected startup/foreground sessions return to Sign In gracefully -> old-token 401 cannot clear a replacement session -> logout clears account data -> no prior account data appears during a later sign-in -> offline/timeout/500/429 failures show safe actionable feedback and preserve retry state -> structured logs contain trace/timing metadata without credentials or user content.

---

## Phase 9 - iOS-Native Enhancements

Phase 9 contains the native platform work required for the iPhone 1.0 launch. Sharing, shortcuts, context actions, camera capture, and the server-authoritative SwiftData read cache are implemented.

### 9.1 Sharing and Export

#### 9.1.1 Share Extension

- [x] Accept single or multiple images from other apps
- [x] Stage each share as an atomic App Group batch and import pending batches in FIFO order
- [x] Accept each batch at most once before cleaning up its temporary files
- [x] Preserve ordering, EXIF, and GPS while keeping authentication and identification in the main app
- [x] Keep a normal extension completion and manual-open fallback when automatic app opening is unavailable

#### 9.1.2 System Sharing and Export

- [x] Share species and outing summaries through the system share sheet
- [x] Export sightings and outings as CSV files
- [x] Share or save species images with original image bytes preserved through PhotoKit
- [x] Clean temporary share/export files after the activity completes

### 9.2 Home Screen Actions

- [x] "Take Photo" opens the camera directly
- [x] "Upload Photos" opens the system photo library directly
- [x] "View WingDex" opens the WingDex tab
- [x] Register all three as static `UIApplicationShortcutItem` entries

### 9.3 Context Menus and Swipe Actions

#### 9.3.1 Context Menus

- [x] Species: view details, share, open in eBird, open in Wikipedia
- [x] Outing: edit location, export eBird CSV, delete, share summary
- [x] Species hero image: share image, save to Photos
- [x] AddPhotos photo: remove photo
- [x] Mirror custom UIKit context-menu commands with accessibility actions

#### 9.3.2 Swipe Actions

- [x] Outing: leading export and trailing delete with confirmation
- [x] Outing species: trailing remove
- [x] Passkey: trailing delete

### 9.4 App Intents, Shortcuts, and Siri

#### 9.4.1 App Intents

- [x] `UploadPhotosIntent`
- [x] `TakePhotoIntent`
- [x] `ViewWingDexIntent`
- [x] `ViewOutingsIntent`
- [x] `GetSpeciesCountIntent`
- [x] `GetRecentSpeciesIntent`
- [x] `GetLastSpeciesIntent`
- [x] `ExportSightingsIntent`
- [x] Use `AppShortcutsProvider` and iOS 26 foreground intent modes

#### 9.4.2 Siri and Action Button

- [x] Register natural-language App Shortcut phrases for navigation, photo entry, counts, recent species, and export
- [x] Expose Upload Photos and Take Photo for assignment through the system Shortcut Action button option

### 9.5 Camera Capture

- [x] Offer Take Photo beside Choose from Library
- [x] Use `UIImagePickerController` with `.camera` only when the source is available
- [x] Request current when-in-use location while camera capture is active
- [x] Attach best-effort capture location and timestamp to the processed photo
- [x] Feed captures into the existing extraction, duplicate detection, clustering, and identification pipeline

### 9.6 Local Data Cache

Spotlight is not a dependency. This is a server-authoritative read cache for launch speed and offline browsing, not an offline mutation system.

- [x] Cache outings, observations, dex entries, and the photo metadata/thumbnails needed for offline browsing with SwiftData; do not persist every full-resolution image by default
- [x] Partition cached data by account ID and never display one account's cache for another account
- [x] Render the current account's cache immediately, then reconcile it with a successful server response
- [x] Replace the cache atomically after successful full refreshes and relevant mutations
- [x] Clear in-memory and persisted account data on sign-out, account deletion, delete-all-data, and rejected-session transitions
- [x] Define the initial schema and migration strategy before shipping the first persistent store
- [x] Treat stale cached data as read-only and visibly report refresh failures without presenting the cache as current
- [x] Test cold launch, offline launch, first launch without cache, corrupt-store recovery, schema migration, logout cleanup, and cross-account isolation

### 9.7 Verification

- [x] Phase 9 foundation tests cover App Intents metadata, routing, exports, and incoming-share queue behavior
- [x] Home Screen quick actions register and route to their expected destinations
- [x] Upload Photos presents the system photo library directly in Simulator
- [x] Share Extension import preserves shared image bytes and metadata
- [x] Context menus, system sharing, destructive confirmations, and swipe actions render in Simulator
- [x] Shortcuts discovers all eight WingDex actions
- [x] Raw View Outings shortcut opens the Outings tab
- [x] Simulator reports camera unavailability without constructing a camera picker
- [x] SwiftData cache unit/integration tests pass
- [x] Simulator: cached launch and offline browsing
- [x] Physical iPhone: camera and location allow/deny paths, capture metadata, and identification
- [x] Physical iPhone: Siri phrases, Action button assignment, Photos save permission, and Share Extension handoff

---

## Phase 10 - Polish & App Store

### 10.1: TestFlight

- [x] Internal testing build
- [x] Fix any remaining signing/provisioning issues (register physical test devices or use App Store Connect automatic distribution)
- [x] First round of real-device testing on various iPhone sizes

### 10.2: App Icon & Launch Screen

- [x] **App icon**: Finalize app icon
- [x] **Launch screen**: Branded launch screen that looks good

### 10.3: Accessibility Final Pass

- [ ] Accessibility Inspector audit has no actionable errors on representative screens
- [ ] VoiceOver completes authentication, AddPhotos, navigation, menus, sheets, errors, and destructive confirmations on a physical iPhone
- [ ] Custom context-menu accessibility actions match their visible commands
- [ ] Dynamic Type works from xSmall through AX5 without overlap, blocked actions, or harmful truncation
- [ ] Large Content Viewer supports key metrics such as species count and outing stats
- [ ] Reduce Motion removes or simplifies all custom motion, including celebrations and parallax/spring effects
- [ ] Color contrast meets WCAG AA and status never relies on color alone
- [ ] Audit for error message copy and accessibility

### 10.4: Production Readiness

- [ ] Audit observability stack end-to-end to ensure logs and traces are properly queryable
- [ ] Alerts
- [ ] Metrics and KPI dashboards
- [ ] (Stretch) Use on-device MobileCLIP model for bird ID
- [ ] Secrets rotation and store robustness

### 10.5: App Store Listing

- [ ] **Screenshots**: Capture on multiple device sizes (iPhone 15 Pro Max, iPhone SE)
- [ ] **Description**: Concise pitch highlighting photo-first bird ID, AI identification, eBird compatibility
- [ ] **Keywords**: birding, bird identification, life list, WingDex, eBird, bird photos
- [ ] **Category**: Reference or Lifestyle
- [ ] **Privacy nutrition labels**: Match the web privacy policy disclosures (no data sold, photos not retained, etc.)

### 10.6: App Store Submission

- [ ] Review Apple's App Store Review Guidelines for compliance
- [ ] Ensure demo account or demo data available for reviewer or prepare for easy passkey sign-up with reviewer note
- [ ] Submit for review

---

## Phase 11 - Post-1.0 Native Enhancements

Phase 11 begins after the iPhone 1.0 App Store launch. Each numbered area should move to a focused repository issue before implementation. Recheck current Apple documentation and installed SDK interfaces when work starts.

### 11.1 Offline Mutation Queue

- [ ] Define idempotency keys, ordering, retries, conflict policy, and account-switch behavior before implementation
- [ ] Persist queued mutations and replay them when connectivity returns
- [ ] Show visible pending and failed states without presenting queued changes as server-confirmed
- [ ] Add server versioning or precondition support where last-write-wins would lose user data

### 11.2 Widgets and Control Center

- [ ] Species count widget
- [ ] Recent species widget with individual species routing
- [ ] Recent outing widget
- [ ] Lock Screen accessory widgets
- [ ] Upload Photos Control Center control
- [ ] Design App Group data sharing and timeline reloads together with the Phase 9 SwiftData read cache

### 11.3 Spotlight, Suggestions, and Handoff

- [ ] Index species and outings with `CSSearchableItem`
- [ ] Route Spotlight results to species or outing detail
- [ ] Donate viewed-species and viewed-outing `NSUserActivity` instances for system suggestions
- [ ] Add Handoff only when WingDex ships another compatible Apple-platform app

### 11.4 Notifications and Background Refresh

#### 11.4.1 Local Notifications

Spotlight and Background App Refresh are not dependencies. Notifications are derived from the latest successful foreground sync/import and must not imply that WingDex fetched newer data while suspended.

- [ ] Add a Settings toggle, default off, and request notification authorization only after an explicit user action
- [ ] Define weekly summary eligibility from the latest known data and schedule or replace at most one pending summary
- [ ] Define meaningful species milestones and persist per-account delivery state to prevent duplicate notifications
- [ ] Recompute notification state after successful refreshes, imports, and AddPhotos saves
- [ ] Remove pending WingDex notifications when disabled, signed out, switched accounts, or account data is deleted
- [ ] Handle denied/provisional authorization without blocking app workflows or repeatedly prompting
- [ ] Test eligibility, deduplication, account isolation, scheduling replacement, disable/sign-out cleanup, and denied authorization

#### 11.4.2 Background App Refresh

- [ ] Add only when widgets or Spotlight provide a concrete need for opportunistic refresh beyond the Phase 9 cache
- [ ] Treat `BGAppRefreshTask` as opportunistic, never periodic or correctness-critical
- [ ] Register during launch, resubmit after each run, handle expiration, and persist useful results before completion
- [ ] Keep foreground refresh authoritative and never promise background freshness

### 11.5 Map Enhancements

- [ ] Full outings map with annotation clustering and date/species filters
- [ ] Species sighting map with location clusters and counts

### 11.6 Contextual Onboarding

- [ ] Use TipKit only after launch analytics identify concrete discovery problems
- [ ] Candidate tips: first upload, species details, WingDex sorting, crop guidance, and passkey setup

### 11.7 Visual Intelligence

- [ ] Reassess the current Visual Intelligence integration API and product fit after 1.0
- [ ] If supported, expose searchable WingDex species entities with image and sighting context

### 11.8 iPad and Multi-Window

- [ ] Adopt `NavigationSplitView` for an iPad two-column layout
- [ ] Add scene-based multi-window support for comparing species or outings

---

## Dependencies

| Package | Purpose |
| --- | --- |
| `swift-openapi-runtime` | Type-safe API response handling |
| `swift-openapi-urlsession` | URLSession transport for API client |
| `KeychainAccess` | Secure token storage |
| SwiftData (built-in) | Server-authoritative local read cache for launch speed and offline browsing |
| UserNotifications (built-in, Phase 11) | Opt-in local summaries and milestones |
| WidgetKit (built-in, Phase 11) | Home screen, Lock Screen, and Control Center widgets |
| AppIntents (built-in) | Siri, Shortcuts, Spotlight integration |
| TipKit (built-in, Phase 11) | Contextual onboarding tips |
| ActivityKit (built-in, future) | Live Activities if a concrete post-launch use case emerges |

No third-party UI libraries - pure SwiftUI + system frameworks.

---

## Key File References

### Web (source of truth for parity)

| File | Purpose |
| --- | --- |
| `src/components/flows/AddPhotosFlow.tsx` | Full add-photos wizard, `PerPhotoConfirm` component |
| `src/components/flows/OutingReview.tsx` | Outing review step: Nominatim, place search, existing outing matching |
| `src/components/flows/ImageCropDialog.tsx` | Interactive crop dialog UI |
| `src/components/pages/SettingsPage.tsx` | All settings features: name, avatar, appearance, import/export, delete |
| `src/components/pages/OutingsPage.tsx` | Outing detail editing: location name, add/delete species, export |
| `src/components/pages/WingDexPage.tsx` | Species detail, family sort, eBird code lookup |
| `src/components/pages/HomePage.tsx` | Home page layout, recent species cards, recent outings |
| `src/lib/ai-inference.ts` | Two-tier AI model escalation logic (fast -> strong) |
| `src/lib/clustering.ts` | Photo clustering + `findMatchingOuting` for existing outing detection |
| `src/lib/timezone.ts` | Offset-aware time handling, timezone conversion |
| `src/lib/fun-names.ts` | Bird nickname generator, emoji avatar system, `getEmojiAvatarColor` |
| `src/lib/taxonomy-order.ts` | Taxonomic family sort order |
| `src/lib/photo-utils.ts` | EXIF extraction, thumbnail generation, SHA-256 file hash |

### iOS (files to modify/create)

| File | Status | Changes needed |
| --- | --- | --- |
| `WingDexApp.swift` | Modify | Restructure: 3 tabs + detached "+" button + avatar toolbar button (Phase 3.5) |
| `SignInView.swift` | Rework | Match web auth modal: title, two passkey buttons, remove mode toggle (Phase 3.5) |
| `SettingsView.swift` | ✅ Done | All Phase 4 features: name, avatar, import/export, privacy, data management |
| `AddPhotosViewModel.swift` | ✅ Done | Two-tier AI, per-photo flow, outing review step, crop retry, certainty |
| `AddPhotosFlow/OutingReviewView.swift` | ✅ Done | Nominatim geocoding, place search, existing outing matching |
| `AddPhotosFlow/PerPhotoConfirmView.swift` | ✅ Done | Per-photo confirm with Wikipedia ref, confidence bar, crop retry |
| `AddPhotosFlow/ReviewView.swift` | ✅ Deleted | Replaced by PerPhotoConfirmView (per-photo flow) |
| `AddPhotosFlow/ConfirmView.swift` | ✅ Deleted | Done/summary screen moved into AddPhotosFlow |
| `OutingDetailView.swift` | Modify | Edit location, add species, delete species, export CSV, map link |
| `SpeciesDetailView.swift` | Modify | eBird API lookup, certainty badges, count, notes |
| `WingDexView.swift` | Modify | Family sort option |
| `Theme.swift` | Modify | Dark mode palette, appearance management |
| `AuthService.swift` | Modify | Fix 401, session expiry handling |
| `DataService.swift` | Modify | New API calls: species search, eBird code, import, export |
| `FunNames.swift` | ✅ Done | Bird nickname generator ported from web |
| `EBirdImportView.swift` | ✅ Done | eBird import sheet with timezone picker |
| `ConfettiModifier.swift` | New | Confetti animation modifier |
| Widget extension | Phase 11 | WidgetKit extension with species count, recent species, and outing widgets |
| App Intents | ✅ Done | `AppShortcutsProvider` and intent definitions |

---

## Phase Summary & Status

| Phase | Description | Status |
| --- | --- | --- |
| 0 | Project Scaffold | ✅ Done |
| 1 | Auth (OAuth, Passkeys, Keychain) | ✅ Done |
| 2 | Core Data Views (Home, WingDex, Outings, Details) | ✅ Done |
| 2.5 | Styling & Layout (colors, edge-to-edge, List theming) | ✅ Done |
| 2.6 | Auth UX, Tab Icon, Session Fixes | ✅ Done |
| 3 | Add Photos Flow (initial, needs rework) | ✅ Done (basic) |
| 3.5 | **Navigation & SignIn Rework** (3-tab + "+" layout, avatar settings sheet, SignInView matching web modal) | ✅ Done |
| 3-R | **Add Photos Flow Rework** (outing review, per-photo confirm, two-tier AI, crop retry, certainty) | ⏳ In Progress |
| 4 | **Settings & Profile Parity** (name, avatar, appearance, import/export, delete account) | ✅ Done |
| 5 | **Outing Detail Editing** (edit location, add/delete species, export, map link) | ✅ Done |
| 6 | **Species Detail & WingDex Parity** (eBird lookup, badges, count, notes, family sort) | ✅ Done |
| 7 | **Celebrations & Feedback** (confetti, lifer toast, haptics) | ✅ Done |
| 8 | **Appearance & Session Hardening** (system appearance audit, 401/session handling, native errors, observability) | ✅ Done |
| 9 | **iOS-Native Enhancements** (sharing, context menus, shortcuts, camera, local cache) | ⏳ In Progress - cache remains |
| 10 | **Polish & App Store** (errors, accessibility, icon, TestFlight, listing, submission) | Not started |
| 11 | **Post-1.0 Native Enhancements** (offline mutations, widgets, Spotlight, background refresh, maps, onboarding, Visual Intelligence, iPad) | Deferred until after 1.0 |
