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

  test('a cancelled ceremony leaves no user, passkey or session behind', async ({ page }) => {
    await loadApp(page, { promote: false })
    expect(await readSession(page), 'expected no session before signup').toBeNull()

    // Requesting the options is the furthest a cancelled ceremony gets. The
    // resolveUser stub is not persisted and afterVerification never runs, so
    // this must write nothing at all.
    const optionsStatus = await page.evaluate(async () => {
      const res = await fetch('/api/auth/passkey/generate-register-options', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      return res.status
    })
    expect(optionsStatus, 'options should be reachable without a session').toBeLessThan(500)
    expect(await readSession(page), 'requesting options must not create a session').toBeNull()

    // Now the user side of a cancel: the OS sheet is dismissed, so
    // navigator.credentials.create rejects and verify-registration is never
    // called. The app should stay quiet rather than surfacing an error.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'credentials', {
        configurable: true,
        value: {
          create: () => Promise.reject(Object.assign(new Error('cancelled'), { name: 'NotAllowedError' })),
          get: () => Promise.reject(Object.assign(new Error('cancelled'), { name: 'NotAllowedError' })),
        },
      })
    })
    await page.reload()
    await expect(page.locator('header')).toBeVisible({ timeout: 5_000 })

    // Proves the cancel actually happened in the browser: the ceremony must
    // reach the options request and stop before verification.
    const calls: string[] = []
    page.on('request', request => {
      const { pathname } = new URL(request.url())
      if (pathname.startsWith('/api/auth/passkey/')) calls.push(pathname)
    })

    await page.getByRole('button', { name: 'Log in' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    await dialog.getByRole('button', { name: 'Sign up' }).click()

    // The dialog stays open on the sign-up options rather than reporting a
    // failure, since declining the sheet is not an error.
    await expect(dialog.getByRole('button', { name: 'Sign up' })).toBeVisible({ timeout: 5_000 })
    await expect.poll(() => calls.some(path => path.includes('generate-register-options'))).toBe(true)
    expect(calls, 'verification must never be reached').not.toContain('/api/auth/passkey/verify-registration')
    expect(await readSession(page), 'a cancelled ceremony must not create a session').toBeNull()
  })
})
