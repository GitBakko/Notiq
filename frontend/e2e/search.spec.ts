import { test, expect } from '@playwright/test';
import { v4 as uuidv4 } from 'uuid';

test.describe('Search', () => {
  test.beforeEach(async ({ page }) => {
    const email = `search-${uuidv4()}@example.com`;
    const password = 'password123';

    await page.goto('/register');
    await page.fill('input[type="text"]', 'Search User');
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/notes/, { timeout: 10000 });
  });

  test('should open and use search', async ({ page }) => {
    // Wait for sidebar
    // Wait for sidebar
    await expect(page.getByTestId('sidebar-item-notes')).toBeVisible({ timeout: 30000 });

    // Click the search button in sidebar
    await page.getByRole('button', { name: 'Search' }).click();

    // Verify search modal opens (command menu)
    const searchInput = page.getByPlaceholder('Search notes, notebooks, tags...');
    await expect(searchInput).toBeVisible({ timeout: 5000 });

    // Type in the search box to verify it's functional
    await searchInput.fill('test query');

    // Verify the input accepted the text
    await expect(searchInput).toHaveValue('test query');
  });
});
