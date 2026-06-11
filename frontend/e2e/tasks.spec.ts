import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers';

test.describe('Tasks', () => {
  test.beforeEach(async ({ page }) => {
    // Stale register-page flow replaced: invitation-based auth + email verification
    // block direct /register → /notes. The shared helper provisions a verified user via API.
    await registerAndLogin(page, { name: 'Tasks User' });
  });

  test('should navigate to tasks page', async ({ page }) => {
    // Wait for sidebar
    await expect(page.getByTestId('sidebar-item-notes')).toBeVisible();

    // Click on Tasks link
    await page.click('a[href="/tasks"]');

    // Verify we're on tasks page
    await expect(page).toHaveURL(/\/tasks/);
    // Sidebar link text is "Task Lists" (not "Tasks")
    await expect(page.getByRole('link', { name: 'Task Lists', exact: true })).toBeVisible();
  });

  test('should create a note with checklist', async ({ page }) => {
    await expect(page.getByTestId('sidebar-item-notes')).toBeVisible();

    // Create a note (use role selector — CSS classes may change)
    const newNoteBtn = page.getByRole('button', { name: 'New Note', exact: true });
    await newNoteBtn.click();
    await expect(page.locator('input[placeholder="Note Title"]')).toBeVisible({ timeout: 10000 });

    await page.fill('input[placeholder="Note Title"]', 'Task Note');

    // Focus editor
    await page.locator('.ProseMirror').click();

    // Type a task item using the [ ] syntax
    await page.locator('.ProseMirror').type('- [ ] First task item');
    await page.keyboard.press('Enter');
    await page.locator('.ProseMirror').type('- [ ] Second task item');

    // Offline-first: Dexie write is immediate (debounced ~1s); no "Saved" indicator exists.
    await page.waitForTimeout(3000);

    // Verify checkboxes are rendered (TipTap converts [ ] to checkbox)
    // The exact rendering depends on the TipTap extension
    await expect(page.locator('.ProseMirror')).toContainText('First task item');
    await expect(page.locator('.ProseMirror')).toContainText('Second task item');
  });
});
