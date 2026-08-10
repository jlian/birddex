import { test, expect, type Page, type Route } from '@playwright/test'
import path from 'path'
import { readFileSync } from 'fs'
import { loadApp } from './helpers'

// ── Fixture helpers ──────────────────────────────────────────────


/**
 * Identification runs ON DEVICE now, so there is no endpoint to stub. These
 * tests therefore exercise the REAL model: preprocessing, the int8 tower, the
 * classifier and the geo/month prior all run for real.
 *
 * That means the assertions below check INVARIANTS, not a specific species.
 * Asserting "the model says Chukar" would couple the browser suite to model
 * weights, so every retrain would break tests that are not about accuracy.
 * Accuracy is owned by ml/parity/jobs/rank_parity.ts, which scores all 11,070
 * calibration photos. What these tests own is the FLOW: a photo goes in, some
 * species comes out, the user can confirm it, and it persists.
 *
 * Clears the one-time download gate so the flow reaches identification.
 */
async function passModelGate(page: Page) {
  // The gate renders INSIDE the upload dialog, after "Continue to Species", so
  // this must be called at that point rather than before the dialog opens.
  const gate = page.getByRole('button', { name: 'Download and continue' })
  const error = page.getByText(/^Download failed:/)
  const result = page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).first()
  // Race the gate against the step it hands off to. On a warm cache the gate
  // self-clears and the button never appears, so waiting on it alone burned the
  // full 60s on every run. Losing the race costs only the old behaviour.
  const handedOff = page.getByText(/Identifying species/i)
  await Promise.race([
    // Generous: the gate appears only after the flow reaches identification,
    // and a cold worker start can push that past a tight budget. A short wait
    // here caused a flake that passed on retry.
    gate.waitFor({ state: 'visible', timeout: 60_000 }),
    handedOff.waitFor({ state: 'visible', timeout: 60_000 }),
    result.waitFor({ state: 'visible', timeout: 60_000 }),
  ]).catch(() => {
    // Neither appeared. Already cached and already past it, so nothing to do.
  })
  if (await gate.isVisible().catch(() => false)) {
    await gate.click()
    await Promise.race([
      result.waitFor({ state: 'visible', timeout: 120_000 }),
      error.waitFor({ state: 'visible', timeout: 120_000 }),
    ])
    if (await error.isVisible().catch(() => false)) {
      throw new Error(await error.innerText())
    }
  }
}

/** Mock WingDex geocoding routes to return a canned normalized location. */
function mockGeocoding(page: Page, locationName: string) {
  return page.route('**/api/geocoding/**', (route: Route) => {
    const url = new URL(route.request().url())
    if (url.pathname.includes('reverse')) {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          result: {
            label: locationName,
            lat: 47.66,
            lon: -122.41,
            stateProvince: 'US-WA',
            countryCode: 'US',
          },
        }),
      })
    } else {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          results: [{
            label: locationName,
            lat: 47.66,
            lon: -122.41,
            stateProvince: 'US-WA',
            countryCode: 'US',
          }],
        }),
      })
    }
  })
}

/** Mock Wikipedia/Wikimedia image requests so they don't fail. */
function mockWikimedia(page: Page) {
  return page.route('**/en.wikipedia.org/**', (route: Route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"query":{"pages":{}}}' })
  })
}

/** Navigate to Settings page. */
async function goToSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 5_000 })
}

// ── Tests ────────────────────────────────────────────────────────

