import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers';

test.describe('User Profile', () => {
  test.beforeEach(async ({ page }) => {
    // Stale register-page flow replaced: invitation-based auth + email verification
    // block direct /register → /notes. The shared helper provisions a verified user via API.
    await registerAndLogin(page, { name: 'Profile User' });
  });

  test('should navigate to profile page', async ({ page }) => {
    // Wait for sidebar
    await expect(page.getByTestId('sidebar-item-notes')).toBeVisible();

    // Click on the user profile link in sidebar
    await page.click('a[href="/profile"]');

    // Verify we're on profile page
    await expect(page).toHaveURL(/\/profile/);
    // Verify page content instead of generic text
    await expect(page.locator('h1, h2, h3').filter({ hasText: /Profile|Settings|Account/i })).toBeVisible();
  });

  test('should show user name in sidebar', async ({ page }) => {
    await expect(page.getByTestId('sidebar-item-notes')).toBeVisible();

    // Verify user name is shown
    await expect(page.getByText('Profile User')).toBeVisible();
  });
});

test.describe('Trash', () => {
  test.beforeEach(async ({ page }) => {
    // Stale register-page flow replaced: invitation-based auth + email verification
    // block direct /register → /notes. The shared helper provisions a verified user via API.
    await registerAndLogin(page, { name: 'Trash User' });
  });

  test('should navigate to trash page', async ({ page }) => {
    await expect(page.getByTestId('sidebar-item-notes')).toBeVisible();

    // Click on Trash link
    await page.click('a[href="/trash"]');

    // Verify we're on trash page
    await expect(page).toHaveURL(/\/trash/);
    // Use exact selector to avoid matching username
    await expect(page.getByRole('link', { name: 'Trash', exact: true })).toBeVisible();
  });

  test('should show empty trash message', async ({ page }) => {
    await expect(page.getByTestId('sidebar-item-notes')).toBeVisible();

    await page.click('a[href="/trash"]');

    // Should show empty state
    await expect(page.getByText(/empty|no.*deleted|no.*trash/i)).toBeVisible({ timeout: 5000 });
  });
});
