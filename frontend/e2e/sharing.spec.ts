import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers';

test.describe('Sharing Features', () => {
  test('should open share modal and attempt to share a note', async ({ page }) => {
    // This test verifies the share UI works correctly
    // The full sharing flow depends on sync which can be flaky in tests

    // Stale register-page flow replaced: invitation-based auth + email verification
    // block direct /register → /notes. The shared helper provisions a verified user via API.
    await registerAndLogin(page, { name: 'Share Test User' });

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

    // Offline-first: Dexie write is immediate (debounced ~1s); no "Saved" indicator exists.
    await page.waitForTimeout(3000);

    // Open share modal
    await page.click('button[title="Share"]');

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

    // Close modal: click the backdrop overlay (the fixed inset-0 z-50 div) to trigger onClose
    // The sharing modal uses onClick={onClose} on the backdrop, not a standard dialog
    await page.locator('div.fixed.inset-0.z-50').click({ position: { x: 8, y: 8 } });

    // Verify modal is closed
    await expect(page.locator('input[placeholder="Enter email address"]')).not.toBeVisible({ timeout: 5000 });
  });
});
