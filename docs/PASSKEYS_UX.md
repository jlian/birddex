# Auth UX Spec

> Branch: `passkey-ux` · PR: #158

## Overview

WingDex uses a **demo-first** auth model. Visitors land in the app immediately
as anonymous users and can browse, load demo data, and explore the full UI
without signing up. When they attempt a write action (e.g. uploading photos),
an auth gate modal prompts them to create an account.

Authentication methods:
- **Passkeys**: primary, zero-password signup via WebAuthn
- **Social providers**: GitHub (active), Apple (credentials pending)
- **Anonymous sessions**: auto-created on first visit, promoted on signup

## Architecture

### Session bootstrap (App.tsx)

1. App mounts, `authClient.useSession()` checks for existing session
2. No session: auto-create anonymous session via `signIn.anonymous()`
3. Anonymous session renders full `AppContent` (no login wall)
4. Dev-only fallback: if anonymous bootstrap fails (no Wrangler), use
   synthetic `getFallbackUser()` so Vite-only mode still works

### Auth gate (use-auth-gate.tsx)

`useAuthGate()` hook returns:
- `requireAuth(callback)`: if anonymous, opens signup modal; if authenticated,
  runs callback immediately
- `openSignIn()`: opens modal in login mode (for header "Sign in" link)
- `authGateModal`: JSX element rendered once in the component tree

Gated actions: Add Photos, eBird CSV import.
Ungated: browsing, demo data, export, appearance settings.

### Auth gate modal

Reddit-style dual-mode dialog:

```
+----------------------------------+
| Sign up                          |
| By continuing you accept our     |
| Terms of Use and Privacy Policy. |
|                                  |
| [Continue with GitHub]           |
| [Continue with Apple]            |
|                                  |
| -- or --                         |
|                                  |
| [Sign up with a Passkey]         |
|                                  |
| Already have a WingDex? Log in   |
|                                  |
| +- Demo data ------------ [on] + |
| | Preview with sample sightings | |
| +-------------------------------+ |
+----------------------------------+
```

**Sign-up flow:**
1. User clicks "Sign up with a Passkey"
2. `addPasskey({ createSession: true })` runs the WebAuthn ceremony
3. Better Auth upgrades the anonymous user in place and returns the durable session

**Log-in flow:**
1. User clicks "Log in with a Passkey"
2. `signIn.passkey()` via WebAuthn get, OS shows existing passkeys
3. Session verified as non-anonymous before completing

**Social flow:**
1. User clicks "Continue with GitHub/Apple"
2. OAuth redirect, callback, session established

### Passkey keychain labels

The `name` parameter passed to `addPasskey()` becomes the keychain label in
iOS Settings > Passwords. An auto-generated bird name is used (e.g. "Scarlet
Tanager"). This is cosmetic and cannot be updated programmatically after
creation.

## Settings: Account management

### Account card (authenticated users only)

- Emoji avatar picker (8 options, stored as `user.image`)
- Editable nickname (`user.name`)
- Log out button

### Passkey card

- Lists all passkeys: name + creation date
- Delete button per passkey (disabled if only one remains)
- "Add passkey for this device" button
- Error handling for `ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED` and
  `ERROR_CEREMONY_ABORTED`

## Account linking

Config in `functions/lib/auth.ts`:
```ts
accountLinking: {
  enabled: true,
  trustedProviders: ['github', 'apple'],
  allowDifferentEmails: true,
}
```

Auto-merge applies **only to social-to-social** sign-ins. Passkey users never
have a real email on their account (`anon_xxx@localhost`), so auto-link can
never match them against a social provider's email. This makes the linking
config safe without requiring email verification.

| Scenario | Result |
|----------|--------|
| Social A (email X) then Social B (email X) | Auto-merge (both trusted) |
| Social (email X) then add passkey | Passkey added to same user |
| Passkey then Social | Separate accounts (no email match possible) |

### Pre-account hijacking (mitigated)

Better Auth's auto-link (`link-account.mjs` line 22) checks whether the
*incoming* provider is trusted, but does **not** check whether the *existing*
user's email is verified. If passkey users could set an arbitrary email,
this would allow pre-account hijacking.

**Mitigation:** Passkey users never have a real email. The `anon_xxx@localhost`
placeholder is permanent: no email input exists in the signup flow or
Settings. Since auto-link matches on email, it can never fire against a
passkey account. Social-to-social auto-merge remains safe because both
providers verify their emails.

If email collection is added in the future, OTP verification must be
implemented first. See [EMAIL_VERIFICATION.md](EMAIL_VERIFICATION.md).

## Server endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|

## Implementation status

| Feature | Status |
|---------|--------|
| Demo-first anonymous bootstrap | Done |
| Auth gate hook + modal | Done |
| Passkey signup with bird names | Done |
| Social sign-in (GitHub) | Done |
| Settings: account card, passkey management | Done |
| Remove email input from signup modal | Pending |
| Remove email section from Settings | Pending |
| Remove check-email endpoint | Pending |
| Apple Sign In | Credentials pending |
