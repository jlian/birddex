/**
 * Proves the claim the design now rests on (#271): signing up with a passkey
 * UPGRADES the anonymous user in place instead of creating a second one, so
 * demo and real data stay attached and no row migration is needed.
 *
 * The other UI specs promote an anonymous user as a precondition and would
 * pass either way, since they only care that the session ends up non-anonymous.
 * This one asserts the identity itself is preserved.
 */
import { expect, test } from '@playwright/test'
import { loadApp, promoteAnonymousUser } from './helpers'

async function readSession(page: import('@playwright/test').Page) {
  return await page.evaluate(async () => {
    const res = await fetch('/api/auth/get-session', { credentials: 'include' })
    if (!res.ok) return null
    const body = await res.json().catch(() => null)
    if (!body?.user) return null
    return { id: String(body.user.id), name: String(body.user.name ?? ''), isAnonymous: Boolean(body.user.isAnonymous) }
  })
}
test.describe('passkey signup', () => {
  test('upgrades the anonymous user in place, keeping the same id', async ({ page }) => {
    // promote: false so the anonymous session can be observed before signup.
    await loadApp(page, { promote: false })

    // The bootstrap is deferred now, so a fresh visitor has no session at all.
    // Create one the way the demo toggle does, since the point of this test is
    // the UPGRADE path: an existing anonymous account becoming a real one.
    await page.evaluate(async () => {
      await fetch('/api/auth/sign-in/anonymous', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    })
    await page.reload()
    await expect(page.locator('header')).toBeVisible({ timeout: 5_000 })

    const before = await readSession(page)
    expect(before, 'expected an anonymous session after bootstrap').not.toBeNull()
    expect(before?.isAnonymous).toBe(true)
    // Named on creation, not left as the plugin's "Anonymous" default.
    expect(before?.name).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/)

    await promoteAnonymousUser(page)

    const after = await readSession(page)
    expect(after).not.toBeNull()
    expect(after?.isAnonymous).toBe(false)

    // The assertion that matters. A new user id here would mean the anonymous
    // account was discarded, which is what forces data migration and a
    // cascading delete of the old rows.
    expect(after?.id).toBe(before?.id)

    // The bird they saw as a guest is the name they keep. Regression guard:
    // afterVerification used to write the plugin's WebAuthn handle here, which
    // is the throwaway anonymous email, so signup renamed people to temp@....
    expect(after?.name).toBe(before?.name)
  })
})
