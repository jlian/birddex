# Email Verification Spec

> Status: **Deferred**: not currently planned. Retained as a reference if
> email collection is added in the future.

## Context

As of the `passkey-ux` branch, passkey users do not provide an email at
signup and have no way to add one in Settings. Their `user.email` stays as
`anon_xxx@localhost` permanently. This eliminates the pre-account hijacking
risk (see [PASSKEYS_UX.md](PASSKEYS_UX.md#pre-account-hijacking-mitigated))
and means auto-merge only applies to social-to-social sign-ins.

If email collection is reintroduced (e.g. for account recovery or
cross-provider merge), **OTP verification must be implemented first** to
prevent unverified emails from triggering auto-link. This spec describes
how that would work.

## Problem

Storing unverified email on `user.email` enables **pre-account hijacking**:
an attacker claims `victim@gmail.com` via passkey, then the real owner signs
in with GitHub and Better Auth auto-links their account to the attacker's.

See [PASSKEYS_UX.md](PASSKEYS_UX.md#pre-account-hijacking-mitigated) for details.

## Solution

Reddit-style: collect email, verify via OTP before writing to `user.email`.
The app is fully usable without a verified email. `user.email` stays as
`anon_xxx@localhost` until the user completes OTP verification. Email is
stored only in the `verification` table (as a pending value) until verified.

## User flows

### Flow A: Signup with email

1. User enters email in auth gate modal
2. Passkey created (email used as keychain label)
3. Passkey verification upgrades the anonymous user in place; no email is set
4. `POST /api/auth/send-email-otp` with `{ email }`: generates OTP, stores in
   `verification` table, sends email via Resend
5. Modal shows OTP input: "We sent a code to you@example.com"
6. User enters code → `POST /api/auth/verify-email-otp` with `{ email, otp }`
7. Server validates OTP → updates `user.email` → returns success
8. If user dismisses → email stays unverified, app works normally

### Flow B: Verify later from Settings

1. User sees "Add email for account recovery" in Settings
2. Enters email → `POST /api/auth/send-email-otp`
3. OTP input appears inline → enters code → `POST /api/auth/verify-email-otp`
4. `user.email` updated, UI refreshes

### Flow C: Verify via deep link

1. Verification email contains link: `https://wingdex.app/#verify-email?email=...&otp=...`
2. App parses hash on mount → auto-submits to `POST /api/auth/verify-email-otp`
3. If session matches → email verified. If no session → prompt to sign in first.

## Server endpoints

### `POST /api/auth/send-email-otp`

**Auth:** Requires session.

**Body:** `{ email: string }`

**Logic:**
1. Validate email format (contains `@`, reasonable length)
2. Check email not already taken by another user
3. Generate 6-digit OTP
4. Store in `verification` table:
   - `identifier`: `email-verify:<userId>`
   - `value`: `<email>:<otp>`
   - `expiresAt`: now + 10 minutes
5. Send email via Resend with OTP + verification link
6. Return `{ success: true }`

**Errors:** `401` (no session), `400` (invalid email), `409` (email taken)

### `POST /api/auth/verify-email-otp`

**Auth:** Requires session.

**Body:** `{ email: string, otp: string }`

**Logic:**
1. Look up `verification` row for `email-verify:<userId>`
2. Check `value` matches `<email>:<otp>` and `expiresAt` is in the future
3. Check email uniqueness (race condition guard)
4. Update `user.email` and `user.emailVerified = true`
5. Delete the verification row
6. Return `{ success: true }`

**Errors:** `401` (no session), `400` (invalid/expired OTP), `409` (email taken)

## Email provider: Resend

- **Service:** [Resend](https://resend.com): transactional email API
- **Free tier:** 100 emails/day, 3,000/month (sufficient for early stage)
- **Domain:** `wingdex.app` (requires DNS verification with Resend)
- **From address:** `WingDex <noreply@wingdex.app>`
- **API:** `POST https://api.resend.com/emails` with Bearer token auth

### Why not Cloudflare Email Workers?

Cloudflare's `send_email` binding only sends to pre-configured destination
addresses. It cannot send to arbitrary user emails: not suitable for
verification flows. Good for contact forms (fixed recipient).

### Domain setup plan

The developer's Resend account currently serves `johnlian.net` for a personal
contact form. To use Resend for `wingdex.app`:

1. Move the `johnlian.net` contact form to Cloudflare Email Workers
   (both from and to addresses are owned: CF Email Workers can handle this)
2. Remove `johnlian.net` from Resend
3. Add `wingdex.app` domain to Resend, verify DNS (DKIM + SPF records)
4. Set `RESEND_API_KEY` and `EMAIL_FROM` as Cloudflare Pages secrets

## Env variables

| Variable | Value | Where |
|----------|-------|-------|
| `RESEND_API_KEY` | Resend API key | CF Pages secret |
| `EMAIL_FROM` | `WingDex <noreply@wingdex.app>` | CF Pages secret or env |

These need to be added to `functions/env.d.ts`:
```ts
RESEND_API_KEY?: string
EMAIL_FROM?: string
```

## Database

No schema changes needed. The `verification` table already exists (migration
0001) with the required columns:

```sql
CREATE TABLE verification (
  id         TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value      TEXT NOT NULL,
  expiresAt  TEXT NOT NULL,
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL
);
```

## Client changes

### Auth client (`src/lib/auth-client.ts`)

No changes needed: the OTP endpoints are custom (not Better Auth plugin
routes), so they use plain `fetch()` calls.

If we later switch to Better Auth's built-in `emailOTP` plugin, add
`emailOTPClient()` to the plugins array.

### Auth gate modal (`use-auth-gate.tsx`)

After passkey signup with email:
1. Show inline OTP input: "Enter the code we sent to you@example.com"
2. Submit button → `POST /api/auth/verify-email-otp`
3. "Resend code" link → `POST /api/auth/send-email-otp`
4. "Skip" link → dismiss, email stays unverified

### Settings page

Replace the current direct-save email input with:
1. Email input + "Verify" button → `POST /api/auth/send-email-otp`
2. OTP input appears → enter code → `POST /api/auth/verify-email-otp`
3. On success: refetch session, show verified email
4. If `user.email` is already verified, show it as read-only

### Hash route handler

Add handler in `App.tsx` or router:
- `#verify-email?email=...&otp=...` → auto-verify on mount
- Requires active session: if no session, show "Sign in to verify email"

## Local development

When `RESEND_API_KEY` is not set, the email helper logs the OTP to the
console instead of sending:
```
[email-otp] code=123456 to=user@example.com link=http://localhost:5173/#verify-email?...
```
This lets the full flow work locally without an email provider.

## Security considerations

- **Rate limiting:** The send-email-otp endpoint should be rate-limited
  (e.g. 3 attempts per email per 10 minutes) to prevent abuse. Cloudflare's
  built-in rate limiting or a simple counter in D1 works.
- **OTP brute-force:** 6-digit OTP with 10-minute expiry and single-use
  gives $10^6$ combinations. Rate-limit verify attempts (e.g. 5 per
  verification identifier per 10 minutes).
- **Email enumeration:** The send-email-otp endpoint returns `409` for taken
  emails. This is the same info leak as any "email already registered" error.
  Acceptable for this app's threat model. The existing `check-email` endpoint
  (which has no auth requirement) should be removed since it's a wider surface.
- **No email in user.email until verified:** This is the critical invariant.
  If this is violated, auto-link becomes unsafe.

## Implementation checklist

- [ ] Set up Resend on `wingdex.app` domain
- [ ] Add `RESEND_API_KEY` / `EMAIL_FROM` to CF Pages secrets
- [ ] Add env vars to `functions/env.d.ts`
- [ ] Implement `send-email-otp` endpoint
- [ ] Implement `verify-email-otp` endpoint
- [ ] Keep real email out of `user.email` until OTP verification succeeds
- [ ] Add OTP input step to auth gate modal (post-signup)
- [ ] Add email verification UI to Settings page
- [ ] Add `#verify-email` deep link handler
- [ ] Remove `check-email` endpoint
- [ ] Update `use-auth-gate.tsx` signup flow (remove check-email call)
- [ ] Add local dev console fallback for email sending
- [ ] Tests for send/verify OTP endpoints
- [ ] E2e test for email verification flow
