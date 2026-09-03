import { chromium } from '@playwright/test'
import { testBaseURL } from './test-server'

export default async function globalSetup() {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.goto(testBaseURL, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })
    await page.locator('header').waitFor({ state: 'visible', timeout: 20_000 })
  } finally {
    await browser.close()
  }
}