test.describe('CSV import + photo upload integration', () => {

  test('CSV import creates outings with correct timezone-converted times', async ({ page }) => {
    await loadApp(page)
    await goToSettings(page)

    // Profile timezone defaults to America/Los_Angeles (Pacific), no need to change it

    const previewResponsePromise = page.waitForResponse(
      response => response.url().includes('/api/import/ebird-csv') && response.request().method() === 'POST'
    )
    const confirmResponsePromise = page.waitForResponse(
      response => response.url().includes('/api/import/ebird-csv/confirm') && response.request().method() === 'POST'
    )

    await page.getByRole('button', { name: 'Import from eBird CSV' }).click()
    await expect(page.getByRole('heading', { name: 'Import from eBird CSV' })).toBeVisible({ timeout: 5_000 })

    const fileChooserPromise = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Choose CSV File' }).click()
    const fileChooser = await fileChooserPromise
    await fileChooser.setFiles(path.resolve('e2e/fixtures/ebird-import.csv'))

    const previewResponse = await previewResponsePromise
    expect(previewResponse.status()).toBe(200)

    const confirmResponse = await confirmResponsePromise
    expect(confirmResponse.status()).toBe(200)

    await expect(page.getByText(/Failed to import eBird data/i)).not.toBeVisible()

    // Navigate to Outings page
    await page.getByRole('tab', { name: 'Outings' }).first().click()
    await expect(page.getByText('Your Outings')).toBeVisible({ timeout: 5_000 })

    // Should have 2 outings (2 submission IDs in our CSV)
    // Haleakala outing
    await expect(
      page.locator('p:visible', { hasText: 'Haleakala' }).first()
    ).toBeVisible({ timeout: 5_000 })

    // Discovery Park outing
    await expect(
      page.locator('p:visible', { hasText: 'Discovery Park' }).first()
    ).toBeVisible()

    // Navigate to WingDex to verify species
    await page.getByRole('tab', { name: 'WingDex' }).first().click()
    await expect(page.locator('p:visible', { hasText: 'species observed' }).first()).toBeVisible({ timeout: 5_000 })
    const wingdexSearch = page.getByPlaceholder('Search species...')

    // All 4 species from the CSV should be in the dex
    for (const species of ['Chukar', 'Hawaiian Goose', "Steller's Jay", 'Dark-eyed Junco']) {
      await wingdexSearch.fill(species)
      await expect(
        page.locator('p:visible', { hasText: species }).first()
      ).toBeVisible()
    }
  })

  test('CSV import handles variant realistic eBird rows via UI flow', async ({ page }) => {
    await loadApp(page)
    await goToSettings(page)

    const previewResponsePromise = page.waitForResponse(
      response => response.url().includes('/api/import/ebird-csv') && response.request().method() === 'POST'
    )
    const confirmResponsePromise = page.waitForResponse(
      response => response.url().includes('/api/import/ebird-csv/confirm') && response.request().method() === 'POST'
    )

    await page.getByRole('button', { name: 'Import from eBird CSV' }).click()
    await expect(page.getByRole('heading', { name: 'Import from eBird CSV' })).toBeVisible({ timeout: 5_000 })

    const fileChooserPromise = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Choose CSV File' }).click()
    const fileChooser = await fileChooserPromise
    await fileChooser.setFiles(path.resolve('e2e/fixtures/ebird-import-variant.csv'))

    const previewResponse = await previewResponsePromise
    expect(previewResponse.status()).toBe(200)

    const confirmResponse = await confirmResponsePromise
    expect(confirmResponse.status()).toBe(200)

    await expect(page.getByText(/Failed to import eBird data/i)).not.toBeVisible()

    await page.getByRole('tab', { name: 'Outings' }).first().click()
    await expect(page.getByText('Your Outings')).toBeVisible({ timeout: 5_000 })
    await expect(
      page.locator('p:visible', { hasText: 'Point Reyes National Seashore' }).first()
    ).toBeVisible({ timeout: 5_000 })

    await page.getByRole('tab', { name: 'WingDex' }).first().click()
    await expect(page.locator('p:visible', { hasText: 'species observed' }).first()).toBeVisible({ timeout: 5_000 })
    const wingdexSearch = page.getByPlaceholder('Search species...')

    for (const species of ['Rock Pigeon', 'Northern Cardinal', 'Chukar']) {
      await wingdexSearch.fill(species)
      await expect(
        page.locator('p:visible', { hasText: species }).first()
      ).toBeVisible({ timeout: 5_000 })
    }
  })

  test('full photo upload flow: upload → AI identify → confirm → saved to WingDex', async ({ page }) => {
    // This is the only test in CI that downloads the 62 MiB model and runs
    // inference. The default budget is 15s on CI and 30s here, which the
    // download alone can exceed, and the waits below ask for far more than
    // that, so without this they are unreachable and the test dies mid-gate.
    test.slow()
    await mockGeocoding(page, 'Haleakala National Park, Maui')
    await mockWikimedia(page)

    await loadApp(page)

    // Open upload wizard
    await page.getByRole('button', { name: 'Upload & Identify' }).click()
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 })

    // Upload a Chukar image (has EXIF GPS for Haleakala)
    const fileInput = page.getByRole('dialog').locator('input[type="file"]')
    await fileInput.setInputFiles(
      path.resolve('src/assets/images/Chukar_partridge_near_Haleakala_summit_Maui.jpg')
    )

    // Should reach Review Outing step
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Review Outing')).toBeVisible({ timeout: 10_000 })

    // Click continue to species identification
    await dialog.getByRole('button', { name: /Continue to Species/i }).click()

    // First identification triggers the 61.66 MiB download gate.
    await passModelGate(page)

    // Wait for AI processing, then the confirm step (scope to dialog)
    // Some species must be offered. Which one is the model's business, and is
    // covered by the parity harness rather than here.
    await expect(
      dialog.getByRole('button', { name: 'Confirm' }).first()
    ).toBeVisible({ timeout: 120_000 })

    const saveObservationsResponse = page.waitForResponse(
      response => response.url().includes('/api/data/observations') && response.request().method() === 'POST'
    )

    // Confirm the species (high confidence = auto-selected with Confirm button)
    await dialog.getByRole('button', { name: 'Confirm' }).first().click()

    await saveObservationsResponse

    // Dialog shows upload summary - dismiss it
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 })
    await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click()
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 5_000 })

    // Navigate to Outings and verify the new outing is visible immediately (no refresh)
    await page.getByRole('tab', { name: 'Outings' }).first().click()
    await expect(page.getByText('Your Outings')).toBeVisible({ timeout: 5_000 })
    const outingsPanel = page.getByRole('tabpanel', { name: 'Outings' })
    await expect(outingsPanel.getByText('Haleakala National Park, Maui')).toBeVisible({ timeout: 5_000 })

    // The observation must be SAVED. Which species the model picked is not this
    // test's business, so assert the dex is non-empty rather than naming one.
    await page.getByRole('tab', { name: 'WingDex' }).first().click()
    await expect(page.getByPlaceholder('Search species...')).toBeVisible({ timeout: 5_000 })
    await expect(
      page.locator('p:visible', { hasText: 'species observed' }).first()
    ).toBeVisible({ timeout: 5_000 })
  })

  test('location search waits for explicit submission and uses the WingDex route', async ({ page }) => {
    await mockGeocoding(page, 'Discovery Park, Seattle')
    await loadApp(page)

    await page.getByRole('button', { name: 'Upload & Identify' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.locator('input[type="file"]').setInputFiles(
      path.resolve('src/assets/images/Chukar_partridge_near_Haleakala_summit_Maui.jpg')
    )
    await expect(dialog.getByText('Review Outing')).toBeVisible({ timeout: 10_000 })

    await dialog.getByText('Discovery Park, Seattle').click()
    const input = dialog.getByPlaceholder('Search for a place...')
    let searchRequestCount = 0
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/api/geocoding/search') searchRequestCount += 1
    })

    await input.fill('Discovery Park')
    await page.waitForTimeout(600)
    expect(searchRequestCount).toBe(0)

    await dialog.getByRole('button', { name: 'Search locations' }).click()
    await expect(dialog.getByText('Discovery Park, Seattle')).toBeVisible()
    expect(searchRequestCount).toBe(1)
    await expect(dialog.getByRole('link', { name: 'Geoapify' })).toBeVisible()
    await expect(dialog.getByRole('link', { name: '© OpenStreetMap contributors' })).toBeVisible()
  })

  // @live: asserts CONVERGENCE onto a named species, which needs a known
  // identity. On-device inference cannot guarantee one without pinning weights,
  // and species agreement is what ml/parity/jobs/rank_parity.ts measures across
  // 11,070 photos. Kept runnable on demand against a real model.
  test('@live species convergence: CSV import + photo upload for same species increases count', async ({ page }) => {
    test.slow()
    // Seed CSV data (includes Chukar) via direct API calls
    await loadApp(page)

    const csvBuffer = readFileSync(path.resolve('e2e/fixtures/ebird-import.csv'))
    const preview = await page.request.post('/api/import/ebird-csv', {
      multipart: {
        file: { name: 'ebird-import.csv', mimeType: 'text/csv', buffer: csvBuffer },
      },
    })
    expect(preview.ok()).toBe(true)
    const { previews } = await preview.json()
    const previewIds = previews
      .map((e: { previewId?: string }) => e.previewId)
      .filter(Boolean)
    const confirm = await page.request.post('/api/import/ebird-csv/confirm', {
      data: { previewIds },
    })
    expect(confirm.ok()).toBe(true)

    // Reload so the UI picks up the seeded data
    await page.reload()
    await expect(page.locator('header')).toBeVisible({ timeout: 5_000 })

    // Verify Chukar is in the dex from CSV
    await page.getByRole('tab', { name: 'WingDex' }).first().click()
    await expect(page.locator('p:visible', { hasText: 'species observed' }).first()).toBeVisible({ timeout: 5_000 })
    await page.getByPlaceholder('Search species...').fill('chukar')
    await expect(page.locator('p:visible', { hasText: 'Chukar' }).first()).toBeVisible()

    // Now upload a Chukar photo, the same species should converge
    await mockGeocoding(page, 'Haleakala National Park, Maui')
    await mockWikimedia(page)

    // Navigate home and open upload wizard
    await page.getByRole('button', { name: 'Home' }).click()
    await expect(page.getByRole('button', { name: 'Upload & Identify' })).toBeVisible({ timeout: 5_000 })
    await page.getByRole('button', { name: 'Upload & Identify' }).click()
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 })

    const fileInput = page.getByRole('dialog').locator('input[type="file"]')
    await fileInput.setInputFiles(
      path.resolve('src/assets/images/Chukar_partridge_near_Haleakala_summit_Maui.jpg')
    )

    // Review outing → continue → confirm (scope to dialog)
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Review Outing')).toBeVisible({ timeout: 10_000 })
    await dialog.getByRole('button', { name: /Continue to Species/i }).click()

    // First identification triggers the 61.66 MiB download gate.
    await passModelGate(page)
    // Some species must be offered. Which one is the model's business, and is
    // covered by the parity harness rather than here.
    await expect(
      dialog.getByRole('button', { name: 'Confirm' }).first()
    ).toBeVisible({ timeout: 120_000 })
    await dialog.getByRole('button', { name: 'Confirm' }).first().click()

    // Dialog shows upload summary - dismiss it
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 })
    await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click()
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 10_000 })

    // Go to WingDex, Chukar should still be there (converged, not duplicated)
    await page.getByRole('tab', { name: 'WingDex' }).first().click()
    await expect(page.locator('p:visible', { hasText: 'species observed' }).first()).toBeVisible({ timeout: 5_000 })
    await page.getByPlaceholder('Search species...').fill('chukar')

    // Count the Chukar entries, should be exactly 1 (not 2 separate entries)
    const chukarEntries = page.locator('p:visible', { hasText: /^Chukar/ })
    await expect(chukarEntries).toHaveCount(1)

    // Click into Chukar detail to verify the sighting count increased
    await chukarEntries.first().click()
    await expect(page.getByRole('heading', { name: 'Chukar' })).toBeVisible({ timeout: 5_000 })

    // Should show 2 outings for this species (one from CSV, one from photo upload)
    await expect(page.getByText(/2.*outing/i)).toBeVisible({ timeout: 5_000 })
  })

  // @live: needs two photos to identify as DIFFERENT named species to prove the
  // outings split. The clustering logic it targets is geographic, and is covered
  // by unit tests; only the species labels here required the old per-call mock.
  test('@live multi-photo clustering: photos from different locations create separate outings', async ({ page }) => {
    test.slow()
    await mockGeocoding(page, 'Discovery Park, Seattle')
    await mockWikimedia(page)

    await loadApp(page)

    // Open upload wizard
    await page.getByRole('button', { name: 'Upload & Identify' }).click()
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 })

    // Upload two photos from very different locations:
    // Chukar from Haleakala, Hawaii (lat 20.7, lon -156.1)
    // Steller's Jay from Seattle, WA (lat 47.6, lon -122.4)
    // These should cluster into 2 separate outings (>6km apart)
    const fileInput = page.getByRole('dialog').locator('input[type="file"]')
    await fileInput.setInputFiles([
      path.resolve('src/assets/images/Chukar_partridge_near_Haleakala_summit_Maui.jpg'),
      path.resolve('src/assets/images/Stellers_Jay_eating_cherries_Seattle_backyard.jpg'),
    ])

    // Should reach Review Outing step for the first cluster
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Review Outing')).toBeVisible({ timeout: 10_000 })

    // The wizard should indicate multiple clusters (e.g., "Review Outing 1 of 2")
    await expect(dialog.getByRole('heading', { name: /Review Outing 1 of 2/i })).toBeVisible({ timeout: 5_000 })

    // Confirm first outing → identify species → confirm
    await dialog.getByRole('button', { name: /Continue to Species/i }).click()

    // First identification triggers the 61.66 MiB download gate.
    await passModelGate(page)
    await expect(dialog.getByText(/Chukar|Jay/)).toBeVisible({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Confirm' }).first().click()

    // Should advance to second cluster's Review Outing step
    await expect(dialog.getByText('Review Outing')).toBeVisible({ timeout: 10_000 })
    await expect(dialog.getByRole('heading', { name: /Review Outing 2 of 2/i })).toBeVisible({ timeout: 5_000 })

    // Confirm second outing
    await dialog.getByRole('button', { name: /Continue to Species/i }).click()

    // First identification triggers the 61.66 MiB download gate.
    await passModelGate(page)
    await expect(dialog.getByText(/Chukar|Jay/)).toBeVisible({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Confirm' }).first().click()

    // Dialog shows upload summary - dismiss it
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Done' }).click()
    await expect(dialog).not.toBeVisible({ timeout: 10_000 })
  })
})
