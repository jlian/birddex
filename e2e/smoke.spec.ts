import { test, expect } from '@playwright/test';
import path from 'path';
import { readFileSync } from 'fs';
import { loadApp } from './helpers';

test.describe('App smoke tests', () => {
  test('loads without crashing and shows header', async ({ page }) => {
    await loadApp(page, { promote: false });

    // Header should have the WingDex tab in nav
    const header = page.locator('header');
    await expect(header.getByText('WingDex')).toBeVisible();
  });

  test('serves the gzipped occurrence prior as raw gzip bytes', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(async () => {
      const response = await fetch('/priors/occurrence.d0abc168.bin.gz', {
        headers: { Range: 'bytes=0-1' },
      });
      const bytes = Array.from(new Uint8Array(await response.arrayBuffer()).slice(0, 2));
      return {
        status: response.status,
        contentEncoding: response.headers.get('content-encoding'),
        bytes,
      };
    });

    expect([200, 206]).toContain(result.status);
    expect(result.contentEncoding).toBeNull();
    expect(result.bytes).toEqual([0x1f, 0x8b]);
  });

  test('renders top nav tabs', async ({ page }) => {
    await loadApp(page, { promote: false });

    // On desktop (default viewport), nav tabs are in the header
    const header = page.locator('header');
    await expect(header.getByText('Outings')).toBeVisible();
    await expect(header.getByText('WingDex')).toBeVisible();
  });

  test('can navigate between tabs', async ({ page }) => {
    await loadApp(page);

    // Click Outings tab
    await page.getByRole('tab', { name: 'Outings' }).first().click();
    await expect(
      page.getByText('Your Outings').or(page.getByText('No outings yet'))
    ).toBeVisible({ timeout: 5_000 });

    // Click WingDex tab
    await page.getByRole('tab', { name: 'WingDex' }).first().click();
    await expect(
      page.getByText('Your WingDex is empty').or(page.getByRole('heading', { name: 'WingDex' }))
    ).toBeVisible({ timeout: 5_000 });

    // Open Settings via avatar button
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 5_000 });

    // Navigate back to Home via logo button
    await page.getByRole('button', { name: 'Home' }).click();
    await expect(page.getByRole('button', { name: 'Upload & Identify' })).toBeVisible({ timeout: 5_000 });
  });

  test('anonymous visitor can browse, and is kept out of Settings', async ({ page }) => {
    await loadApp(page, { promote: false });

    await page.getByRole('tab', { name: 'Outings' }).first().click();
    await expect(
      page.getByText('Your Outings').or(page.getByText('No outings yet'))
    ).toBeVisible({ timeout: 5_000 });

    await page.getByRole('tab', { name: 'WingDex' }).first().click();
    await expect(
      page.getByText('Your WingDex is empty').or(page.getByRole('heading', { name: 'WingDex' }))
    ).toBeVisible({ timeout: 5_000 });

    // The avatar offers sign-in rather than Settings, and the route itself is
    // closed: keeping and moving data is what an account is for.
    await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Settings' })).toBeHidden();

    await page.goto('/#settings');
    await expect(page.getByRole('button', { name: 'Upload & Identify' })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeHidden();

    // Import stays closed at the API too, not just in the UI.
    const importStatus = await page.evaluate(async () => {
      const form = new FormData();
      form.append('file', new Blob(['Submission ID,Common Name\n'], { type: 'text/csv' }), 'x.csv');
      const res = await fetch('/api/import/ebird-csv', { method: 'POST', credentials: 'include', body: form });
      return res.status;
    });
    expect([401, 403]).toContain(importStatus);
  });

  test('footer exposes crawlable legal links and they navigate correctly', async ({ page }) => {
    await loadApp(page, { promote: false });

    const footer = page.locator('footer');
    const privacyLink = footer.getByRole('link', { name: 'Privacy', exact: true });
    const termsLink = footer.getByRole('link', { name: 'Terms', exact: true });

    await expect(privacyLink).toHaveAttribute('href', '/#privacy');
    await expect(termsLink).toHaveAttribute('href', '/#terms');

    await privacyLink.click();
    await expect(page.getByRole('heading', { name: 'Privacy Policy' })).toBeVisible({ timeout: 5_000 });

    await termsLink.click();
    await expect(page.getByRole('heading', { name: 'Terms of Use' })).toBeVisible({ timeout: 5_000 });

    await page.getByRole('link', { name: 'Privacy Policy' }).click();
    await expect(page.getByRole('heading', { name: 'Privacy Policy' })).toBeVisible({ timeout: 5_000 });
  });

  test('settings page renders without errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    await loadApp(page);

    // Navigate to Settings via avatar button
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 5_000 });

    // Settings page should show expected sections
    await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Import & Export' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Account Management' })).toBeVisible();

    // Filter out known non-critical errors
    const criticalErrors = errors.filter(
      e => !e.includes('403') && !e.includes('net::ERR') && !e.includes('favicon')
    );

    expect(criticalErrors).toEqual([]);
  });

  test('add photos button opens flow on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await loadApp(page, { promote: false });

    // The home page Upload & Identify button should be visible
    const addBtn = page.getByRole('button', { name: 'Upload & Identify' });
    await expect(addBtn).toBeVisible();

    // Click it to open the add photos dialog
    await addBtn.click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
  });

  test('add photos dialog can be closed', async ({ page }) => {
    await loadApp(page, { promote: false });

    // Open dialog via Upload & Identify button
    await page.getByRole('button', { name: 'Upload & Identify' }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });

    // Close via the X button
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 5_000 });
  });

  test('no console errors on initial load', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    await loadApp(page, { promote: false });

    // Filter out known non-critical errors (network/favicon/transient)
    const criticalErrors = errors.filter(
      e => !e.includes('403') && !e.includes('net::ERR') && !e.includes('favicon')
    );

    expect(criticalErrors).toEqual([]);
  });

  test('no elements overflow the viewport on mobile', async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 812 });
    await loadApp(page, { promote: false });

    // Check no horizontal scrollbar
    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    const viewportWidth = await page.evaluate(() => window.innerWidth);
    expect(bodyWidth).toBeLessThanOrEqual(viewportWidth);
  });

  test('upload flow processes photos and reaches review outing step', async ({ page }) => {
    await loadApp(page, { promote: false });

    // Open the wizard
    await page.getByRole('button', { name: 'Upload & Identify' }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });

    // Should start on the upload step with "Select Photos" button
    await expect(page.getByRole('button', { name: 'Select Photos' })).toBeVisible();

    // Upload a test image
    const fileInput = page.getByRole('dialog').locator('input[type="file"]');
    await fileInput.setInputFiles(path.resolve('src/assets/images/Common_kingfisher_at_Taipei_Zoo.jpeg'));

    // Should show the extracting step with progress
    await expect(
      page.getByText('Reading Photos...').or(page.getByText('Review Outing'))
    ).toBeVisible({ timeout: 5_000 });

    // Should eventually reach the review outing step
    await expect(page.getByText('Review Outing')).toBeVisible({ timeout: 10_000 });

    // Review step should show outing details and a continue button
    await expect(
      page.getByRole('button', { name: /continue to species/i })
    ).toBeVisible({ timeout: 5_000 });
  });

  test('upload flow accepts drag-and-drop on Select Photos', async ({ page }) => {
    await loadApp(page, { promote: false });

    await page.getByRole('button', { name: 'Upload & Identify' }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });

    const imagePath = path.resolve('src/assets/images/Common_kingfisher_at_Taipei_Zoo.jpeg');
    const imageBytesBase64 = readFileSync(imagePath).toString('base64');
    const dataTransfer = await page.evaluateHandle(({ bytesBase64, fileName }) => {
      const binary = atob(bytesBase64);
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      const file = new File([bytes], fileName, { type: 'image/jpeg' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      return transfer;
    }, {
      bytesBase64: imageBytesBase64,
      fileName: path.basename(imagePath),
    });

    await page.getByRole('button', { name: 'Select Photos' }).dispatchEvent('drop', { dataTransfer });

    await expect(
      page.getByText('Reading Photos...').or(page.getByText('Review Outing'))
    ).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('Review Outing')).toBeVisible({ timeout: 10_000 });
  });

  test('upload flow handles multiple photos', async ({ page }) => {
    await loadApp(page, { promote: false });

    await page.getByRole('button', { name: 'Upload & Identify' }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });

    // Upload multiple test images
    const fileInput = page.getByRole('dialog').locator('input[type="file"]');
    await fileInput.setInputFiles([
      path.resolve('src/assets/images/Common_kingfisher_at_Taipei_Zoo.jpeg'),
      path.resolve('src/assets/images/Stellers_Jay_eating_cherries_Seattle_backyard.jpg'),
    ]);

    // Should reach the review outing step
    await expect(page.getByText('Review Outing')).toBeVisible({ timeout: 10_000 });

    // Should show the photo count somewhere in the review
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('closing upload wizard mid-flow shows confirmation dialog', async ({ page }) => {
    await loadApp(page, { promote: false });

    // Open add photos dialog
    await page.getByRole('button', { name: 'Upload & Identify' }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });

    // Upload a file to move past the initial 'upload' step
    const fileInput = page.getByRole('dialog').locator('input[type="file"]');
    await fileInput.setInputFiles(path.resolve('src/assets/images/Common_kingfisher_at_Taipei_Zoo.jpeg'));

    // Wait for the wizard to advance past the upload step
    await expect(
      page.getByText('Reading Photos...').or(page.getByText('Review Outing'))
    ).toBeVisible({ timeout: 5_000 });

    // Try to close via the X button, should show confirmation
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();

    // Confirmation alert dialog should appear
    await expect(page.getByText('Discard progress?')).toBeVisible({ timeout: 5_000 });

    // Click "Continue uploading" to dismiss confirmation
    await page.getByRole('button', { name: 'Continue uploading' }).click();
    await expect(page.getByText('Discard progress?')).not.toBeVisible();

    // The wizard should still be open
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('confirmation dialog discards wizard when clicking Discard', async ({ page }) => {
    await loadApp(page, { promote: false });

    // Open and advance the wizard
    await page.getByRole('button', { name: 'Upload & Identify' }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });

    const fileInput = page.getByRole('dialog').locator('input[type="file"]');
    await fileInput.setInputFiles(path.resolve('src/assets/images/Common_kingfisher_at_Taipei_Zoo.jpeg'));

    await expect(
      page.getByText('Reading Photos...').or(page.getByText('Review Outing'))
    ).toBeVisible({ timeout: 5_000 });

    // Try to close
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
    await expect(page.getByText('Discard progress?')).toBeVisible({ timeout: 5_000 });

    // Click "Discard" to close the wizard
    await page.getByRole('button', { name: 'Discard' }).click();

    // Both the confirmation and the wizard should be gone
    await expect(page.getByText('Discard progress?')).not.toBeVisible();
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 5_000 });
  });
});
