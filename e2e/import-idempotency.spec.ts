/**
 * Importing the same eBird export twice must be a no-op.
 *
 * It was not, through the Settings UI specifically. The client dropped previews
 * the species-level check had marked `duplicate`, which changed which row landed
 * first in each date+location group. An outing records that first row's
 * submission id, so a re-import recorded a different id, missed the
 * checklist-level skip, and created a second copy of the outing. Four imports of
 * one export produced four copies of `Montrose Point 2025-09-28`.
 *
 * The API-level path never showed this because it sends every preview.
 */
import { expect, test, type Page } from '@playwright/test'
import path from 'path'
import { loadApp } from './helpers'

async function importViaSettings(page: Page, fixture: string) {
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 5_000 })

  const imported = page.waitForResponse(
    response => response.url().includes('/api/import/ebird-csv') && response.request().method() === 'POST',
  )

  await page.getByRole('button', { name: 'Import from eBird CSV' }).click()
  await expect(page.getByRole('heading', { name: 'Import from eBird CSV' })).toBeVisible({ timeout: 5_000 })

  const fileChooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Choose CSV File' }).click()
  await (await fileChooserPromise).setFiles(path.resolve('e2e/fixtures', fixture))

  const response = await imported
  expect(response.status()).toBe(200)
  return (await response.json()).imported as { outings: number }
}

async function outingCount(page: Page): Promise<number> {
  return await page.evaluate(async () => {
    const res = await fetch('/api/data/all', { credentials: 'include' })
    if (!res.ok) return -1
    return ((await res.json()).outings ?? []).length
  })
}

test('re-importing the same export creates nothing', async ({ page }) => {
  await loadApp(page)

  const first = await importViaSettings(page, 'ebird-import-variant.csv')
  expect(first.outings).toBeGreaterThan(0)
  const afterFirst = await outingCount(page)
  expect(afterFirst).toBe(first.outings)

  await page.reload()
  await expect(page.locator('header')).toBeVisible({ timeout: 5_000 })

  const second = await importViaSettings(page, 'ebird-import-variant.csv')
  expect(second.outings, 'a repeat import must add no outings').toBe(0)
  expect(await outingCount(page), 'outing count must not grow').toBe(afterFirst)
})
