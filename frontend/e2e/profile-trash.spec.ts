import { test, expect } from '@playwright/test';
import { v4 as uuidv4 } from 'uuid';

test.describe('User Profile', () => {
  test.beforeEach(async ({ page }) => {
    const email = `profile-${uuidv4()}@example.com`;
    const password = 'password123';

    await page.goto('/register');
    await page.fill('input[type="text"]', 'Profile User');
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/notes/, { timeout: 10000 });
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
    const email = `trash-${uuidv4()}@example.com`;
    const password = 'password123';

    await page.goto('/register');
    await page.fill('input[type="text"]', 'Trash User');
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/notes/, { timeout: 10000 });
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
