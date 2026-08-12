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

type CsvSource = string | { name: string; mimeType: string; buffer: Buffer }

async function importViaSettings(page: Page, csv: CsvSource) {
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 5_000 })

  const imported = page.waitForResponse(
    response => response.url().includes('/api/import/ebird-csv') && response.request().method() === 'POST',
  )

  await page.getByRole('button', { name: 'Import from eBird CSV' }).click()
  await expect(page.getByRole('heading', { name: 'Import from eBird CSV' })).toBeVisible({ timeout: 5_000 })

  const fileChooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Choose CSV File' }).click()
  await (await fileChooserPromise).setFiles(
    typeof csv === 'string' ? path.resolve('e2e/fixtures', csv) : csv,
  )

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

/**
 * D1 caps a query at 100 bound parameters. The checklist-skip query binds the
 * user id plus one id per checklist, so an export with 100 or more checklists
 * overflowed the first chunk and failed the whole import with a 500. Both
 * fixtures carry ten checklists, so nothing caught it until a real export did.
 */
test('an export with more checklists than D1 allows per query still imports', async ({ page }) => {
  const CHECKLISTS = 120
  const header = 'Submission ID,Common Name,Scientific Name,Taxonomic Order,Count,State/Province,County,Location ID,Location,Latitude,Longitude,Date,Time,Protocol,Duration (Min),All Obs Reported,Distance Traveled (km),Area Covered (ha),Number of Observers,Breeding Code,Observation Details,Checklist Comments,ML Catalog Numbers'
  const rows = Array.from({ length: CHECKLISTS }, (_, i) =>
    `S9902${String(i).padStart(5, '0')},Rock Pigeon,Columba livia,1853,x,US-WA,King,L990${String(i).padStart(5, '0')},Site ${i},47.${6000 + i},-122.${4000 + i},2026-03-01,07:05 AM,eBird - Traveling Count,48,1,1.4,,1,,,,`)

  await loadApp(page)

  const imported = await importViaSettings(page, {
    name: 'many-checklists.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from([header, ...rows].join('\n')),
  })

  expect(imported.outings, 'every checklist must land').toBe(CHECKLISTS)
  expect(await outingCount(page)).toBe(CHECKLISTS)
})
