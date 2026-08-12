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

test('an exact retry of an ID-less legacy export is a no-op', async ({ page }) => {
  const csv = [
    'Common Name,Genus,Species,Number,Species Comments,Location Name,Latitude,Longitude,Date,Start Time,State/Province,Country Code,Protocol,Number of Observers,Duration,All observations reported?,Effort Distance Miles,Effort area acres,Submission Comments',
    'Great Blue Heron,Ardea,herodias,1,,Legacy Marsh,47.6,-122.4,03/10/2026,08:15,US-WA,US,Incidental,1,60,N,,,Legacy WingDex export',
  ].join('\n')
  const source = {
    name: 'legacy-wingdex.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  }

  await loadApp(page)

  const first = await importViaSettings(page, source)
  expect(first.outings).toBe(1)
  const afterFirst = await outingCount(page)

  await page.reload()
  await expect(page.locator('header')).toBeVisible({ timeout: 5_000 })
  const second = await importViaSettings(page, source)

  expect(second.outings).toBe(0)
  expect(await outingCount(page)).toBe(afterFirst)
})

test('concurrent exact imports commit only one copy', async ({ page }) => {
  const csv = [
    'Common Name,Genus,Species,Number,Species Comments,Location Name,Latitude,Longitude,Date,Start Time,State/Province,Country Code,Protocol,Number of Observers,Duration,All observations reported?,Effort Distance Miles,Effort area acres,Submission Comments',
    'Mallard,Anas,platyrhynchos,2,,Concurrent Marsh,47.6,-122.4,03/11/2026,08:15,US-WA,US,Incidental,1,60,N,,,Concurrent retry',
  ].join('\n')
  await loadApp(page)

  const multipart = {
    file: { name: 'concurrent.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) },
  }
  const [first, second] = await Promise.all([
    page.request.post('/api/import/ebird-csv', { multipart }),
    page.request.post('/api/import/ebird-csv', { multipart }),
  ])

  expect(first.status()).toBe(200)
  expect(second.status()).toBe(200)
  const results = [await first.json(), await second.json()] as Array<{ imported: { outings: number } }>
  expect(results.map(result => result.imported.outings).sort()).toEqual([0, 1])
  expect(await outingCount(page)).toBe(1)
})

test('a WingDex export uses its outing ID and does not re-import into the same account', async ({ page }) => {
  await loadApp(page)
  const outingId = `outing_${crypto.randomUUID()}`
  const outing = await page.request.post('/api/data/outings', {
    data: {
      id: outingId,
      startTime: '2026-03-12T08:00:00-07:00',
      endTime: '2026-03-12T09:00:00-07:00',
      locationName: 'Roundtrip Marsh',
      notes: '',
      createdAt: '2026-03-12T08:00:00-07:00',
    },
  })
  expect(outing.status()).toBe(200)
  const observation = await page.request.post('/api/data/observations', {
    data: [{
      id: `obs_${crypto.randomUUID()}`,
      outingId,
      speciesName: 'Mallard (Anas platyrhynchos)',
      count: 1,
      certainty: 'confirmed',
      notes: '',
    }],
  })
  expect(observation.status()).toBe(200)

  const exported = await page.request.get('/api/export/sightings')
  expect(exported.status()).toBe(200)
  const csv = await exported.body()
  expect(csv.toString()).toContain(`WINGDEX-OUTING-${outingId}`)
  const before = await outingCount(page)

  const imported = await importViaSettings(page, {
    name: 'wingdex-roundtrip.csv',
    mimeType: 'text/csv',
    buffer: csv,
  })
  expect(imported.outings).toBe(0)
  expect(await outingCount(page)).toBe(before)
})
