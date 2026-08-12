/**
 * The journeys the account-optional design rests on, end to end.
 *
 * These exist because the rest of the suite mostly runs signed in, which is the
 * opposite of what this work changed. Each one is a thing a person does, not a
 * feature in isolation.
 */
import { expect, test, type Page } from '@playwright/test'
import { loadApp, promoteAnonymousUser } from './helpers'

const BADGE = 'These sightings are only on this device'

async function startAnonymousSession(page: Page) {
  const ok = await page.evaluate(async () => {
    const res = await fetch('/api/auth/sign-in/anonymous', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    return res.ok
  })
  expect(ok, 'anonymous sign-in failed').toBe(true)
}

async function addSighting(page: Page, locationName: string) {
  const ok = await page.evaluate(async (name) => {
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
  expect(ok, 'sighting creation failed').toBe(true)

  await page.reload()
  await expect(page.locator('header')).toBeVisible({ timeout: 5_000 })
}

async function readSession(page: Page) {
  return await page.evaluate(async () => {
    const res = await fetch('/api/auth/get-session', { credentials: 'include' })
    if (!res.ok) return null
    const body = await res.json().catch(() => null)
    if (!body?.user) return null
    return { id: String(body.user.id), name: String(body.user.name ?? ''), isAnonymous: Boolean(body.user.isAnonymous) }
  })
}

test('the convert: signing up keeps the data and opens Settings', async ({ page }) => {
  await loadApp(page, { promote: false })
  await startAnonymousSession(page)
  await addSighting(page, 'Convert Patch')

  const before = await readSession(page)
  expect(before?.isAnonymous).toBe(true)
  await expect(page.getByLabel(BADGE)).toBeVisible()

  await promoteAnonymousUser(page)

  const after = await readSession(page)
  expect(after?.isAnonymous).toBe(false)
  expect(after?.id, 'the account is upgraded in place').toBe(before?.id)
  expect(after?.name, 'the bird they saw as a guest is the name they keep').toBe(before?.name)

  // The point of signing up: the data is still there and now portable.
  await expect(page.getByLabel(BADGE)).toBeHidden()
  await page.getByRole('tab', { name: 'Outings' }).first().click()
  await expect(page.getByText('Convert Patch')).toBeVisible({ timeout: 5_000 })

  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 5_000 })
  await expect(page.getByRole('button', { name: 'Import from eBird CSV' })).toBeVisible()
})

test('the loss event: clearing cookies leaves a working app', async ({ page, context }) => {
  await loadApp(page, { promote: false })
  await startAnonymousSession(page)
  await addSighting(page, 'Doomed Patch')
  await expect(page.getByLabel(BADGE)).toBeVisible()

  // Exactly the risk the badge names. It should degrade to a fresh visitor
  // rather than a broken one.
  await context.clearCookies()
  await page.reload()
  await expect(page.locator('header')).toBeVisible({ timeout: 5_000 })

  expect(await readSession(page), 'the anonymous account is unreachable now').toBeNull()
  await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible()
  await expect(page.getByLabel(BADGE)).toBeHidden()
  await expect(page.getByRole('button', { name: 'Upload & Identify' })).toBeVisible()

  await page.getByRole('tab', { name: 'Outings' }).first().click()
  await expect(page.getByText('Doomed Patch')).toBeHidden()
})

test('the session cookie is HttpOnly and lasts about a year', async ({ page, context }) => {
  await loadApp(page, { promote: false })
  await promoteAnonymousUser(page)

  const visibleToScript = await page.evaluate(() => document.cookie)
  expect(visibleToScript, 'the session token must not be readable by script').not.toContain('session_token')

  const cookies = await context.cookies()
  const session = cookies.find(cookie => cookie.name.includes('session_token'))
  expect(session, 'expected a session cookie').toBeTruthy()
  expect(session?.httpOnly).toBe(true)

  // 365 days, set well under Chrome's 400-day cap so nothing is silently
  // rewritten. Generous tolerance: only a wrong order of magnitude matters.
  const daysOut = (session!.expires * 1000 - Date.now()) / 86_400_000
  expect(daysOut).toBeGreaterThan(300)
  expect(daysOut).toBeLessThan(400)
})
