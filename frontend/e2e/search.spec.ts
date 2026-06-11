import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers';

test.describe('Search', () => {
  test.beforeEach(async ({ page }) => {
    // Stale register-page flow replaced: invitation-based auth + email verification
    // block direct /register → /notes. The shared helper provisions a verified user via API.
    await registerAndLogin(page, { name: 'Search User' });
  });

  test('should open and use search', async ({ page }) => {
    // Wait for sidebar
    await expect(page.getByTestId('sidebar-item-notes')).toBeVisible({ timeout: 30000 });

    // Click the search button in sidebar
    await page.getByRole('button', { name: 'Search' }).click();

    // Verify search modal opens (command menu)
    const searchInput = page.locator('input[cmdk-input]');
    await expect(searchInput).toBeVisible({ timeout: 5000 });

    // Type in the search box to verify it's functional
    await searchInput.fill('test query');

    // Verify the input accepted the text
    await expect(searchInput).toHaveValue('test query');
  });
});
