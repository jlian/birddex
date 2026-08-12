import { expect, type Page } from '@playwright/test'
import { readFileSync } from 'fs'
import path from 'path'

type SessionState = {
  hasUser: boolean
  isAnonymous: boolean
}

async function getSessionState(page: Page): Promise<SessionState> {
  return await page.evaluate(async () => {
    try {
      const res = await fetch('/api/auth/get-session', { credentials: 'include' })
      const body = await res.json().catch(() => null)
      const user = body && typeof body === 'object' ? (body as { user?: unknown }).user : undefined
      if (!user || typeof user !== 'object') {
        return { hasUser: false, isAnonymous: true }
      }

      const rawAnonymous = (user as { isAnonymous?: unknown }).isAnonymous
      return {
        hasUser: true,
        isAnonymous: Boolean(rawAnonymous),
      }
    } catch {
      return { hasUser: false, isAnonymous: true }
    }
  })
}

async function registerVirtualPasskey(page: Page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const added = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  }) as { authenticatorId: string }

  try {
    await page.getByRole('button', { name: 'Log in' }).click()
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 })

    await page.getByRole('button', { name: 'Sign up' }).click()

    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible({ timeout: 10_000 })
  } finally {
    await cdp
      .send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: added.authenticatorId })
      .catch(() => undefined)
    await cdp.send('WebAuthn.disable').catch(() => undefined)
    await cdp.detach().catch(() => undefined)
  }
}

/**
 * Navigate to the app and wait for it to load.
 * Optionally promotes the anonymous session so auth-gated features
 * (Settings, imports, uploads) are accessible in CI / Wrangler environments.
 */
export async function loadApp(page: Page, { promote = true } = {}) {
  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
  } catch (error) {
    const message = String(error)
    if (!message.includes('frame was detached') && !message.includes('ERR_ABORTED')) {
      throw error
    }
    await page.goto('/', { waitUntil: 'domcontentloaded' })
  }
  await expect(page.locator('header')).toBeVisible({ timeout: 5_000 })

  if (promote) {
    await promoteAnonymousUser(page)
  }
}

/**
 * Promote the anonymous session to a real user so auth-gated features
 * (Settings, imports, uploads) are accessible.
 *
 * Registration upgrades the anonymous session in place, then reloads.
 */
export async function promoteAnonymousUser(page: Page) {
  await expect(
    page.getByRole('button', { name: /^(Log in|Settings)$/ }),
    'header identity never resolved',
  ).toBeVisible({ timeout: 10_000 })

  const hasLoginButton = (await page.getByRole('button', { name: 'Log in' }).count()) > 0
  if (!hasLoginButton) {
    return
  }

  const sessionBefore = await getSessionState(page)
  if (sessionBefore.hasUser && !sessionBefore.isAnonymous) {
    return
  }

  try {
    await registerVirtualPasskey(page)
  } catch (error) {
    const msg = String(error)
    // Surface RP ID mismatches clearly so the fix is obvious
    if (msg.includes('RP ID') || msg.includes('Settings')) {
      throw new Error(
        'E2E passkey promotion failed (likely RP ID mismatch). '
        + 'Ensure BETTER_AUTH_URL is not overriding the loopback origin in .dev.vars. '
        + `Original: ${msg}`,
      )
    }
    throw error
  }

  const sessionAfter = await getSessionState(page)
  if (sessionAfter.hasUser && !sessionAfter.isAnonymous) {
    await page.reload()
    await expect(page.locator('header')).toBeVisible({ timeout: 5_000 })
    return
  }

  throw new Error('E2E passkey promotion failed: session is still anonymous after signup flow')
}

/**
 * Seed the app with data from the eBird CSV fixture via the import API.
 *
 * Navigates to Settings, uploads the CSV through the hidden file input
 * (which triggers preview → auto-confirm), waits for the success toast,
 * then navigates back to the Home tab.
 */
export async function seedViaCSVImport(page: Page) {
  await loadApp(page)

  // Seed via direct API calls instead of navigating the Settings UI.
  // This is significantly faster since it skips all the UI round-trips.
  const csvBuffer = readFileSync(path.resolve('e2e/fixtures/ebird-import.csv'))

  const imported = await page.request.post('/api/import/ebird-csv', {
    multipart: {
      file: { name: 'ebird-import.csv', mimeType: 'text/csv', buffer: csvBuffer },
    },
  })
  expect(imported.ok(), `CSV import failed: ${imported.status()}`).toBe(true)

  // Reload so the UI picks up the seeded data
  await page.reload()
  await expect(page.locator('header')).toBeVisible({ timeout: 5_000 })
}
