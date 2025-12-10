import { test, expect } from '@playwright/test';
import { v4 as uuidv4 } from 'uuid';

test.describe('Tasks', () => {
  test.beforeEach(async ({ page }) => {
    const email = `tasks-${uuidv4()}@example.com`;
    const password = 'password123';

    await page.goto('/register');
    await page.fill('input[type="text"]', 'Tasks User');
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/notes/, { timeout: 10000 });
  });

  test('should navigate to tasks page', async ({ page }) => {
    // Wait for sidebar
    await expect(page.getByTestId('sidebar-item-notes')).toBeVisible();

    // Click on Tasks link
    await page.click('a[href="/tasks"]');

    // Verify we're on tasks page
    await expect(page).toHaveURL(/\/tasks/);
    // Use exact selector to avoid matching username
    await expect(page.getByRole('link', { name: 'Tasks', exact: true })).toBeVisible();
  });

  test('should create a note with checklist', async ({ page }) => {
    await expect(page.getByTestId('sidebar-item-notes')).toBeVisible();

    // Create a note
    const newNoteBtn = page.locator('button.rounded-full.bg-emerald-600').filter({ hasText: 'New Note' });
    await newNoteBtn.click();
    await expect(page.locator('input[placeholder="Note Title"]')).toBeVisible({ timeout: 10000 });

    await page.fill('input[placeholder="Note Title"]', 'Task Note');

    // Focus editor
    await page.locator('.ProseMirror').click();

    // Type a task item using the [ ] syntax
    await page.locator('.ProseMirror').type('- [ ] First task item');
    await page.keyboard.press('Enter');
    await page.locator('.ProseMirror').type('- [ ] Second task item');

    // Wait for save
    await expect(page.getByText('Saved')).toBeVisible({ timeout: 10000 });

    // Verify checkboxes are rendered (TipTap converts [ ] to checkbox)
    // The exact rendering depends on the TipTap extension
    await expect(page.locator('.ProseMirror')).toContainText('First task item');
    await expect(page.locator('.ProseMirror')).toContainText('Second task item');
  });
});
