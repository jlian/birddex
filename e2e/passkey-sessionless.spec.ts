/**
 * Signup with NO prior session at all.
 *
 * This became a normal path when the anonymous bootstrap was deferred: a
 * visitor who signs up before touching anything that needs an account never
 * has a session to upgrade. It exercises the other branch of
 * afterVerification, where the durable user is created rather than promoted.
 *
 * The upgrade path is covered by passkey-upgrade.spec.ts.
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
test.describe('sessionless passkey signup', () => {
  test('creates a durable user and session with no prior session', async ({ page }) => {
    await loadApp(page, { promote: false })

    // The precondition that makes this test meaningful: nothing was created on
    // load, so registration starts genuinely unauthenticated.
    const before = await readSession(page)
    expect(before, 'expected no session before signup').toBeNull()

    await promoteAnonymousUser(page)

    const after = await readSession(page)
    expect(after).not.toBeNull()
    expect(after?.isAnonymous).toBe(false)
    expect(after?.id).toBeTruthy()
  })
})
