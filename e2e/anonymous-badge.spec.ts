/**
 * The anonymous visitor's identity and the durability warning attached to it.
 *
 * An anonymous account lives in one browser, so the badge states a fact that is
 * otherwise invisible. It is deliberately quiet: it appears only once there are
 * sightings to lose.
 */
import { expect, test, type Page } from '@playwright/test'
import { loadApp } from './helpers'

const BADGE = 'These sightings are only on this device'

async function startAnonymousSession(page: Page) {
  const created = await page.evaluate(async () => {
    const res = await fetch('/api/auth/sign-in/anonymous', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    return res.ok
  })
  expect(created, 'anonymous sign-in failed').toBe(true)
}

/**
 * Create an outing and a sighting directly rather than importing them. Import
 * is account-only now, and this is the path an anonymous visitor actually
 * takes anyway.
 */
async function addSighting(page: Page, locationName: string) {
  const created = await page.evaluate(async (name) => {
    const outingId = `outing_${crypto.randomUUID()}`
    const outing = await fetch('/api/data/outings', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: outingId,
        startTime: '2026-03-01T09:00:00.000Z',
        endTime: '2026-03-01T10:00:00.000Z',
        locationName: name,
        notes: '',
        createdAt: new Date().toISOString(),
      }),
    })
    if (!outing.ok) return false

    const observations = await fetch('/api/data/observations', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{
        id: `obs_${crypto.randomUUID()}`,
        outingId,
        speciesName: 'Rock Pigeon (Columba livia)',
        count: 1,
        certainty: 'confirmed',
        notes: '',
      }]),
    })
    return observations.ok
  }, locationName)
  expect(created, 'sighting creation failed').toBe(true)

  await page.reload()
  await expect(page.locator('header')).toBeVisible({ timeout: 5_000 })
}

test.describe('anonymous durability badge', () => {
  test('shows the generic icon until an account exists', async ({ page }) => {
    await loadApp(page, { promote: false })

    // The bootstrap is deferred, so a visitor who has done nothing has no user
    // row and therefore no bird name to show.
    const entry = page.getByRole('button', { name: 'Log in' })
    await expect(entry).toBeVisible()
    await expect(entry.locator('img')).toHaveCount(0)
    await expect(page.getByLabel(BADGE)).toBeHidden()
  })

  test('shows the bird avatar once the anonymous account exists', async ({ page }) => {
    await loadApp(page, { promote: false })
    await startAnonymousSession(page)
    await page.reload()

    // Derived from the name the server assigned at creation, so it survives a
    // reload and matches what Settings shows after signup.
    const avatar = page.getByRole('button', { name: 'Log in' }).locator('img')
    await expect(avatar).toHaveAttribute('src', /^data:image\/svg\+xml/)
    await expect(page.getByLabel(BADGE)).toBeHidden()
  })

  test('badges the avatar once sightings exist', async ({ page }) => {
    await loadApp(page, { promote: false })
    await startAnonymousSession(page)
    await addSighting(page, 'My Patch')

    await expect(page.getByLabel(BADGE)).toBeVisible()
  })
})

test.describe('export offer before an account switch', () => {
  test('warns on log in and not on sign up', async ({ page }) => {
    await loadApp(page, { promote: false })
    await startAnonymousSession(page)
    await addSighting(page, 'My Patch')

    await page.getByRole('button', { name: 'Log in' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5_000 })

    // Sign up upgrades the anonymous user in place and keeps the id, so there
    // is nothing to warn about on that path.
    await expect(dialog.getByRole('button', { name: 'Sign up' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Export sightings as CSV' })).toBeHidden()

    await dialog.getByRole('button', { name: 'Log in' }).click()
    await expect(dialog.getByRole('button', { name: 'Export sightings as CSV' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Continue to log in' })).toBeVisible()
    // Non-blocking: the sign-up path is still reachable by backing out.
    await dialog.getByRole('button', { name: 'Back' }).click()
    await expect(dialog.getByRole('button', { name: 'Sign up' })).toBeVisible()
  })

  test('exports the anonymous sightings before the session is swapped', async ({ page }) => {
    await loadApp(page, { promote: false })
    await startAnonymousSession(page)
    await addSighting(page, 'My Patch')

    await page.getByRole('button', { name: 'Log in' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Log in' }).click()

    const download = page.waitForEvent('download')
    await dialog.getByRole('button', { name: 'Export sightings as CSV' }).click()
    const csv = await (await download).createReadStream()

    const chunks: Buffer[] = []
    for await (const chunk of csv) chunks.push(chunk as Buffer)
    expect(Buffer.concat(chunks).toString()).toContain('Rock Pigeon')
  })

  test('skips the warning when there is nothing to lose', async ({ page }) => {
    await loadApp(page, { promote: false })

    await page.getByRole('button', { name: 'Log in' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    await dialog.getByRole('button', { name: 'Log in' }).click()

    // Goes straight to the passkey ceremony, which fails with no authenticator
    // registered. What matters is that the warning step was not interposed.
    await expect(dialog.getByRole('button', { name: 'Continue to log in' })).toBeHidden()
  })
})
