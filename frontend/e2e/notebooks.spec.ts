import { test, expect } from '@playwright/test';
import { v4 as uuidv4 } from 'uuid';

test.describe('Notebooks', () => {
  test.beforeEach(async ({ page }) => {
    const email = `notebooks-${uuidv4()}@example.com`;
    const password = 'password123';

    await page.goto('/register');
    await page.fill('input[type="text"]', 'Notebook User');
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/notes/, { timeout: 10000 });
  });

  test('should create a new notebook', async ({ page }) => {
    console.log('Waiting for sidebar...');
    // Wait for sidebar
    await expect(page.getByTestId('sidebar-item-notes')).toBeVisible();

    console.log('Hovering Notebooks group...');
    // Hover over Notebooks section to show create button
    // The "Notebooks" text is in a button, the parent div has 'group' class
    // We hover the container to be safe
    const notebooksGroup = page.locator('.group').filter({ hasText: 'Notebooks' }).first();
    await notebooksGroup.hover();

    console.log('Clicking Create Notebook button...');
    // Click Create Notebook button (title="Create Notebook")
    // Force click because sometimes the tooltip or rapid modal opening interferes
    const createBtn = page.getByTitle('Create Notebook');
    await expect(createBtn).toBeVisible({ timeout: 5000 });
    await createBtn.click({ force: true });

    console.log('Filling dialog...');
    // Fill dialog
    // Placeholder is "Notebook name" (lowercase n)
    const nameInput = page.locator('input[placeholder="Notebook name"]');
    await expect(nameInput).toBeVisible({ timeout: 5000 });
    await nameInput.fill('My Notebook');

    // Click Create button inside the dialog
    // Use specific selector to avoid matching "Create New Note" in background
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();

    console.log('Verifying creation...');
    // Wait for the notebook to appear in the sidebar
    await expect(page.getByText('My Notebook')).toBeVisible({ timeout: 10000 });
  });
});
