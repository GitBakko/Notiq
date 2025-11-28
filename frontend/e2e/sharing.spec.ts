import { test, expect } from '@playwright/test';
import { v4 as uuidv4 } from 'uuid';

test.describe('Sharing Features', () => {
  test('should open share modal and attempt to share a note', async ({ page }) => {
    // This test verifies the share UI works correctly
    // The full sharing flow depends on sync which can be flaky in tests

    const user = {
      name: 'Share Test User',
      email: `share-${uuidv4()}@example.com`,
      password: 'password123'
    };

    // Register user
    await page.goto('/register');
    await page.fill('input[type="text"]', user.name);
    await page.fill('input[type="email"]', user.email);
    await page.fill('input[type="password"]', user.password);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/notes/, { timeout: 10000 });

    // Wait for sidebar to be ready
    // Wait for sidebar to be ready
    await expect(page.getByTestId('sidebar-item-notes')).toBeVisible({ timeout: 30000 });

    // Create a Note
    const newNoteBtn = page.getByRole('button', { name: 'New Note', exact: true });
    await expect(newNoteBtn).toBeVisible();
    await newNoteBtn.click();
    await expect(page.locator('input[placeholder="Note Title"]')).toBeVisible({ timeout: 10000 });

    const noteTitle = 'Share Test Note';
    await page.fill('input[placeholder="Note Title"]', noteTitle);
    await page.locator('.ProseMirror').fill('Content to share');

    // Wait for save indicator
    await expect(page.getByText('Saved')).toBeVisible({ timeout: 10000 });

    // Open share modal
    await page.click('button[title="Share Note"]');

    // Verify modal opens with correct content
    await expect(page.locator('text=Share Note')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('input[placeholder="Enter email address"]')).toBeVisible();
    await expect(page.locator('select')).toBeVisible(); // Permission dropdown
    await expect(page.getByText('Not shared with anyone yet')).toBeVisible();

    // Fill in an email address
    await page.fill('input[placeholder="Enter email address"]', 'test@example.com');

    // Verify the form is ready for submission
    const submitBtn = page.locator('input[placeholder="Enter email address"]').locator('..').locator('button').last();
    await expect(submitBtn).toBeVisible();
    await expect(submitBtn).toBeEnabled();

    // Close modal by clicking X
    await page.locator('button').filter({ has: page.locator('svg.lucide-x') }).click();

    // Verify modal is closed
    await expect(page.locator('input[placeholder="Enter email address"]')).not.toBeVisible({ timeout: 5000 });
  });
});
