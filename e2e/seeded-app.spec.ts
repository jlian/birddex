import { test, expect } from '@playwright/test'
import { seedViaCSVImport } from './helpers'

test.describe('App with seeded data', () => {
  test('home page shows correct stat cards', async ({ page }) => {
    await seedViaCSVImport(page)

    // Hero count should reflect seeded data (count and text are separate <p> tags on home page)
    await expect(page.locator('p:visible', { hasText: 'species observed' }).first()).toBeVisible({ timeout: 5_000 })
  })

  test('home page shows recent species section', async ({ page }) => {
    await seedViaCSVImport(page)

    await expect(page.getByText('Recent Species')).toBeVisible({ timeout: 5_000 })
    // Recent species carousel should render at least one clickable species card
    await expect(page.locator('section').filter({ hasText: 'Recent Species' }).locator('button').first()).toBeVisible()
  })

  test('outings page lists seeded outings', async ({ page }) => {
    await seedViaCSVImport(page)

    await page.getByRole('tab', { name: 'Outings' }).first().click()
    await expect(page.getByText('Your Outings')).toBeVisible({ timeout: 5_000 })

    // Should show location names from the CSV fixture
    await expect(page.locator('p:visible', { hasText: 'Discovery Park' }).first()).toBeVisible()
    await expect(page.locator('p:visible', { hasText: 'Hyde Park, London' }).first()).toBeVisible()
  })

  test('clicking an outing opens its detail view', async ({ page }) => {
    await seedViaCSVImport(page)

    await page.getByRole('tab', { name: 'Outings' }).first().click()
    await expect(page.getByText('Your Outings')).toBeVisible({ timeout: 5_000 })

    // Click a known outing from the CSV fixture
    await page.locator('p:visible', { hasText: 'Discovery Park' }).first().click()

    // Detail view should show a heading with the location name
    await expect(page.getByRole('heading', { name: 'Discovery Park' })).toBeVisible({ timeout: 5_000 })
    // Should show species from that outing
    await expect(page.locator('p:visible', { hasText: 'Northern Cardinal' }).first()).toBeVisible()
  })

  test('outing detail export button downloads eBird CSV', async ({ page }) => {
    await seedViaCSVImport(page)

    await page.getByRole('tab', { name: 'Outings' }).first().click()
    await expect(page.getByText('Your Outings')).toBeVisible({ timeout: 5_000 })

    await page.locator('p:visible', { hasText: 'Discovery Park' }).first().click()
    await expect(page.getByRole('heading', { name: 'Discovery Park' })).toBeVisible()

    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export eBird CSV' }).click()
    const download = await downloadPromise

    expect(download.suggestedFilename()).toContain('wingdex-outing-')
    expect(download.suggestedFilename()).toContain('.csv')
  })

  test('wingdex page lists species with count', async ({ page }) => {
    await seedViaCSVImport(page)

    await page.getByRole('tab', { name: 'WingDex' }).first().click()
    await expect(page.locator('p:visible', { hasText: 'species observed' }).first()).toBeVisible({ timeout: 5_000 })
    const wingdexSearch = page.getByPlaceholder('Search species...')

    // Known CSV fixture species should appear in the list
    await wingdexSearch.fill('bald eagle')
    await expect(page.locator('p:visible', { hasText: 'Bald Eagle' }).first()).toBeVisible()
    await wingdexSearch.fill('great blue heron')
    await expect(page.locator('p:visible', { hasText: 'Great Blue Heron' }).first()).toBeVisible()
  })

  test('wingdex search filters species', async ({ page }) => {
    await seedViaCSVImport(page)

    await page.getByRole('tab', { name: 'WingDex' }).first().click()
    await expect(page.locator('p:visible', { hasText: 'species observed' }).first()).toBeVisible({ timeout: 5_000 })

    // Search for "eagle"
    await page.getByPlaceholder('Search species...').fill('eagle')

    // Should show Bald Eagle but not unrelated species
    await expect(page.locator('p:visible', { hasText: 'Bald Eagle' }).first()).toBeVisible()
    await expect(page.locator('p:visible', { hasText: 'Blue Jay' })).toHaveCount(0)
  })

  test('clicking a species opens its detail view', async ({ page }) => {
    await seedViaCSVImport(page)

    await page.getByRole('tab', { name: 'WingDex' }).first().click()
    await expect(page.locator('p:visible', { hasText: 'species observed' }).first()).toBeVisible({ timeout: 5_000 })
    await page.getByPlaceholder('Search species...').fill('bald eagle')

    await page.locator('p:visible', { hasText: 'Bald Eagle' }).first().click()

    // Detail view should show species info
    await expect(page.getByRole('heading', { name: 'Bald Eagle' })).toBeVisible({ timeout: 5_000 })
    // Should show a back button
    await expect(page.getByRole('button', { name: /back/i })).toBeVisible()
  })

  test('species detail view loads Wikipedia image', async ({ page }) => {
    const portraitImageURL = 'https://upload.wikimedia.org/wingdex-test/portrait.svg'
    let mockedSandhillImageRequests = 0
    await page.route('**/api/rest_v1/page/summary/**', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        title: 'Sandhill crane',
        extract: 'A stable test summary.',
        originalimage: { source: portraitImageURL },
        content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Sandhill_crane' } },
      }),
    }))
    await page.route(portraitImageURL, route => route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="600"><rect width="300" height="600" fill="#547a52"/></svg>',
    }))
    await page.route('**/Sandhill_Crane_JG.jpg/**', route => {
      mockedSandhillImageRequests += 1
      return route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="600"><rect width="300" height="600" fill="#547a52"/></svg>',
      })
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await seedViaCSVImport(page)

    await page.getByRole('tab', { name: 'WingDex' }).first().click()
    await expect(page.locator('p:visible', { hasText: 'species observed' }).first()).toBeVisible({ timeout: 5_000 })
    await page.getByPlaceholder('Search species...').fill('sandhill crane')

    await page.locator('p:visible', { hasText: 'Sandhill Crane' }).first().click()

    await expect(page.getByRole('heading', { name: 'Sandhill Crane' })).toBeVisible({ timeout: 5_000 })

    // Wikipedia image should load in the detail hero area
    const heroImg = page.getByRole('img', { name: 'Sandhill Crane' })
    await expect(heroImg).toBeVisible({ timeout: 10_000 })
    // Verify it loaded a real image (not a placeholder)
    const src = await heroImg.getAttribute('src')
    expect(src).toBeTruthy()
    expect(src).toContain('wikimedia')
    await expect.poll(
      () => heroImg.evaluate(image => image.naturalWidth),
      { timeout: 10_000 },
    ).toBeGreaterThan(0)

    const mobileHeroGeometry = await heroImg.evaluate(image => {
      const container = image.parentElement
      if (!container) throw new Error('Species hero has no container')
      const bounds = container.getBoundingClientRect()
      return {
        width: bounds.width,
        height: bounds.height,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        objectPosition: getComputedStyle(image).objectPosition,
      }
    })
    expect(mobileHeroGeometry.naturalHeight).toBeGreaterThan(mobileHeroGeometry.naturalWidth)
    expect(mockedSandhillImageRequests).toBeGreaterThan(0)
    expect(Math.abs(mobileHeroGeometry.width - mobileHeroGeometry.height)).toBeLessThanOrEqual(2)
    expect(mobileHeroGeometry.objectPosition).toBe('50% 50%')

    await page.setViewportSize({ width: 900, height: 900 })
    const wideHeroGeometry = await heroImg.evaluate(image => {
      const container = image.parentElement
      if (!container) throw new Error('Species hero has no container')
      const bounds = container.getBoundingClientRect()
      return {
        width: bounds.width,
        height: bounds.height,
        objectPosition: getComputedStyle(image).objectPosition,
      }
    })
    expect(wideHeroGeometry.width / wideHeroGeometry.height).toBeCloseTo(4 / 3, 2)
    expect(wideHeroGeometry.objectPosition).toBe('50% 50%')
  })
})
