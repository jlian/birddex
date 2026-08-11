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
    return { id: String(body.user.id), isAnonymous: Boolean(body.user.isAnonymous) }
  })
}
test.describe('passkey signup', () => {
  test('upgrades the anonymous user in place, keeping the same id', async ({ page }) => {
    // promote: false so the anonymous session can be observed before signup.
    await loadApp(page, { promote: false })

    const before = await readSession(page)
    expect(before, 'expected an anonymous session on load').not.toBeNull()
    expect(before?.isAnonymous).toBe(true)

    await promoteAnonymousUser(page)

    const after = await readSession(page)
    expect(after).not.toBeNull()
    expect(after?.isAnonymous).toBe(false)

    // The assertion that matters. A new user id here would mean the anonymous
    // account was discarded, which is what forces data migration and a
    // cascading delete of the old rows.
    expect(after?.id).toBe(before?.id)
  })
})
