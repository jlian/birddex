import { test, expect } from '@playwright/test'
import { seedViaCSVImport } from './helpers'

/**
 * The rarity mark, end to end, against the real shipped asset.
 *
 * The Discovery Park fixture is Seattle in January at 47.6587, -122.4050, which
 * makes it a genuine test rather than a smoke check: seven of its nine species
 * are ordinary there and must carry NO mark, while Blue Jay and Northern
 * Cardinal are eastern birds absent from the Pacific Northwest.
 *
 * Asserting the absences matters more than asserting the marks. A resolver that
 * marked everything, or one that silently failed and marked nothing, would each
 * pass half of this.
 *
 * Ground truth here is the same asset ml/distill/verify_rarity_blob.py checks
 * against known distributions.
 */
test.describe('rarity mark', () => {
  const MEGA = 'Off its usual range and out of season for this area'

  async function openDiscoveryPark(page: import('@playwright/test').Page) {
    await seedViaCSVImport(page)
    await page.getByRole('tab', { name: 'Outings' }).first().click()
    await expect(page.getByText('Your Outings')).toBeVisible({ timeout: 5_000 })
    await page.locator('p:visible', { hasText: 'Discovery Park' }).first().click()
    await expect(page.getByRole('heading', { name: 'Discovery Park' })).toBeVisible({ timeout: 5_000 })
  }

  test('marks a bird that does not occur here, and only that bird', async ({ page }) => {
    await openDiscoveryPark(page)

    // The asset is fetched lazily, so wait for the first mark before asserting
    // any absence. Otherwise every absence would pass simply by being early.
    const cardinal = page.locator('p:visible', { hasText: 'Northern Cardinal' }).first()
    await expect(cardinal.getByRole('img', { name: MEGA })).toBeVisible({ timeout: 15_000 })

    const blueJay = page.locator('p:visible', { hasText: 'Blue Jay' }).first()
    await expect(blueJay.getByRole('img', { name: MEGA })).toBeVisible()

    // Every remaining fixture species. Naming all seven is the point: a
    // resolver that marked everything would fail here, and one that silently
    // marked nothing would fail the two assertions above.
    const ordinary = [
      'Mallard', 'Song Sparrow', 'Great Blue Heron', 'Bald Eagle',
      'Black-capped Chickadee', "Steller's Jay", 'Dark-eyed Junco',
    ]
    for (const name of ordinary) {
      const row = page.locator('p:visible', { hasText: name }).first()
      await expect(row.getByRole('img')).toHaveCount(0)
    }
  })
})
